import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexSessionLogs } from "../src/codex-session-discovery.js";

async function makeCodexHome() {
  return mkdtemp(join(tmpdir(), "codex-discovery-"));
}

describe("discoverCodexSessionLogs", () => {
  it("returns empty array when codex home is missing", async () => {
    const home = join(await makeCodexHome(), "does-not-exist");
    expect(await discoverCodexSessionLogs({ codexHome: home })).toEqual([]);
  });

  it("returns empty array when sessions dir is empty", async () => {
    const home = await makeCodexHome();
    await mkdir(join(home, "sessions"), { recursive: true });
    expect(await discoverCodexSessionLogs({ codexHome: home })).toEqual([]);
  });

  it("discovers rollout files under YYYY/MM/DD", async () => {
    const home = await makeCodexHome();
    const day = join(home, "sessions", "2026", "06", "13");
    await mkdir(day, { recursive: true });
    const path1 = join(day, "rollout-2026-06-13T01-00-00-aaa.jsonl");
    const path2 = join(day, "rollout-2026-06-13T02-00-00-bbb.jsonl");
    await writeFile(path1, "");
    await writeFile(path2, "");
    const result = await discoverCodexSessionLogs({ codexHome: home });
    expect(result.map((r) => r.path).sort()).toEqual([path1, path2].sort());
    expect(result[0].sessionId).toMatch(/^rollout-/);
  });

  it("filters by targetDate when provided", async () => {
    const home = await makeCodexHome();
    const day1 = join(home, "sessions", "2026", "06", "13");
    const day2 = join(home, "sessions", "2026", "06", "14");
    await mkdir(day1, { recursive: true });
    await mkdir(day2, { recursive: true });
    await writeFile(join(day1, "rollout-2026-06-13T01-00-00-a.jsonl"), "");
    await writeFile(join(day2, "rollout-2026-06-14T01-00-00-b.jsonl"), "");
    const onlyJun14 = await discoverCodexSessionLogs({
      codexHome: home,
      targetDate: "2026-06-14"
    });
    expect(onlyJun14).toHaveLength(1);
    expect(onlyJun14[0].path).toContain("2026/06/14");
  });

  it("ignores non-rollout files and non-jsonl extensions", async () => {
    const home = await makeCodexHome();
    const day = join(home, "sessions", "2026", "06", "13");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "rollout-good.jsonl"), "");
    await writeFile(join(day, "notes.txt"), "");
    await writeFile(join(day, "config.json"), "");
    const result = await discoverCodexSessionLogs({ codexHome: home });
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain("rollout-good.jsonl");
  });
});
