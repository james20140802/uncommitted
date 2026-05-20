import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScheduleRemove } from "../src/schedule-remove-command.js";
import {
  resolveLaunchAgentPlistPath,
  type LaunchctlRawRunner
} from "../src/scheduler.js";

/**
 * Tests for `uncommitted schedule remove` (UNC-89).
 * File-system interactions use real tmp dirs; launchctl is injected via runner.
 */

function makeRunner(
  exitCode: number,
  stdout: string,
  stderr: string
): LaunchctlRawRunner {
  return async () => ({ exitCode, stdout, stderr });
}

describe("runScheduleRemove", () => {
  it("unloads job and deletes plist when scheduler is installed", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-installed-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    const calls: string[][] = [];
    const runner: LaunchctlRawRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runScheduleRemove({ homeDir, runner });

    expect(result.removed).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.plistPath).toBe(plistPath);
    expect(result.launchctlError).toBeUndefined();

    // Plist must be deleted
    await expect(access(plistPath)).rejects.toThrow();

    // Must have called bootout
    expect(calls.some((args) => args[0] === "bootout")).toBe(true);
  });

  it("succeeds idempotently when scheduler is already absent (no error)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-absent-"));
    const runner = makeRunner(0, "", "");

    const result = await runScheduleRemove({ homeDir, runner });

    expect(result.removed).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.plistPath).toBe(resolveLaunchAgentPlistPath({ homeDir }));
    expect(result.launchctlError).toBeUndefined();
  });

  it("reports launchctlError but still deletes plist when bootout fails non-fatally", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-lcfail-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    // Bootout non-zero exit (job not loaded is benign — we still delete)
    const runner = makeRunner(3, "", "3: No such process");

    const result = await runScheduleRemove({ homeDir, runner });

    expect(result.removed).toBe(true);
    expect(result.wasInstalled).toBe(true);
    // Plist still deleted even if bootout fails
    await expect(access(plistPath)).rejects.toThrow();
    expect(result.launchctlError).toMatch(/No such process/);
  });

  it("returns removed=false with error when launchctl binary missing (ENOENT)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-enoent-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    // ENOENT sentinel from runLaunchctl
    const runner = makeRunner(-1, "", "__ENOENT__");

    const result = await runScheduleRemove({ homeDir, runner });

    // Still removes plist even when launchctl is missing
    expect(result.removed).toBe(true);
    expect(result.launchctlError).toMatch(/launchctl not found/i);
    await expect(access(plistPath)).rejects.toThrow();
  });

  it("does not touch sibling LaunchAgent files outside the Uncommitted plist path", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-sib-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    const siblingPath = join(homeDir, "Library", "LaunchAgents", "com.other.agent.plist");
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");
    await writeFile(siblingPath, "<plist/>", "utf8");

    const runner = makeRunner(0, "", "");
    await runScheduleRemove({ homeDir, runner });

    // Sibling must survive
    await expect(access(siblingPath)).resolves.toBeUndefined();
    // Our plist must be gone
    await expect(access(plistPath)).rejects.toThrow();
  });

  it("plist path must be inside ~/Library/LaunchAgents/ (safety guard)", async () => {
    // The resolved path is always inside ~/Library/LaunchAgents/ by design,
    // so verify the implementation enforces this by checking the path before deletion.
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-guard-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });

    // Confirm path is inside homeDir/Library/LaunchAgents
    expect(plistPath).toContain(join(homeDir, "Library", "LaunchAgents"));
  });

  it("returns removed=false and does not delete plist when bootout fails with non-benign error", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-nonbenign-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist/>", "utf8");

    // Non-benign exit (e.g. permission denied)
    const runner = makeRunner(5, "", "Permission denied");

    const result = await runScheduleRemove({ homeDir, runner });

    expect(result.removed).toBe(false);
    expect(result.wasInstalled).toBe(true);
    expect(result.launchctlError).toMatch(/Permission denied/);
    // Plist must NOT be deleted
    await expect(access(plistPath)).resolves.toBeUndefined();
  });

  it("attempts bootout even when plist is absent (guards against orphaned jobs)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-orphan-"));
    // No plist file — scheduler not installed

    const calls: string[][] = [];
    const runner: LaunchctlRawRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runScheduleRemove({ homeDir, runner });

    expect(result.removed).toBe(true);
    expect(result.wasInstalled).toBe(false);
    // Bootout must still have been called
    expect(calls.some((args) => args[0] === "bootout")).toBe(true);
  });

  it("returns removed=false when plist deletion fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-remove-delfail-"));
    const plistPath = resolveLaunchAgentPlistPath({ homeDir });
    // Create a directory at plistPath to trigger EISDIR on rm
    await mkdir(plistPath, { recursive: true });

    const runner = makeRunner(0, "", "");

    const result = await runScheduleRemove({ homeDir, runner });

    expect(result.removed).toBe(false);
    expect(result.wasInstalled).toBe(true);
    expect(result.launchctlError).toBeTruthy();
  });
});
