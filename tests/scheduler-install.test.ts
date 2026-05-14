import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLaunchAgentPlist, installScheduler } from "../src/scheduler.js";

describe("scheduler install", () => {
  it("writes the plist file and calls bootstrap on macOS", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      getuid: () => 501
    });

    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-install-test-"));
    const calls: string[][] = [];
    const executor = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30"
    });

    await installScheduler(plist, { homeDir, executor });

    const writtenContent = await readFile(plist.plistPath, "utf8");
    expect(writtenContent).toBe(plist.xml);

    // Should bootout (ignoring failure) then bootstrap
    expect(calls).toEqual([
      ["bootout", "gui/501", plist.plistPath],
      ["bootstrap", "gui/501", plist.plistPath]
    ]);

    vi.unstubAllGlobals();
  });

  it("overwrites existing plist during reinstall", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      getuid: () => 501
    });

    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-install-overwrite-"));
    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30"
    });

    // Create existing file
    await mkdir(dirname(plist.plistPath), { recursive: true });
    await writeFile(plist.plistPath, "existing content", "utf8");

    await installScheduler(plist, {
      homeDir,
      executor: async () => ({ stdout: "", stderr: "" })
    });

    const writtenContent = await readFile(plist.plistPath, "utf8");
    expect(writtenContent).toBe(plist.xml);

    vi.unstubAllGlobals();
  });

  it("creates the log directory if it does not exist", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      getuid: () => 501
    });

    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-install-logs-"));
    const logsDir = join(homeDir, ".uncommitted", "logs");

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30"
    });

    await installScheduler(plist, {
      homeDir,
      executor: async () => ({ stdout: "", stderr: "" })
    });

    // Verify logs directory exists
    const { access } = await import("node:fs/promises");
    await expect(access(logsDir)).resolves.not.toThrow();

    vi.unstubAllGlobals();
  });

  it("fails when launchctl bootstrap fails", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      getuid: () => 501
    });

    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-install-fail-"));
    const executor = async (args: string[]) => {
      if (args[0] === "bootstrap") {
        throw new Error("bootstrap failed");
      }
      return { stdout: "", stderr: "" };
    };

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30"
    });

    await expect(installScheduler(plist, { homeDir, executor })).rejects.toThrow(
      "bootstrap failed"
    );

    vi.unstubAllGlobals();
  });

  it("fails early with a clear error on non-macOS platforms", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "linux"
    });

    const plist = buildLaunchAgentPlist({
      scheduleTime: "23:30"
    });

    await expect(installScheduler(plist)).rejects.toThrow(
      "macOS is required to install the scheduler."
    );

    vi.unstubAllGlobals();
  });
});
