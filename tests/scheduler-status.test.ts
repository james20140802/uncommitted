import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScheduleStatus } from "../src/schedule-status-command.js";
import { resolveLaunchAgentPlistPath, getLaunchdLabel } from "../src/scheduler.js";
import type { LaunchctlRawRunner } from "../src/scheduler.js";

/**
 * Tests for `uncommitted schedule status` (UNC-87).
 * File-system interactions use real tmp dirs; launchctl is injected via runner.
 */

function makeRunner(
  exitCode: number,
  stdout: string,
  stderr: string
): LaunchctlRawRunner {
  return async () => ({ exitCode, stdout, stderr });
}

describe("runScheduleStatus", () => {
  it("reports installed and loaded when plist exists and job appears in launchctl list", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-loaded-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    const label = getLaunchdLabel();
    // launchctl list output: PID\tStatus\tLabel (tab-separated, exact column match)
    const listOutput = `123\t0\t${label}\n`;
    const runner = makeRunner(0, listOutput, "");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(true);
    expect(result.loaded).toBe(true);
    expect(result.plistPath).toBe(plistPath);
    expect(result.launchctlError).toBeUndefined();
  });

  it("reports installed but not loaded when plist exists but label absent from launchctl list", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-notloaded-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    // launchctl list shows other jobs but not ours
    const listOutput = `456\t0\tcom.apple.something\n-\t0\tcom.other.job\n`;
    const runner = makeRunner(0, listOutput, "");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(true);
    expect(result.loaded).toBe(false);
    expect(result.plistPath).toBe(plistPath);
    expect(result.launchctlError).toBeUndefined();
  });

  it("reports not installed when plist does not exist", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-absent-"));
    const runner = makeRunner(0, "", "");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(false);
    expect(result.loaded).toBe(false);
    expect(result.plistPath).toBe(resolveLaunchAgentPlistPath({ homeDir }));
    expect(result.launchctlError).toBeUndefined();
  });

  it("reports installed with launchctlError when launchctl fails but plist exists", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-lcfail-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    // Simulate missing binary (ENOENT sentinel)
    const runner = makeRunner(-1, "", "__ENOENT__");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(true);
    expect(result.loaded).toBeUndefined(); // indeterminate
    expect(result.plistPath).toBe(plistPath);
    expect(result.launchctlError).toMatch(/launchctl not found/i);
  });

  it("does not substring-match label — a superset label name is not counted as loaded", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-subset-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    const label = getLaunchdLabel();
    // A job whose label starts with our label should NOT count as loaded
    const listOutput = `789\t0\t${label}.test\n`;
    const runner = makeRunner(0, listOutput, "");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(true);
    expect(result.loaded).toBe(false);
  });

  it("reports orphaned job as loaded when plist is absent but job appears in launchctl list", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-orphan-"));
    // No plist file created

    const label = getLaunchdLabel();
    const listOutput = `123\t0\t${label}\n`;
    const runner = makeRunner(0, listOutput, "");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(false);
    expect(result.loaded).toBe(true);
    expect(result.plistPath).toBe(resolveLaunchAgentPlistPath({ homeDir }));
    expect(result.launchctlError).toBeUndefined();
  });

  it("reports not installed with indeterminate loaded state when plist absent and launchctl fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-status-absent-lcfail-"));
    const runner = makeRunner(-1, "", "__ENOENT__");

    const result = await runScheduleStatus({ homeDir, runner });

    expect(result.installed).toBe(false);
    expect(result.loaded).toBeUndefined();
    expect(result.launchctlError).toMatch(/launchctl not found/i);
  });
});
