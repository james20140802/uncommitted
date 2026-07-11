import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearGlobalConfigCache, loadGlobalConfig } from "../src/global-config.js";
import { PersonaCommandError, runPersonaCommand } from "../src/persona-command.js";
import { PERSONA_PRESETS, isPersona, selectPersona } from "../src/persona.js";

describe("runPersonaCommand", () => {
  it("persists the chosen preset's structured persona and roastLevel to config.json", async () => {
    const homeDir = await mkTestHome("set");
    await writeConfig(homeDir);

    const result = await runPersonaCommand(["set", "까칠한 시니어"], { homeDir });

    expect(result.preset).toBe("까칠한 시니어");
    expect(result.config.persona).toEqual(PERSONA_PRESETS["까칠한 시니어"].persona);
    expect(result.config.roastLevel).toBe(PERSONA_PRESETS["까칠한 시니어"].roastLevel);

    const onDisk = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    );
    expect(isPersona(onDisk.persona)).toBe(true);
    expect(onDisk.persona.preset).toBe("까칠한 시니어");
    expect(onDisk.roastLevel).toBe(PERSONA_PRESETS["까칠한 시니어"].roastLevel);
  });

  it("clears the config cache so a subsequent load sees the new persona", async () => {
    const homeDir = await mkTestHome("cache");
    const configFile = join(homeDir, ".uncommitted", "config.json");
    await writeConfig(homeDir);

    // Prime the cache with the pre-update config.
    await loadGlobalConfig(configFile);

    await runPersonaCommand(["set", "텐션 높은 주니어"], { homeDir });

    const outcome = await loadGlobalConfig(configFile);
    if (outcome.status !== "ok") {
      throw new Error(`expected config load to succeed, got status: ${outcome.status}`);
    }
    const persona = selectPersona(outcome.value);
    expect(persona.preset).toBe("텐션 높은 주니어");

    clearGlobalConfigCache();
  });

  it("does not clobber unrelated config fields", async () => {
    const homeDir = await mkTestHome("preserve");
    await writeConfig(homeDir, {
      draftRoot: "/custom/draft/root",
      aiProvider: "openai",
      sources: {
        git: { enabled: true },
        claude: { enabled: false },
        codex: { enabled: true },
        github: { enabled: false }
      }
    });

    await runPersonaCommand(["set", "다정한 페어"], { homeDir });

    const onDisk = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    );
    expect(onDisk.draftRoot).toBe("/custom/draft/root");
    expect(onDisk.aiProvider).toBe("openai");
    expect(onDisk.sources).toEqual({
      git: { enabled: true },
      claude: { enabled: false },
      codex: { enabled: true },
      github: { enabled: false }
    });
  });

  it("layers a per-knob override over the preset", async () => {
    const homeDir = await mkTestHome("override");
    await writeConfig(homeDir);

    const result = await runPersonaCommand(
      ["set", "까칠한 시니어", "--emoji", "heavy"],
      { homeDir }
    );

    expect(result.config.persona.voice.emoji).toBe("heavy");
    expect(result.config.persona.voice.register).toBe(
      PERSONA_PRESETS["까칠한 시니어"].persona.voice.register
    );
  });

  it("lets --roast-level override the preset's roastLevel", async () => {
    const homeDir = await mkTestHome("override-roast");
    await writeConfig(homeDir);

    const result = await runPersonaCommand(
      ["set", "까칠한 시니어", "--roast-level", "0"],
      { homeDir }
    );

    expect(result.config.roastLevel).toBe(0);
    expect(result.config.persona).toEqual(PERSONA_PRESETS["까칠한 시니어"].persona);
  });

  it("throws an actionable error when config.json is missing", async () => {
    const homeDir = await mkTestHome("missing-config");

    await expect(
      runPersonaCommand(["set", "까칠한 시니어"], { homeDir })
    ).rejects.toThrow("Run `uncommitted init` first.");
  });

  it("throws for an unknown preset name", async () => {
    const homeDir = await mkTestHome("unknown-preset");
    await writeConfig(homeDir);

    await expect(
      runPersonaCommand(["set", "not a real preset"], { homeDir })
    ).rejects.toThrow(/Unknown persona preset/);
  });

  it("throws PersonaCommandError with code missing-config when config is missing", async () => {
    const homeDir = await mkTestHome("missing-config-code");

    try {
      await runPersonaCommand(["set", "까칠한 시니어"], { homeDir });
      throw new Error("expected runPersonaCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PersonaCommandError);
      expect((error as PersonaCommandError).code).toBe("missing-config");
    }
  });

  it("throws a usage error when the preset name is omitted", async () => {
    const homeDir = await mkTestHome("missing-preset-arg");
    await writeConfig(homeDir);

    await expect(runPersonaCommand(["set"], { homeDir })).rejects.toThrow(
      /Usage: uncommitted persona set/
    );
  });

  it("throws a usage error for an unsupported subcommand", async () => {
    const homeDir = await mkTestHome("bad-subcommand");
    await writeConfig(homeDir);

    await expect(
      runPersonaCommand(["get", "까칠한 시니어"], { homeDir })
    ).rejects.toThrow(/Usage: uncommitted persona set/);
  });
});

async function mkTestHome(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `uncommitted-persona-command-${name}-`));
}

async function writeConfig(
  homeDir: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  const config = {
    schemaVersion: 1,
    draftRoot: join(homeDir, "Uncommitted", "drafts"),
    scheduleTime: "23:30",
    aiProvider: "none",
    carouselVisualStyle: "photo-first",
    persona: "legacy free text persona",
    roastLevel: 2,
    rawRetentionDays: 30,
    captionProjectionTokenBudget: 4000,
    sources: {
      git: { enabled: true },
      claude: { enabled: true },
      codex: { enabled: true },
      github: { enabled: true }
    },
    ...overrides
  };
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
}
