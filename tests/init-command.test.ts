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
        carouselVisualStyle: "photo-first",
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
        carouselVisualStyle: "photo-first",
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

  it("preserves existing registry and format history when forced", async () => {
    const homeDir = await mkTestHome("force-preserves");
    const configDir = join(homeDir, ".uncommitted");
    const historyDir = join(configDir, "history");
    const projectsFile = join(configDir, "projects.json");
    const formatHistoryFile = join(historyDir, "formats.json");
    const existingProjects = {
      schemaVersion: 1,
      projects: [{ id: "project-1", root: "/repo" }]
    };
    const existingFormats = {
      schemaVersion: 1,
      formats: [{ id: "format-1" }]
    };

    await mkdir(historyDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), "{\"existing\":true}\n");
    await writeFile(projectsFile, `${JSON.stringify(existingProjects)}\n`);
    await writeFile(formatHistoryFile, `${JSON.stringify(existingFormats)}\n`);

    await runInitCommand(["--force"], {
      homeDir,
      answers: { roastLevel: "4" }
    });

    expect(JSON.parse(await readFile(projectsFile, "utf8"))).toEqual(existingProjects);
    expect(JSON.parse(await readFile(formatHistoryFile, "utf8"))).toEqual(existingFormats);
  });

  it("normalizes supported AI providers", async () => {
    const homeDir = await mkTestHome("provider-normalize");

    await runInitCommand([], {
      homeDir,
      answers: {
        aiProvider: " Anthropic "
      }
    });

    const config = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    ) as { aiProvider: string };
    expect(config.aiProvider).toBe("anthropic");
  });

  it("uses product-aligned defaults while deciding the AI provider later", async () => {
    const homeDir = await mkTestHome("provider-none");

    await runInitCommand([], { homeDir });

    const config = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    ) as {
      aiProvider: string;
      carouselVisualStyle: string;
      persona: string;
      roastLevel: number;
    };
    expect(config.aiProvider).toBe("none");
    expect(config.carouselVisualStyle).toBe("photo-first");
    expect(config.persona).toBe(
      "project-local AI coworker writing its own off-the-record diary"
    );
    expect(config.roastLevel).toBe(2);
  });

  it("supports Mistral and OpenRouter providers", async () => {
    const mistralHome = await mkTestHome("provider-mistral");
    const openrouterHome = await mkTestHome("provider-openrouter");

    await runInitCommand([], {
      homeDir: mistralHome,
      answers: { aiProvider: "mistral" }
    });
    await runInitCommand([], {
      homeDir: openrouterHome,
      answers: { aiProvider: "OpenRouter" }
    });

    const mistralConfig = JSON.parse(
      await readFile(join(mistralHome, ".uncommitted", "config.json"), "utf8")
    ) as { aiProvider: string };
    const openrouterConfig = JSON.parse(
      await readFile(join(openrouterHome, ".uncommitted", "config.json"), "utf8")
    ) as { aiProvider: string };

    expect(mistralConfig.aiProvider).toBe("mistral");
    expect(openrouterConfig.aiProvider).toBe("openrouter");
  });

  it("rejects unsupported AI providers", async () => {
    const homeDir = await mkTestHome("provider");

    await expect(
      runInitCommand([], {
        homeDir,
        answers: { aiProvider: "adlkfjldkajf" }
      })
    ).rejects.toThrow(
      "AI provider must be one of: none, mock, openai, anthropic, google, ollama, mistral, openrouter."
    );
  });

  it("rejects schedule times outside 24-hour HH:mm format", async () => {
    const homeDir = await mkTestHome("schedule");

    await expect(
      runInitCommand([], {
        homeDir,
        answers: { scheduleTime: "25:00" }
      })
    ).rejects.toThrow("Schedule time must use 24-hour HH:mm format.");
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
