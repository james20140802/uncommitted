import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  injectPersistedProviderKeysIntoEnv,
  persistProviderKeysForSchedule
} from "../src/schedule-provider-keys.js";
import { clearGlobalConfigCache } from "../src/global-config.js";

async function makeConfig(
  contents: Record<string, unknown>
): Promise<{ homeDir: string; configPath: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "spk-"));
  const configDir = join(homeDir, ".uncommitted");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  await writeFile(configPath, JSON.stringify(contents));
  return { homeDir, configPath };
}

describe("persistProviderKeysForSchedule", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
  });

  it("persists every env-present provider key into config.json at 0600", async () => {
    const { homeDir, configPath } = await makeConfig({
      schemaVersion: 1,
      draftRoot: "~/Uncommitted/drafts"
    });

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENROUTER_API_KEY: "sk-or",
        ANTHROPIC_API_KEY: "sk-ant"
      }
    });

    expect(result.reason).toBe("persisted");
    expect(result.persisted.sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY"
    ]);

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.openaiApiKey).toBe("sk-openai");
    expect(written.openrouterApiKey).toBe("sk-or");
    expect(written.anthropicApiKey).toBe("sk-ant");
    expect(written.schemaVersion).toBe(1);
    expect(written.draftRoot).toBe("~/Uncommitted/drafts");

    const { mode } = await stat(configPath);
    expect(mode & 0o777).toBe(0o600);
  });

  it("persists only the keys present in env and leaves others absent", async () => {
    const { homeDir, configPath } = await makeConfig({ schemaVersion: 1 });

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: { OPENAI_API_KEY: "sk-openai" }
    });

    expect(result.reason).toBe("persisted");
    expect(result.persisted).toEqual(["OPENAI_API_KEY"]);

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.openaiApiKey).toBe("sk-openai");
    expect(written).not.toHaveProperty("openrouterApiKey");
    expect(written).not.toHaveProperty("anthropicApiKey");
  });

  it("returns no-env-keys and does not modify config when no provider key is set", async () => {
    const { homeDir, configPath } = await makeConfig({ schemaVersion: 1 });
    const before = await readFile(configPath, "utf8");

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: { HOME: "/home/user", UNCOMMITTED_AI_TIMEOUT_MS: "5000" }
    });

    expect(result).toEqual({ persisted: [], reason: "no-env-keys" });
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("skips whitespace-only env values", async () => {
    const { homeDir } = await makeConfig({ schemaVersion: 1 });

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: { OPENAI_API_KEY: "   ", ANTHROPIC_API_KEY: "\t" }
    });

    expect(result).toEqual({ persisted: [], reason: "no-env-keys" });
  });

  it("never overwrites a provider key already present in config", async () => {
    const { homeDir, configPath } = await makeConfig({
      schemaVersion: 1,
      openaiApiKey: "sk-existing"
    });

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: { OPENAI_API_KEY: "sk-new-should-be-ignored" }
    });

    expect(result).toEqual({ persisted: [], reason: "already-in-config" });
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.openaiApiKey).toBe("sk-existing");
  });

  it("persists only the not-yet-stored keys when config already has one", async () => {
    const { homeDir, configPath } = await makeConfig({
      schemaVersion: 1,
      openaiApiKey: "sk-existing"
    });

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: {
        OPENAI_API_KEY: "sk-new-should-be-ignored",
        ANTHROPIC_API_KEY: "sk-ant-new"
      }
    });

    expect(result.reason).toBe("persisted");
    expect(result.persisted).toEqual(["ANTHROPIC_API_KEY"]);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.openaiApiKey).toBe("sk-existing");
    expect(written.anthropicApiKey).toBe("sk-ant-new");
  });

  it("returns config-unavailable when the config file is missing", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spk-missing-"));

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: { OPENAI_API_KEY: "sk-openai" }
    });

    expect(result).toEqual({ persisted: [], reason: "config-unavailable" });
  });

  it("returns unsupported-schema and does not modify a config with a bad schemaVersion", async () => {
    const { homeDir, configPath } = await makeConfig({ schemaVersion: 2 });
    const before = await readFile(configPath, "utf8");

    const result = await persistProviderKeysForSchedule({
      homeDir,
      env: { OPENAI_API_KEY: "sk-openai" }
    });

    expect(result).toEqual({ persisted: [], reason: "unsupported-schema" });
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const { homeDir, configPath } = await makeConfig({
      schemaVersion: 1,
      draftRoot: "~/Uncommitted/drafts",
      sources: { git: { enabled: true } }
    });

    await persistProviderKeysForSchedule({
      homeDir,
      env: { OPENAI_API_KEY: "sk-openai" }
    });

    const entries = await readdir(join(homeDir, ".uncommitted"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.sources).toEqual({ git: { enabled: true } });
  });
});

describe("injectPersistedProviderKeysIntoEnv", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
  });

  it("injects each persisted provider key into env when not already set", async () => {
    const { homeDir } = await makeConfig({
      schemaVersion: 1,
      openaiApiKey: "sk-openai",
      openrouterApiKey: "sk-or",
      anthropicApiKey: "sk-ant"
    });

    const env: NodeJS.ProcessEnv = {};
    const result = await injectPersistedProviderKeysIntoEnv({ homeDir, env });

    expect(result.injected.sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY"
    ]);
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("does not overwrite a provider key already present in env (env precedence)", async () => {
    const { homeDir } = await makeConfig({
      schemaVersion: 1,
      openaiApiKey: "sk-from-config"
    });

    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-from-env" };
    const result = await injectPersistedProviderKeysIntoEnv({ homeDir, env });

    expect(result.injected).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe("sk-from-env");
  });

  it("treats a whitespace-only env value as unset and injects the config key", async () => {
    const { homeDir } = await makeConfig({
      schemaVersion: 1,
      openaiApiKey: "sk-from-config"
    });

    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "   " };
    const result = await injectPersistedProviderKeysIntoEnv({ homeDir, env });

    expect(result.injected).toEqual(["OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("sk-from-config");
  });

  it("leaves a key unset when it is absent from both env and config (preserves failure guard)", async () => {
    const { homeDir } = await makeConfig({
      schemaVersion: 1,
      openaiApiKey: "sk-openai"
    });

    const env: NodeJS.ProcessEnv = {};
    const result = await injectPersistedProviderKeysIntoEnv({ homeDir, env });

    expect(result.injected).toEqual(["OPENAI_API_KEY"]);
    // Not stored in config → left unset so the consumer's "X is not set." guard fires.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("injects nothing when the config file is missing", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spk-inject-missing-"));
    const env: NodeJS.ProcessEnv = {};

    const result = await injectPersistedProviderKeysIntoEnv({ homeDir, env });

    expect(result).toEqual({ injected: [] });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("injects nothing when the config declares an unsupported schemaVersion", async () => {
    const { homeDir } = await makeConfig({
      schemaVersion: 2,
      openaiApiKey: "sk-openai"
    });
    const env: NodeJS.ProcessEnv = {};

    const result = await injectPersistedProviderKeysIntoEnv({ homeDir, env });

    expect(result).toEqual({ injected: [] });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
