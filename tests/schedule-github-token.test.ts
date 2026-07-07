import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { persistGitHubTokenForSchedule } from "../src/schedule-github-token.js";
import { clearGlobalConfigCache } from "../src/global-config.js";
import { resolveGitHubToken } from "../src/github-token-resolver.js";

describe("persistGitHubTokenForSchedule", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
  });

  it("persists env GITHUB_TOKEN into config.json with 0600 permissions when config has no token", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-persist-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, draftRoot: "~/Uncommitted/drafts" }));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: true, reason: "persisted" });

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.githubToken).toBe("ghp_env_token");
    expect(written.schemaVersion).toBe(1);
    expect(written.draftRoot).toBe("~/Uncommitted/drafts");

    const { mode } = await stat(configPath);
    expect(mode & 0o777).toBe(0o600);
  });

  it("preserves all existing config fields through the atomic rename and leaves no temp file", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-atomic-"));
    const configDir = join(homeDir, ".uncommitted");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    const original = {
      schemaVersion: 1,
      draftRoot: "~/Uncommitted/drafts",
      scheduleTime: "23:30",
      aiProvider: "openai",
      roastLevel: 3,
      sources: { git: { enabled: true }, github: { enabled: true } }
    };
    await writeFile(configPath, JSON.stringify(original));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });
    expect(result).toEqual({ persisted: true, reason: "persisted" });

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written).toEqual({ ...original, githubToken: "ghp_env_token" });

    const { mode } = await stat(configPath);
    expect(mode & 0o777).toBe(0o600);

    // No orphaned temp file left behind by the atomic write.
    const entries = await readdir(configDir);
    expect(entries).toEqual(["config.json"]);
  });

  it("does not overwrite an existing githubToken in config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-existing-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    const original = JSON.stringify({ schemaVersion: 1, githubToken: "already-set" });
    await writeFile(configPath, original);

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: false, reason: "already-in-config" });

    const afterContent = await readFile(configPath, "utf8");
    expect(JSON.parse(afterContent)).toEqual({ schemaVersion: 1, githubToken: "already-set" });
  });

  it("does nothing when GITHUB_TOKEN is not set in env", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-noenv-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1 }));

    const result = await persistGitHubTokenForSchedule({ homeDir, env: {} });

    expect(result).toEqual({ persisted: false, reason: "no-env-token" });

    const afterContent = await readFile(configPath, "utf8");
    expect(JSON.parse(afterContent)).toEqual({ schemaVersion: 1 });
  });

  it("treats an empty/whitespace GITHUB_TOKEN as absent", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-blank-"));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "   " }
    });

    expect(result).toEqual({ persisted: false, reason: "no-env-token" });
  });

  it("does not create or write a config file when config is missing or not a record", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-missing-"));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: false, reason: "config-unavailable" });

    const configPath = join(homeDir, ".uncommitted", "config.json");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("does not persist when config declares an unsupported schemaVersion", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-badschema-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    // schemaVersion 2 is rejected as malformed by every other reader
    // (source gating, preview); persisting a token here would be useless
    // because `run-now` fails loading sources on the same guard.
    const original = { schemaVersion: 2, draftRoot: "~/Uncommitted/drafts" };
    await writeFile(configPath, JSON.stringify(original));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: false, reason: "unsupported-schema" });

    // Config left byte-for-byte untouched: no token written.
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
  });

  it("does not persist when the GitHub source is explicitly disabled", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-ghoff-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    // GitHub opted out: scheduled collection skips GitHub, so writing the
    // token would leave a plaintext secret with no benefit.
    const original = {
      schemaVersion: 1,
      sources: { git: { enabled: true }, github: { enabled: false } }
    };
    await writeFile(configPath, JSON.stringify(original));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: false, reason: "github-source-disabled" });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
  });

  it("persists when the GitHub source is explicitly enabled", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-ghon-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sources: { github: { enabled: true } }
      })
    );

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: true, reason: "persisted" });
    expect(JSON.parse(await readFile(configPath, "utf8")).githubToken).toBe(
      "ghp_env_token"
    );
  });

  it("returns config-unavailable when config.json is valid JSON but not a record", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-notrecord-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    await writeFile(configPath, JSON.stringify([1, 2, 3]));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });

    expect(result).toEqual({ persisted: false, reason: "config-unavailable" });

    const afterContent = await readFile(configPath, "utf8");
    expect(JSON.parse(afterContent)).toEqual([1, 2, 3]);
  });

  it("persisted token round-trips through resolveGitHubToken with source config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "sgt-roundtrip-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    const configPath = join(homeDir, ".uncommitted", "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1 }));

    const result = await persistGitHubTokenForSchedule({
      homeDir,
      env: { GITHUB_TOKEN: "ghp_env_token" }
    });
    expect(result.persisted).toBe(true);

    clearGlobalConfigCache();
    const resolved = await resolveGitHubToken({ homeDir, env: {} });
    expect(resolved).toEqual({ token: "ghp_env_token", source: "config" });
  });
});
