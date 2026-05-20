import { describe, expect, it } from "vitest";
import { runLaunchctl, type LaunchctlRawRunner } from "../src/scheduler.js";

/**
 * Tests for the structured launchctl runner (UNC-85).
 * All subprocess calls are injected via the runner parameter — no real
 * launchctl invocations.
 */

function makeRunner(
  exitCode: number,
  stdout: string,
  stderr: string
): LaunchctlRawRunner {
  return async () => ({ exitCode, stdout, stderr });
}

describe("runLaunchctl", () => {
  it("returns ok=true with stdout and stderr on success (exit code 0)", async () => {
    const runner = makeRunner(0, "PID\tStatus\tcom.uncommitted.schedule\n", "");

    const result = await runLaunchctl(["list", "com.uncommitted.schedule"], runner);

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("com.uncommitted.schedule");
    expect(result.stderr).toBe("");
  });

  it("returns ok=false with non-zero code on non-zero exit (does not throw)", async () => {
    const runner = makeRunner(1, "", "Could not find service");

    const result = await runLaunchctl(
      ["bootout", "gui/501", "/path/to/plist"],
      runner
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Could not find service");
  });

  it("returns ok=false with code=-1 and actionable error when launchctl binary is missing", async () => {
    // Simulate ENOENT sentinel from defaultLaunchctlRawRunner
    const runner = makeRunner(-1, "", "__ENOENT__");

    const result = await runLaunchctl(["list"], runner);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.stderr).toMatch(/launchctl not found/i);
  });

  it("captures both stdout and stderr on non-zero exit", async () => {
    const runner = makeRunner(3, "partial output", "error detail");

    const result = await runLaunchctl(
      ["bootstrap", "gui/501", "/path/to/plist"],
      runner
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toBe("error detail");
  });
});
