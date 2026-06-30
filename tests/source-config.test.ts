import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SOURCE_NAMES,
  SourceConfigError,
  isSourceEnabled,
  listEnabledSources,
  loadSourceConfig
} from "../src/source-config.js";

describe("isSourceEnabled", () => {
  it("returns true for every source when the config object has no sources key", () => {
    const config = { schemaVersion: 1 };
    for (const name of SOURCE_NAMES) {
      expect(isSourceEnabled(config, name)).toBe(true);
    }
  });

  it("returns true when sources.<name> is absent but other sources are listed", () => {
    const config = { sources: { git: { enabled: false } } };
    expect(isSourceEnabled(config, "claude")).toBe(true);
    expect(isSourceEnabled(config, "codex")).toBe(true);
    expect(isSourceEnabled(config, "github")).toBe(true);
  });

  it("returns false when sources.<name>.enabled === false", () => {
    const config = { sources: { claude: { enabled: false } } };
    expect(isSourceEnabled(config, "claude")).toBe(false);
  });

  it("returns true when sources.<name>.enabled === true", () => {
    const config = { sources: { github: { enabled: true } } };
    expect(isSourceEnabled(config, "github")).toBe(true);
  });
});

describe("listEnabledSources", () => {
  it("returns all four canonical names when no sources key is present", () => {
    const config = { schemaVersion: 1 };
    expect(listEnabledSources(config)).toEqual(["git", "claude", "codex", "github"]);
  });

  it("returns only the enabled names when some are explicitly disabled", () => {
    const config = {
      sources: {
        git: { enabled: true },
        claude: { enabled: false },
        codex: { enabled: false },
        github: { enabled: true }
      }
    };
    expect(listEnabledSources(config)).toEqual(["git", "github"]);
  });
});

describe("loadSourceConfig", () => {
  it("reads a config JSON file and fills missing sources with enabled=true", async () => {
    const home = await mkdtemp(join(tmpdir(), "uncommitted-source-config-"));
    const configDir = join(home, ".uncommitted");
    await mkdir(configDir, { recursive: true });
    const configFile = join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          claude: { enabled: false }
        }
      })
    );

    const sources = await loadSourceConfig(configFile);
    expect(sources).toEqual({
      git: { enabled: true },
      claude: { enabled: false },
      codex: { enabled: true },
      github: { enabled: true }
    });
  });

  it("falls back to all-enabled defaults when the config file is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "uncommitted-source-config-"));
    const configFile = join(home, ".uncommitted", "config.json");

    const sources = await loadSourceConfig(configFile);
    expect(sources).toEqual({
      git: { enabled: true },
      claude: { enabled: true },
      codex: { enabled: true },
      github: { enabled: true }
    });
  });

  it("rejects a config with an unsupported schemaVersion", async () => {
    const home = await mkdtemp(join(tmpdir(), "uncommitted-source-config-"));
    const configDir = join(home, ".uncommitted");
    await mkdir(configDir, { recursive: true });
    const configFile = join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 2,
        sources: {
          git: { enabled: false }
        }
      })
    );

    await expect(loadSourceConfig(configFile)).rejects.toBeInstanceOf(
      SourceConfigError
    );
  });

  it("rejects a malformed config instead of silently enabling every source", async () => {
    const home = await mkdtemp(join(tmpdir(), "uncommitted-source-config-"));
    const configDir = join(home, ".uncommitted");
    await mkdir(configDir, { recursive: true });
    const configFile = join(configDir, "config.json");
    await writeFile(configFile, "{ this is not valid json", "utf8");

    await expect(loadSourceConfig(configFile)).rejects.toBeInstanceOf(
      SourceConfigError
    );
  });
});
