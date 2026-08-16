import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  STORY_CARD_VIOLATIONS,
  assembleStoryCardPlan,
  type StoryCardEntryOutcome
} from "../src/story-card-plan.js";

function createSummary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
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

function accepted(cardIndex: number, type: string): StoryCardEntryOutcome {
  return {
    status: "accepted",
    cardIndex,
    entry: { type, slots: { headline: "살아남은 카드" } }
  };
}

function rejected(
  cardIndex: number,
  rawType: string | null
): StoryCardEntryOutcome {
  return {
    status: "rejected",
    cardIndex,
    rawType,
    violations: [
      {
        cardIndex,
        cardType: rawType,
        slot: "headline",
        code: STORY_CARD_VIOLATIONS.textTooLong,
        message: "too long"
      }
    ]
  };
}

describe("assembleStoryCardPlan", () => {
  it("keeps accepted cards as generated", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo")],
      summary: createSummary()
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].source).toBe("generated");
    expect(plan.cards[0].type).toBe("typo");
  });

  it("does not let one failed card take down its siblings", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo"), rejected(1, "modal"), accepted(2, "typo")],
      summary: createSummary()
    });

    expect(plan.cards).toHaveLength(3);
    expect(plan.cards.map((card) => card.source)).toEqual([
      "generated",
      "degraded",
      "generated"
    ]);
  });

  it("degrades a failed card to its own kind's deterministic defaults", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [rejected(0, "modal")],
      summary: createSummary()
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].type).toBe("modal");
    expect(plan.cards[0].source).toBe("degraded");
    expect(plan.cards[0].slots.title).toBeTypeOf("string");
  });

  it("drops a card whose type is not in the registry at all", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo"), rejected(1, "nope")],
      summary: createSummary()
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].source).toBe("generated");
  });

  it("falls back to exactly one typo card when every card fails", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [rejected(0, "nope"), rejected(1, null)],
      summary: createSummary()
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].type).toBe("typo");
    expect(plan.cards[0].source).toBe("fallback");
    expect(String(plan.cards[0].slots.headline).length).toBeGreaterThan(0);
  });

  it("falls back to one typo card when the model returned nothing at all", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [],
      summary: createSummary()
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].source).toBe("fallback");
    expect(plan.cards[0].type).toBe("typo");
  });

  it("produces a serializable plan", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo"), rejected(1, "modal")],
      summary: createSummary()
    });

    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(plan.schemaVersion).toBe(1);
  });
});
