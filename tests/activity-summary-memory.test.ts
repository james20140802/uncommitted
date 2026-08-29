import { describe, expect, it } from "vitest";
import { buildActivitySummary, isActivitySummary } from "../src/activity-summary.js";
import type { ActivitySummaryInput } from "../src/activity-summary.js";
import type { MemoryThread } from "../src/memory-store.js";

function baseInput(): ActivitySummaryInput {
  return {
    targetDate: "2026-07-15",
    generatedAt: "2026-07-15T10:00:00.000Z",
    gitEvents: [],
    manualNotes: []
  };
}

function thread(overrides: Partial<MemoryThread> = {}): MemoryThread {
  return {
    id: "t",
    firstSeen: "2026-07-10T00:00:00.000Z",
    lastSeen: "2026-07-15T00:00:00.000Z",
    kind: "bug",
    note: "race condition again",
    status: "active",
    decay: 1,
    ...overrides
  };
}

describe("activity-summary memory injection", () => {
  it("injects top-K active threads into existing slots (continuity, not single-day)", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [
        thread(),
        thread({
          id: "j",
          kind: "running-joke",
          note: "the flaky test strikes again"
        })
      ]
    });

    expect(summary.unfinishedThreads).toContain("race condition again");
    expect(summary.possibleJokes).toContain("the flaky test strikes again");
  });

  it("routes win-kind threads into possibleJokes alongside running-joke", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [thread({ id: "w", kind: "win", note: "shipped the export flow" })]
    });

    expect(summary.possibleJokes).toContain("shipped the export flow");
    expect(summary.unfinishedThreads).not.toContain("shipped the export flow");
  });

  it("excludes expired threads and caps injection at THREAD_TOP_K by recencyDecay", () => {
    const expired = thread({
      id: "expired",
      note: "long stale thread",
      status: "expired"
    });
    // 10 active threads with a range of lastSeen so ranking is unambiguous;
    // only the 5 most recent (by recencyDecay against generatedAt) should be
    // injected into unfinishedThreads.
    const activeThreads = Array.from({ length: 10 }, (_, index) =>
      thread({
        id: `active-${index}`,
        note: `thread number ${index}`,
        lastSeen: `2026-07-${String(15 - index).padStart(2, "0")}T00:00:00.000Z`
      })
    );

    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [expired, ...activeThreads]
    });

    expect(summary.unfinishedThreads).not.toContain("long stale thread");
    for (let index = 0; index < 5; index += 1) {
      expect(summary.unfinishedThreads).toContain(`thread number ${index}`);
    }
    for (let index = 5; index < 10; index += 1) {
      expect(summary.unfinishedThreads).not.toContain(`thread number ${index}`);
    }
  });

  it("always injects core facts, prepended to unfinishedThreads", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      coreFacts: ["prefers TDD", "hates flaky tests"]
    });

    expect(summary.unfinishedThreads[0]).toBe("prefers TDD");
    expect(summary.unfinishedThreads[1]).toBe("hates flaky tests");
  });

  it("accumulates core facts ahead of both single-day and memory-thread entries", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      coreFacts: ["prefers TDD"],
      memoryThreads: [thread({ note: "an ongoing bug" })]
    });

    expect(summary.unfinishedThreads[0]).toBe("prefers TDD");
    expect(summary.unfinishedThreads).toContain("an ongoing bug");
  });

  it("omitting memory fields keeps single-day behavior unchanged", () => {
    const withFields = buildActivitySummary(baseInput());
    const withoutFieldsAgain = buildActivitySummary(baseInput());

    expect(Array.isArray(withFields.unfinishedThreads)).toBe(true);
    expect(withFields).toEqual(withoutFieldsAgain);
  });
});

describe("recurringThreads (UNC-275 / T3)", () => {
  it("exposes occurrenceCount and lastSeenDate for repeating threads (AC1)", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [
        thread({
          id: "bug:flaky",
          note: "flaky timeout again",
          occurrenceCount: 3,
          lastSeen: "2026-07-15T08:00:00.000Z"
        })
      ]
    });

    expect(summary.recurringThreads).toEqual([
      {
        note: "flaky timeout again",
        occurrenceCount: 3,
        lastSeenDate: "2026-07-15"
      }
    ]);
  });

  it("returns no recurring threads when nothing has occurred more than once (AC2 판정 기준)", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [
        thread({ id: "a", note: "one-off thing", occurrenceCount: 1 }),
        thread({ id: "b", note: "another one-off", occurrenceCount: 1 })
      ]
    });

    expect(summary.recurringThreads ?? []).toEqual([]);
  });

  it("treats a thread with no occurrenceCount as non-recurring", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [thread({ id: "legacy", note: "legacy thread" })]
    });

    expect(summary.recurringThreads ?? []).toEqual([]);
  });

  it("caps recurring threads at 2", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [
        thread({ id: "r1", note: "r1", occurrenceCount: 5, lastSeen: "2026-07-15T00:00:00.000Z" }),
        thread({ id: "r2", note: "r2", occurrenceCount: 4, lastSeen: "2026-07-14T00:00:00.000Z" }),
        thread({ id: "r3", note: "r3", occurrenceCount: 3, lastSeen: "2026-07-13T00:00:00.000Z" })
      ]
    });

    expect(summary.recurringThreads).toHaveLength(2);
    expect(summary.recurringThreads?.map((t) => t.note)).toEqual(["r1", "r2"]);
  });

  it("never surfaces a high-count thread that fell outside the recency top-K (랭킹 제약, 결정 ④)", () => {
    // top-K = 5. recencyDecay 순으로 앞선 5개는 모두 비반복(count 1)이고,
    // 6번째로 밀려난 스레드만 카운트가 높다 → recurringThreads는 비어야 한다.
    const recentNonRecurring = Array.from({ length: 5 }, (_, index) =>
      thread({
        id: `recent-${index}`,
        note: `recent ${index}`,
        occurrenceCount: 1,
        lastSeen: `2026-07-${String(15 - index).padStart(2, "0")}T00:00:00.000Z`
      })
    );
    const staleButFrequent = thread({
      id: "stale",
      note: "stale but frequent",
      occurrenceCount: 9,
      lastSeen: "2026-07-05T00:00:00.000Z"
    });

    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [...recentNonRecurring, staleButFrequent]
    });

    expect(summary.recurringThreads ?? []).toEqual([]);
    expect(summary.unfinishedThreads).not.toContain("stale but frequent");
  });

  it("stamps schemaVersion 2 on newly built summaries", () => {
    const summary = buildActivitySummary(baseInput());

    expect(summary.schemaVersion).toBe(2);
  });

  it("still accepts a stored v1 activity-summary.json through the guard (하위 호환)", () => {
    const v1 = {
      ...buildActivitySummary(baseInput()),
      schemaVersion: 1
    };
    delete (v1 as { recurringThreads?: unknown }).recurringThreads;

    expect(isActivitySummary(v1)).toBe(true);
  });
});
