import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverClaudeSessionLogs } from "../src/claude-session-discovery.js";

describe("discoverClaudeSessionLogs", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "uncommitted-claude-home-"));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("returns [] when ~/.claude/projects does not exist", async () => {
    const result = await discoverClaudeSessionLogs({ claudeHome: tmpHome });
    expect(result).toEqual([]);
  });

  it("returns [] when ~/.claude/projects is empty", async () => {
    await mkdir(join(tmpHome, "projects"), { recursive: true });
    const result = await discoverClaudeSessionLogs({ claudeHome: tmpHome });
    expect(result).toEqual([]);
  });

  it("lists jsonl session files across project subdirs, sorted deterministically", async () => {
    const projects = join(tmpHome, "projects");
    const p1 = join(projects, "-Users-alice-repoA");
    const p2 = join(projects, "-Users-alice-repoB");
    await mkdir(p1, { recursive: true });
    await mkdir(p2, { recursive: true });
    await writeFile(join(p1, "sess-1.jsonl"), "");
    await writeFile(join(p1, "sess-0.jsonl"), "");
    await writeFile(join(p2, "sess-9.jsonl"), "");
    await writeFile(join(p1, "README.md"), "");

    const result = await discoverClaudeSessionLogs({ claudeHome: tmpHome });
    expect(result.map((r) => [r.projectDirName, r.sessionId])).toEqual([
      ["-Users-alice-repoA", "sess-0"],
      ["-Users-alice-repoA", "sess-1"],
      ["-Users-alice-repoB", "sess-9"]
    ]);
    expect(result.every((r) => r.path.endsWith(".jsonl"))).toBe(true);
  });

  it("does not recurse below project subdirs", async () => {
    const projects = join(tmpHome, "projects");
    const p1 = join(projects, "-Users-alice-repoA");
    await mkdir(join(p1, "nested"), { recursive: true });
    await writeFile(join(p1, "nested", "should-not-find.jsonl"), "");
    await writeFile(join(p1, "ok.jsonl"), "");
    const result = await discoverClaudeSessionLogs({ claudeHome: tmpHome });
    expect(result.map((r) => r.sessionId)).toEqual(["ok"]);
  });
});
