import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitHubToken, GitHubTokenConfigError } from "../src/github-token-resolver.js";
import { clearGlobalConfigCache } from "../src/global-config.js";

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
  });

  it("prefers GITHUB_TOKEN env var over config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify({ githubToken: "from-config" })
    );
    const result = await resolveGitHubToken({ homeDir, env: { GITHUB_TOKEN: "from-env" } });
    expect(result).toEqual({ token: "from-env", source: "env" });
  });

  it("falls back to config when env is unset", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify({ githubToken: "from-config" })
    );
    const result = await resolveGitHubToken({ homeDir, env: {} });
    expect(result).toEqual({ token: "from-config", source: "config" });
  });

  it("returns missing when neither source has a token", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    const result = await resolveGitHubToken({ homeDir, env: {} });
    expect(result).toEqual({ token: null, source: "missing" });
  });

  it("ignores empty-string env values", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    const result = await resolveGitHubToken({ homeDir, env: { GITHUB_TOKEN: "" } });
    expect(result.source).toBe("missing");
  });

  it("throws GitHubTokenConfigError when config.json is malformed JSON", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "config.json"), "{ not json");
    await expect(resolveGitHubToken({ homeDir, env: {} })).rejects.toBeInstanceOf(
      GitHubTokenConfigError
    );
  });

  it("error from malformed config has code 'config-corruption'", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "config.json"), "{ not json");
    try {
      await resolveGitHubToken({ homeDir, env: {} });
      throw new Error("Expected GitHubTokenConfigError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubTokenConfigError);
      expect((err as GitHubTokenConfigError).code).toBe("config-corruption");
    }
  });

  it("returns missing when config file does not exist", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    // No .uncommitted dir or config.json written
    const result = await resolveGitHubToken({ homeDir, env: {} });
    expect(result).toEqual({ token: null, source: "missing" });
  });

  it("env GITHUB_TOKEN wins even when config is malformed", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ght-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "config.json"), "{ not json");
    const result = await resolveGitHubToken({ homeDir, env: { GITHUB_TOKEN: "from-env" } });
    expect(result).toEqual({ token: "from-env", source: "env" });
  });
});
