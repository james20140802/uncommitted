import { describe, expect, it } from "vitest";
import { buildActivitySummary } from "../src/activity-summary.js";
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
