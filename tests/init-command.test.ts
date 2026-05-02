import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInitCommand } from "../src/init-command.js";

describe("init command", () => {
  it("creates global config files and directories", async () => {
    const homeDir = await mkTestHome("creates");
    const draftRoot = "~/diary-drafts";

    const result = await runInitCommand([], {
      homeDir,
      answers: {
        draftRoot,
        scheduleTime: "23:30",
        aiProvider: "openai",
        persona: "dry coworker",
        roastLevel: "3"
      }
    });

    expect(result.created).toBe(true);
    expect(JSON.parse(await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")))
      .toEqual({
        schemaVersion: 1,
        draftRoot: join(homeDir, "diary-drafts"),
        scheduleTime: "23:30",
        aiProvider: "openai",
        persona: "dry coworker",
        roastLevel: 3
      });
    expect(JSON.parse(await readFile(join(homeDir, ".uncommitted", "projects.json"), "utf8")))
      .toEqual({ schemaVersion: 1, projects: [] });
    expect(JSON.parse(await readFile(join(homeDir, ".uncommitted", "history", "formats.json"), "utf8")))
      .toEqual({ schemaVersion: 1, formats: [] });
    await expectDirectory(join(homeDir, ".uncommitted", "drafts"));
    await expectDirectory(join(homeDir, ".uncommitted", "logs"));
    await expectDirectory(join(homeDir, "diary-drafts"));
  });

  it("does not overwrite existing config by default", async () => {
    const homeDir = await mkTestHome("existing");
    const configFile = join(homeDir, ".uncommitted", "config.json");
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(configFile, "{\"existing\":true}\n");

    await expect(runInitCommand([], { homeDir })).rejects.toThrow(
      "Config already exists. Rerun with --force to overwrite."
    );
    await expect(readFile(configFile, "utf8")).resolves.toBe("{\"existing\":true}\n");
  });

  it("overwrites existing config when forced", async () => {
    const homeDir = await mkTestHome("force");
    const configFile = join(homeDir, ".uncommitted", "config.json");
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(configFile, "{\"existing\":true}\n");

    await runInitCommand(["--force"], {
      homeDir,
      answers: { roastLevel: "5" }
    });

    const config = JSON.parse(await readFile(configFile, "utf8")) as { roastLevel: number };
    expect(config.roastLevel).toBe(5);
  });

  it("rejects roast levels outside the MVP range", async () => {
    const homeDir = await mkTestHome("roast");

    await expect(
      runInitCommand([], {
        homeDir,
        answers: { roastLevel: "6" }
      })
    ).rejects.toThrow("Roast level must be a number from 0 to 5.");
  });
});

async function mkTestHome(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `uncommitted-init-${name}-`));
}

async function expectDirectory(path: string): Promise<void> {
  await expect(stat(path).then((stats) => stats.isDirectory())).resolves.toBe(true);
}
