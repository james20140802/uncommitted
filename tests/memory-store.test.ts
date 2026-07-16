import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyThreadBounds,
  isThreadExpired,
  readThreads,
  recencyDecay,
  threadsFilePath,
  writeThreads,
  type MemoryThread,
  THREAD_LAST_N_DAYS,
  THREAD_MAX_ENTRIES
} from "../src/memory-store.js";

function thread(overrides: Partial<MemoryThread> = {}): MemoryThread {
  return {
    id: "t1",
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-07-10T00:00:00.000Z",
    kind: "bug",
    note: "race condition in scheduler",
    status: "active",
    decay: 1,
    ...overrides
  };
}

describe("memory-store", () => {
  it("round-trips threads through JSONL, missing file → []", async () => {
    const root = await mkdtemp(join(tmpdir(), "unc-mem-"));
    expect(await readThreads(root)).toEqual([]);
    const threads = [thread(), thread({ id: "t2", kind: "refactor" })];
    await writeThreads(root, threads);
    expect(await readThreads(root)).toEqual(threads);
    // path invariant
    expect(threadsFilePath(root).endsWith("/.uncommitted/memory/threads.jsonl")).toBe(true);
  });

  it("skips malformed JSONL lines instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "unc-mem-"));
    await writeThreads(root, [thread()]);
    const file = threadsFilePath(root);
    const good = (await readFile(file, "utf8")).trim();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, `${good}\nnot-json\n{"partial":true}\n`, "utf8");
    expect(await readThreads(root)).toHaveLength(1);
  });

  it("recencyDecay halves every half-life and clamps future timestamps", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const fresh = thread({ lastSeen: "2026-07-15T00:00:00.000Z" });
    expect(recencyDecay(fresh, now)).toBeCloseTo(1, 5);
    const week = thread({ lastSeen: "2026-07-08T00:00:00.000Z" });
    expect(recencyDecay(week, now)).toBeCloseTo(0.5, 5);
    const future = thread({ lastSeen: "2026-07-20T00:00:00.000Z" });
    expect(recencyDecay(future, now)).toBeCloseTo(1, 5);
  });

  it("expires threads past last-N-days and enforces max entries", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const stale = thread({ id: "old", lastSeen: "2026-07-01T00:00:00.000Z" });
    const staleAgeDays = (now.getTime() - Date.parse(stale.lastSeen)) / 86_400_000;
    expect(staleAgeDays).toBeGreaterThan(THREAD_LAST_N_DAYS);
    expect(isThreadExpired(stale, now)).toBe(true);
    const many = Array.from({ length: THREAD_MAX_ENTRIES + 5 }, (_, i) =>
      thread({ id: `t${i}`, lastSeen: `2026-07-3${(i % 2) + 0}T00:00:00.000Z` })
    );
    const bounded = applyThreadBounds([stale, ...many], now);
    expect(bounded.length).toBeLessThanOrEqual(THREAD_MAX_ENTRIES);
    expect(bounded.some((t) => t.id === "old")).toBe(false);
    expect(bounded.every((t) => t.status === "active")).toBe(true);
  });
});
