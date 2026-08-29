import { describe, expect, it } from "vitest";
import { reflectThreads, deriveThreadNote } from "../src/reflection.js";
import type { ActivitySignal } from "../src/event-source.js";
import type { MemoryThread } from "../src/memory-store.js";

function signal(overrides: Partial<ActivitySignal> = {}): ActivitySignal {
  return {
    projectId: "p1",
    timestamp: "2026-07-15T09:00:00.000Z",
    kind: "commit",
    summary: "fix race condition in scheduler",
    safetyNotes: [],
    ...overrides
  };
}

describe("reflection", () => {
  it("creates a thread from a signal on an empty store", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out = reflectThreads({ threads: [], signals: [signal()], now });
    expect(out).toHaveLength(1);
    expect(out[0].firstSeen).toBe(now.toISOString());
    expect(out[0].lastSeen).toBe(now.toISOString());
    expect(out[0].status).toBe("active");
  });

  it("updates lastSeen of a recurring thread instead of duplicating", () => {
    const day1 = new Date("2026-07-14T10:00:00.000Z");
    const first = reflectThreads({
      threads: [],
      signals: [signal({ timestamp: "2026-07-14T09:00:00.000Z" })],
      now: day1
    });
    const day2 = new Date("2026-07-15T10:00:00.000Z");
    const second = reflectThreads({ threads: first, signals: [signal()], now: day2 });
    expect(second).toHaveLength(1);
    expect(second[0].firstSeen).toBe(day1.toISOString());
    expect(second[0].lastSeen).toBe(day2.toISOString());
  });

  it("never stores raw code / diff — notes are re-sanitized (AC3)", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const dirty = signal({
      summary: "changed `const token = process.env.SECRET` diff --git a/x b/x"
    });
    const out = reflectThreads({ threads: [], signals: [dirty], now });
    expect(out[0].note).not.toContain("diff --git");
    expect(out[0].note).not.toContain("process.env.SECRET");
    expect(deriveThreadNote("`raw`")).toContain("[redacted-code]");
  });

  it("does not duplicate threads for repeated identical signals in one batch", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out = reflectThreads({
      threads: [],
      signals: [signal(), signal({ timestamp: "2026-07-15T09:30:00.000Z" })],
      now
    });
    expect(out).toHaveLength(1);
  });

  it("creates distinct threads for different kinds/notes", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out = reflectThreads({
      threads: [],
      signals: [
        signal({ summary: "fix race condition in scheduler" }),
        signal({ summary: "refactor the scheduler module", kind: "commit" })
      ],
      now
    });
    expect(out).toHaveLength(2);
  });

  it("id is deterministic and content-derived, not random/time-based", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out1 = reflectThreads({ threads: [], signals: [signal()], now });
    const out2 = reflectThreads({ threads: [], signals: [signal()], now });
    expect(out1[0].id).toBe(out2[0].id);
    expect(out1[0].id).toMatch(/^bug:/);
  });

  // sanitizeText only covers emails / absolute paths / private URLs / raw code.
  // A credential like `SECRET=...` survives it but is `blocked` by
  // checkDraftSafety — it must never reach the durable thread store, not just
  // be filtered at the injection boundary.
  it("drops safety-blocked signals instead of persisting them (AC3/AC4)", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out = reflectThreads({
      threads: [],
      signals: [signal({ summary: "fix login with SECRET=abc123def456ghi789" })],
      now
    });

    expect(out).toEqual([]);
  });

  it("keeps safe signals and stores their redacted note", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out = reflectThreads({
      threads: [],
      signals: [signal({ summary: "fix race condition in scheduler" })],
      now
    });

    expect(out).toHaveLength(1);
    expect(out[0].note).toBe("fix race condition in scheduler");
  });

  it("drops stored threads whose note is safety-blocked (AC3/AC4)", () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const out = reflectThreads({
      threads: [
        {
          id: "bug:legacy",
          firstSeen: "2026-07-14T10:00:00.000Z",
          lastSeen: "2026-07-14T10:00:00.000Z",
          kind: "bug",
          note: "fix login with SECRET=abc123def456ghi789",
          status: "active",
          decay: 1
        }
      ],
      signals: [],
      now
    });

    expect(out).toEqual([]);
  });
});

describe("occurrenceCount 누적 (UNC-274 / T2)", () => {
  it("counts multiple same-day signals for one thread as a single occurrence", () => {
    const day1 = new Date("2026-08-10T09:00:00.000Z");

    const first = reflectThreads({
      threads: [],
      signals: [signal({ summary: "flaky timeout again" })],
      now: day1
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.occurrenceCount).toBe(1);

    // 같은 날, 같은 스레드로 접히는 신호가 하나 더 들어온다
    const sameDay = reflectThreads({
      threads: first,
      signals: [signal({ summary: "flaky timeout again" })],
      now: new Date("2026-08-10T21:00:00.000Z")
    });

    expect(sameDay).toHaveLength(1);
    expect(sameDay[0]?.occurrenceCount).toBe(1);
  });

  it("increments the counter when the thread reappears on a later date", () => {
    const first = reflectThreads({
      threads: [],
      signals: [signal({ summary: "flaky timeout again" })],
      now: new Date("2026-08-10T09:00:00.000Z")
    });

    const nextDay = reflectThreads({
      threads: first,
      signals: [signal({ summary: "flaky timeout again" })],
      now: new Date("2026-08-11T09:00:00.000Z")
    });

    expect(nextDay).toHaveLength(1);
    expect(nextDay[0]?.occurrenceCount).toBe(2);
  });

  it("increments a legacy thread that carries no occurrenceCount to 2 on its next day", () => {
    // signal()'s default kind is "commit", and "flaky timeout again" matches
    // JOKE_PATTERN (not BUG_PATTERN), so it classifies as "running-joke" —
    // the legacy fixture's kind must match that or threadKey() won't merge
    // it with the incoming signal and this test would (wrongly) pass by
    // creating a second thread instead of exercising the merge path.
    const legacy: MemoryThread = {
      id: "running-joke:flaky-timeout-again",
      firstSeen: "2026-08-09T00:00:00.000Z",
      lastSeen: "2026-08-10T00:00:00.000Z",
      kind: "running-joke",
      note: "flaky timeout again",
      status: "active",
      decay: 1
      // occurrenceCount 없음 — 레거시 레코드
    };

    const merged = reflectThreads({
      threads: [legacy],
      signals: [signal({ summary: "flaky timeout again" })],
      now: new Date("2026-08-11T09:00:00.000Z")
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.occurrenceCount).toBe(2);
  });
});
