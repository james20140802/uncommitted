import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLaunchAgentPlist, installScheduler } from "../src/scheduler.js";

describe("scheduler install", () => {
  it("writes the plist file and calls bootstrap", async () => {
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
      ["bootout", `gui/${process.getuid?.() ?? 501}`, plist.plistPath],
      ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plist.plistPath]
    ]);
  });
});
