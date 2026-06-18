import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitHubToken } from "../src/github-token-resolver.js";

describe("resolveGitHubToken", () => {
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
});
