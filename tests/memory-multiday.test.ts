/**
 * End-to-end integration test for multi-day thread continuity & decay,
 * driving the full T1-T4 wiring: reflectProjectThreads -> readThreads ->
 * gateMemoryForInjection -> buildActivitySummary.
 *
 * Time is driven ONLY by injected `now: Date` values representing simulated
 * days (DAY1/DAY2/DAY3_NO_SIGNAL/DAY_FAR_FUTURE below) — never real elapsed
 * time, never `Date.now()`/argless `new Date()`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActivitySummary } from "../src/activity-summary.js";
import type { ActivitySignal } from "../src/event-source.js";
import { gateMemoryForInjection } from "../src/memory-safety-gate.js";
import { readThreads, THREAD_LAST_N_DAYS } from "../src/memory-store.js";
import { readCoreFacts } from "../src/persona-core-facts.js";
import { reflectProjectThreads } from "../src/reflection.js";

function signal(overrides: Partial<ActivitySignal> = {}): ActivitySignal {
  return {
    projectId: "p1",
    timestamp: "2026-07-14T09:00:00.000Z",
    kind: "commit",
    summary: "fix race condition in scheduler",
    safetyNotes: [],
    ...overrides
  };
}

// Simulated timeline. DAY2 recurs the same signal as DAY1; DAY3_NO_SIGNAL
// reflects with an empty signal batch (no new activity that day) to prove
// continuity isn't single-day-limited; DAY_FAR_FUTURE sits more than
// THREAD_LAST_N_DAYS past DAY2's lastSeen to force expiry.
const DAY1 = new Date("2026-07-14T10:00:00.000Z");
const DAY2 = new Date("2026-07-15T10:00:00.000Z");
const DAY3_NO_SIGNAL = new Date("2026-07-16T10:00:00.000Z");
const DAY_FAR_FUTURE = new Date(DAY2.getTime() + (THREAD_LAST_N_DAYS + 1) * 86_400_000);

describe("memory multi-day continuity & decay (integration)", () => {
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "unc-multiday-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "unc-multiday-home-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("persists a thread across days: lastSeen updates, firstSeen preserved, not duplicated (AC1)", async () => {
    await reflectProjectThreads(
      projectRoot,
      [signal({ timestamp: DAY1.toISOString() })],
      DAY1
    );

    const onDiskDay1 = await readThreads(projectRoot);
    expect(onDiskDay1).toHaveLength(1);
    expect(onDiskDay1[0].firstSeen).toBe(DAY1.toISOString());
    expect(onDiskDay1[0].lastSeen).toBe(DAY1.toISOString());

    // Day 2: the same kind/note signal recurs.
    const day2Reflected = await reflectProjectThreads(
      projectRoot,
      [signal({ timestamp: DAY2.toISOString() })],
      DAY2
    );
    expect(day2Reflected).toHaveLength(1); // updated, not duplicated

    const onDiskDay2 = await readThreads(projectRoot);
    expect(onDiskDay2).toHaveLength(1);
    expect(onDiskDay2[0].id).toBe(onDiskDay1[0].id);
    expect(onDiskDay2[0].firstSeen).toBe(DAY1.toISOString()); // preserved
    expect(onDiskDay2[0].lastSeen).toBe(DAY2.toISOString()); // updated
  });

  it("expires a thread untouched for > THREAD_LAST_N_DAYS on a later reflection (AC1)", async () => {
    await reflectProjectThreads(
      projectRoot,
      [signal({ timestamp: DAY1.toISOString() })],
      DAY1
    );
    expect(await readThreads(projectRoot)).toHaveLength(1);

    // A much later reflection with no new signals must still drop the
    // now-stale thread (applyThreadBounds runs inside reflectThreads).
    const reflected = await reflectProjectThreads(projectRoot, [], DAY_FAR_FUTURE);
    expect(reflected).toHaveLength(0);
    expect(await readThreads(projectRoot)).toHaveLength(0);
  });

  it("surfaces a multi-day thread in buildActivitySummary on a day with no new signals (AC2)", async () => {
    await reflectProjectThreads(
      projectRoot,
      [signal({ timestamp: DAY1.toISOString() })],
      DAY1
    );
    await reflectProjectThreads(
      projectRoot,
      [signal({ timestamp: DAY2.toISOString() })],
      DAY2
    );

    // Day 3: no new signals at all — the thread accumulated over the prior
    // two days must still be reflected (kept alive, not expired) and inject.
    const reflectedDay3 = await reflectProjectThreads(projectRoot, [], DAY3_NO_SIGNAL);
    expect(reflectedDay3).toHaveLength(1);

    const persisted = await readThreads(projectRoot);
    const coreFacts = await readCoreFacts(homeDir);
    const gated = gateMemoryForInjection({ threads: persisted, coreFacts });

    const summary = buildActivitySummary({
      targetDate: "2026-07-16",
      generatedAt: DAY3_NO_SIGNAL.toISOString(),
      gitEvents: [],
      manualNotes: [],
      memoryThreads: gated.threads,
      coreFacts: gated.coreFacts
    });

    expect(summary.unfinishedThreads).toContain("fix race condition in scheduler");
  });

  it("drops a blocked-safety thread note from the injection slots in the multi-day flow (AC4)", async () => {
    // Verified against src/safety-report.ts's `secret` detection rule (see
    // tests/memory-safety-gate.test.ts): "SECRET=..." matches and blocks.
    // An AKIA-style string is NOT matched by that rule and would not block.
    const blockedSummary = "leaked SECRET=abc123def456 in the logs";

    await reflectProjectThreads(
      projectRoot,
      [signal({ timestamp: DAY1.toISOString(), summary: blockedSummary })],
      DAY1
    );

    const persisted = await readThreads(projectRoot);
    // Sanity check: reflection's defensive re-sanitization (sanitizeText)
    // does not itself strip this pattern — safety gating is a distinct,
    // later stage in the pipeline, not reflection's job.
    expect(persisted.some((t) => t.note.includes("SECRET=abc123def456"))).toBe(true);

    const coreFacts = await readCoreFacts(homeDir);
    const gated = gateMemoryForInjection({ threads: persisted, coreFacts });
    expect(gated.threads.some((t) => t.note.includes("SECRET"))).toBe(false);

    const summary = buildActivitySummary({
      targetDate: "2026-07-14",
      generatedAt: DAY1.toISOString(),
      gitEvents: [],
      manualNotes: [],
      memoryThreads: gated.threads,
      coreFacts: gated.coreFacts
    });

    expect(summary.unfinishedThreads.some((entry) => entry.includes("SECRET"))).toBe(false);
    expect(summary.possibleJokes.some((entry) => entry.includes("SECRET"))).toBe(false);
  });
});
