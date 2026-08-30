import { describe, expect, it } from "vitest";
import { buildActivitySummary, isActivitySummary } from "../src/activity-summary.js";
import type { ActivitySummary, ActivitySummaryInput } from "../src/activity-summary.js";
import { buildCaptionInstructions } from "../src/diary-generator.js";
import { gateThreadForInjection } from "../src/memory-safety-gate.js";
import type { MemoryThread } from "../src/memory-store.js";
import type { ManualNoteEvent } from "../src/note-command.js";
import { reflectThreads } from "../src/reflection.js";
import type { ActivitySignal } from "../src/event-source.js";
import { RECURRING_THREAD_INSTRUCTIONS } from "../src/recurring-thread-instructions.js";
import { PERSONA_PRESETS, type Persona } from "../src/persona.js";
import type { MoodPlan, StoryFormatPlan } from "../src/story-format-plan.js";
import { buildStoryCardInstructions } from "../src/story-card-generator.js";
import { listStoryCardCandidateProjections } from "../src/story-card-registry.js";

// ---------------------------------------------------------------------------
// Local fixture helpers. Copied from the existing unit-test files rather than
// exported from them (tests/diary-generator.test.ts, tests/story-card-generator.test.ts,
// tests/reflection.test.ts) — see task-7-report.md for the mapping.
// ---------------------------------------------------------------------------

// Copied from tests/diary-generator.test.ts (captionTestPersona / captionTestMoodPlan
// / the local createStoryFormatPlan helper).
function testPersona(): Persona {
  return PERSONA_PRESETS["시니컬한 관찰자"].persona;
}

function buildMoodPlan(
  overrides: Partial<Omit<StoryFormatPlan, "schemaVersion">> = {}
): MoodPlan {
  const plan = {
    formatName: "Bug Court Transcript",
    reason: "The day had enough debugging evidence for a courtroom bit.",
    structure: [
      {
        part: "Opening statement",
        purpose: "Introduce the actual debugging work."
      },
      {
        part: "Evidence",
        purpose: "Mention real commits and blockers only."
      },
      {
        part: "Verdict",
        purpose: "Close with a light situation joke."
      }
    ],
    suggestedSlideCount: 4,
    captionStyle: "short witty caption",
    doNotMention: ["raw diffs", "private paths"],
    ...overrides
  };

  return {
    schemaVersion: 2,
    mood: "grind",
    angle: "The day circled the same flaky provider validation bug.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: plan.suggestedSlideCount
    },
    reason: plan.reason,
    structure: plan.structure,
    captionStyle: plan.captionStyle,
    doNotMention: plan.doNotMention
  };
}

function testMoodPlan(): MoodPlan {
  return buildMoodPlan({
    captionStyle: "짧고 위트있는 캡션",
    doNotMention: ["raw diffs", "private paths"]
  });
}

// Copied from tests/story-card-generator.test.ts (createSummary), renamed to
// avoid colliding with buildActivitySummary's own summary variables below.
function createStoryCardSummary(
  overrides: Partial<ActivitySummary> = {}
): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-08-17",
    generatedAt: "2026-08-17T00:00:00.000Z",
    activityLevel: "none",
    dominantTheme: "quiet",
    projects: [],
    commitSignals: {
      totalCommits: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      subjects: [],
      themes: []
    },
    uncommittedChanges: {
      totalFiles: 0,
      byStatus: {
        modified: 0,
        added: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        untracked: 0,
        other: 0
      },
      files: []
    },
    manualContext: { noteCount: 0, notes: [] },
    smallWins: [],
    blockersOrConfusion: [],
    unfinishedThreads: [],
    possibleJokes: [],
    publicSafetyNotes: [],
    privateItemsToAvoid: [],
    uncertaintyNotes: [],
    ...overrides
  };
}

function testCandidates() {
  return listStoryCardCandidateProjections(createStoryCardSummary());
}

// Copied from tests/reflection.test.ts (signal()), specialized to override
// only the note text so it exercises the same (kind, note) merge key logic.
function signalMatching(note: string): ActivitySignal {
  return {
    projectId: "p1",
    timestamp: "2026-08-30T09:00:00.000Z",
    kind: "commit",
    summary: note,
    safetyNotes: []
  };
}

// ---------------------------------------------------------------------------
// Day-shape fixtures.
//
// The brief's original baseInput() (gitEvents: [], manualNotes: []) is a
// *quiet* day: activityLevel would be "none" for every scenario that used it
// unmodified. That collapsed "반복 있는 날" and "반복 없는 날" into the same
// quiet-day case as "조용한 날" and never exercised the active-day path
// (controller-ruled defect in the brief, task-7 ambiguity resolution #1).
// baseInput() is now reserved for the quiet-day scenario alone; the other two
// scenarios use activeInput(), which adds one manual note so activityLevel is
// not "none" (score = manualNotes.length * 2 = 2 -> "low", see
// classifyActivityLevel in src/activity-summary.ts).
// ---------------------------------------------------------------------------

function baseInput(): ActivitySummaryInput {
  return {
    targetDate: "2026-08-30",
    generatedAt: "2026-08-30T10:00:00.000Z",
    gitEvents: [],
    manualNotes: []
  };
}

function activeManualNote(overrides: Partial<ManualNoteEvent> = {}): ManualNoteEvent {
  return {
    schemaVersion: 1,
    id: "note-1",
    timestamp: "2026-08-30T09:00:00.000Z",
    date: "2026-08-30",
    projectId: "uncommitted",
    text: "Reviewed the onboarding docs.",
    source: "manual",
    ...overrides
  };
}

function activeInput(): ActivitySummaryInput {
  return {
    ...baseInput(),
    manualNotes: [activeManualNote()]
  };
}

function thread(overrides: Partial<MemoryThread> = {}): MemoryThread {
  return {
    id: "bug:flaky",
    firstSeen: "2026-08-25T00:00:00.000Z",
    lastSeen: "2026-08-30T00:00:00.000Z",
    kind: "bug",
    note: "flaky timeout again",
    status: "active",
    decay: 1,
    ...overrides
  };
}

describe("UNC-229 통합: 반복 있는 날 / 없는 날 / 조용한 날", () => {
  describe("반복 스레드가 있는 날", () => {
    const summary = buildActivitySummary({
      ...activeInput(),
      memoryThreads: [thread({ occurrenceCount: 3 })]
    });

    it("is an active day, not a quiet one", () => {
      // Locks in the brief-defect fix: this scenario must actually exercise
      // the non-quiet path, or it is indistinguishable from "조용한 날".
      expect(summary.activityLevel).not.toBe("none");
    });

    it("carries the cumulative fact all the way into the summary", () => {
      expect(summary.recurringThreads).toEqual([
        {
          note: "flaky timeout again",
          occurrenceCount: 3,
          lastSeenDate: "2026-08-30"
        }
      ]);
    });

    it("puts the four constraint sentences into both the caption and the card prompt", () => {
      const caption = buildCaptionInstructions({
        quiet: false,
        persona: testPersona(),
        moodPlan: testMoodPlan(),
        recurringThreads: summary.recurringThreads
      });
      const cards = buildStoryCardInstructions({
        quiet: false,
        cardCount: 4,
        candidates: testCandidates(),
        recurringThreads: summary.recurringThreads
      });

      for (const sentence of [
        RECURRING_THREAD_INSTRUCTIONS.useCumulative,
        RECURRING_THREAD_INSTRUCTIONS.noInventedCount,
        RECURRING_THREAD_INSTRUCTIONS.noStreak,
        RECURRING_THREAD_INSTRUCTIONS.notNewMaterial
      ]) {
        expect(caption).toContain(sentence);
        expect(cards).toContain(sentence);
      }
    });

    it("keeps the recurring item in the flattened slots too (결정 ④(a) 중복 허용)", () => {
      expect(summary.unfinishedThreads).toContain("flaky timeout again");
    });
  });

  describe("반복 스레드가 없는 날", () => {
    const summary = buildActivitySummary({
      ...activeInput(),
      memoryThreads: [thread({ occurrenceCount: 1 })]
    });

    it("is an active day", () => {
      expect(summary.activityLevel).not.toBe("none");
    });

    it("produces no recurring threads", () => {
      expect(summary.recurringThreads ?? []).toEqual([]);
    });

    it("leaves both prompts byte-identical to the no-recurrence baseline (AC2)", () => {
      expect(
        buildCaptionInstructions({
          quiet: false,
          persona: testPersona(),
          moodPlan: testMoodPlan(),
          recurringThreads: summary.recurringThreads
        })
      ).toBe(
        buildCaptionInstructions({
          quiet: false,
          persona: testPersona(),
          moodPlan: testMoodPlan()
        })
      );

      expect(
        buildStoryCardInstructions({
          quiet: false,
          cardCount: 4,
          candidates: testCandidates(),
          recurringThreads: summary.recurringThreads
        })
      ).toBe(
        buildStoryCardInstructions({
          quiet: false,
          cardCount: 4,
          candidates: testCandidates()
        })
      );
    });
  });

  describe("조용한 날 (활동 없음 + 반복 스레드 있음)", () => {
    const summary = buildActivitySummary({
      ...baseInput(),
      memoryThreads: [thread({ occurrenceCount: 4 })]
    });

    it("is a quiet day", () => {
      expect(summary.activityLevel).toBe("none");
    });

    it("never lets the recurring thread become grounds for invented activity (AC5)", () => {
      const caption = buildCaptionInstructions({
        quiet: true,
        persona: testPersona(),
        moodPlan: testMoodPlan(),
        recurringThreads: summary.recurringThreads
      });
      const cards = buildStoryCardInstructions({
        quiet: true,
        cardCount: 4,
        candidates: testCandidates(),
        recurringThreads: summary.recurringThreads
      });

      expect(caption).toContain("Do not invent work.");
      expect(cards).toContain("Do not manufacture activity to fill the cards.");
      // 그리고 횟수 조작 금지도 함께 실려 있다
      expect(caption).toContain(RECURRING_THREAD_INSTRUCTIONS.noInventedCount);
      expect(cards).toContain(RECURRING_THREAD_INSTRUCTIONS.noInventedCount);
    });
  });
});

describe("UNC-229 회귀: memory-safety-gate (AC3)", () => {
  it("passes a thread carrying occurrenceCount through the gate unchanged", () => {
    const gated = gateThreadForInjection(thread({ occurrenceCount: 5 }));

    expect(gated).not.toBeNull();
    expect(gated?.occurrenceCount).toBe(5);
    expect(gated?.note).toBe("flaky timeout again");
  });

  it("still redacts the note exactly as before, preserving the new scalar field", () => {
    // The brief's sample "sk-live-abcdefghijklmnopqrstuvwxyz" matches the
    // `secret` detection rule in src/safety-report.ts, whose severity is
    // "blocked" — gateThreadForInjection returns null for a blocked note, so
    // `gatedWith?.occurrenceCount` would be undefined and this test would
    // fail for the wrong reason (or vacuously pass if written loosely). The
    // point of this test is a *redacted-but-not-dropped* ("warning") note, so
    // it uses the email pattern tests/memory-safety-gate.test.ts already
    // proves lands as "warning" (WARNING_NOTE there).
    const withPii = thread({
      note: "flaky timeout again, emailed alice@example.com about it",
      occurrenceCount: 2
    });
    const gatedWithout = gateThreadForInjection({
      ...withPii,
      occurrenceCount: undefined
    });
    const gatedWith = gateThreadForInjection(withPii);

    expect(gatedWith).not.toBeNull();
    expect(gatedWith?.note).toContain("[redacted-email]");
    expect(gatedWith?.note.includes("alice@example.com")).toBe(false);
    // 새 스칼라 필드가 redact 결과를 바꾸지 않는다
    expect(gatedWith?.note).toBe(gatedWithout?.note);
    expect(gatedWith?.occurrenceCount).toBe(2);
  });
});

describe("UNC-229 회귀: 저장 포맷 하위 호환", () => {
  it("still accepts a stored v1 activity-summary.json", () => {
    const v1: Record<string, unknown> = {
      ...buildActivitySummary(baseInput()),
      schemaVersion: 1
    };
    delete v1.recurringThreads;

    expect(isActivitySummary(v1)).toBe(true);
  });

  it("carries a legacy thread (no occurrenceCount) to 2 after one later-day signal", () => {
    // signalThreadKind classifies "flaky timeout again" as "running-joke"
    // (the JOKE_PATTERN "\bagain\b" match in src/reflection.ts), not "bug".
    // reflectThreads merges by the (kind, note) key, so a legacy thread whose
    // `kind` doesn't match would silently create a *second* thread instead of
    // merging into the first — the exact hazard Task 2 hit (task-7 brief,
    // ambiguity resolution #4). The explicit length assertion below is what
    // catches that: without it, an accidental non-merge would still leave
    // `occurrenceCount` at 2 on the *new* thread and pass for the wrong
    // reason.
    const legacy = thread({
      kind: "running-joke",
      lastSeen: "2026-08-29T00:00:00.000Z"
    });
    delete (legacy as { occurrenceCount?: number }).occurrenceCount;

    const merged = reflectThreads({
      threads: [legacy],
      signals: [signalMatching("flaky timeout again")],
      now: new Date("2026-08-30T09:00:00.000Z")
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.occurrenceCount).toBe(2);
  });
});
