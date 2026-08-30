import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyThreadBounds,
  isMemoryThread,
  isThreadExpired,
  memoryDir,
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
    // readThreads normalizes the absent occurrenceCount to 1 (UNC-273 / T1).
    expect(await readThreads(root)).toEqual(
      threads.map((t) => ({ ...t, occurrenceCount: 1 }))
    );
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

describe("occurrenceCount (UNC-273 / T1)", () => {
  it("accepts a legacy record with no occurrenceCount and normalizes it to 1 on read", async () => {
    const root = await mkdtemp(join(tmpdir(), "unc-mem-"));
    const legacyLine = JSON.stringify({
      id: "bug:flaky-timeout",
      firstSeen: "2026-08-01T00:00:00.000Z",
      lastSeen: "2026-08-03T00:00:00.000Z",
      kind: "bug",
      note: "flaky timeout again",
      status: "active",
      decay: 1
    });

    await mkdir(memoryDir(root), { recursive: true });
    await writeFile(threadsFilePath(root), `${legacyLine}\n`, "utf8");

    const threads = await readThreads(root);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.occurrenceCount).toBe(1);
    // 무손실: 기존 필드가 하나도 유실되지 않는다
    expect(threads[0]?.id).toBe("bug:flaky-timeout");
    expect(threads[0]?.firstSeen).toBe("2026-08-01T00:00:00.000Z");
    expect(threads[0]?.lastSeen).toBe("2026-08-03T00:00:00.000Z");
    expect(threads[0]?.kind).toBe("bug");
    expect(threads[0]?.note).toBe("flaky timeout again");
    expect(threads[0]?.status).toBe("active");
    expect(threads[0]?.decay).toBe(1);
  });

  it("round-trips an explicit occurrenceCount through write and read", async () => {
    const root = await mkdtemp(join(tmpdir(), "unc-mem-"));

    await writeThreads(root, [
      {
        id: "bug:flaky-timeout",
        firstSeen: "2026-08-01T00:00:00.000Z",
        lastSeen: "2026-08-03T00:00:00.000Z",
        kind: "bug",
        note: "flaky timeout again",
        status: "active",
        decay: 1,
        occurrenceCount: 4
      }
    ]);

    const threads = await readThreads(root);

    expect(threads[0]?.occurrenceCount).toBe(4);
  });

  it("isMemoryThread accepts a missing occurrenceCount and rejects a non-number one", () => {
    const base = {
      id: "bug:x",
      firstSeen: "2026-08-01T00:00:00.000Z",
      lastSeen: "2026-08-03T00:00:00.000Z",
      kind: "bug",
      note: "n",
      status: "active",
      decay: 1
    };

    expect(isMemoryThread(base)).toBe(true);
    expect(isMemoryThread({ ...base, occurrenceCount: 3 })).toBe(true);
    expect(isMemoryThread({ ...base, occurrenceCount: "3" })).toBe(false);
  });
});
