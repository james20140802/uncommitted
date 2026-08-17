import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import { TYPO_FALLBACK_HEADLINE } from "../src/story-card-kind-typo.js";
import {
  STORY_CARD_VIOLATIONS,
  assembleStoryCardPlan,
  type StoryCardEntryOutcome
} from "../src/story-card-plan.js";
import { storyCardRegistry } from "../src/story-card-registry.js";
import type { StoryCardDefinition } from "../src/story-card-slots.js";

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

  // UNC-263 T5 리뷰 반영 (finding 4): 레지스트리 전체가 아니라 그날의
  // 후보(requires() === true)에서만 degrade 대상을 찾는다. T2가 오늘의
  // 후보가 아니라는 이유로 이미 거부한 종류를, 조립 단계가 그 이유를
  // 무시하고 되살려서는 안 된다 — "없는 활동을 지어내지 않는다" 원칙과도
  // 충돌한다.
  it("drops a rejected card whose kind is not among today's candidates instead of degrading it", () => {
    const quietSummary = createSummary(); // commitSignals.filesChanged: 0 → diff.requires()는 오늘 false

    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo"), rejected(1, "diff")],
      summary: quietSummary
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].source).toBe("generated");
    expect(plan.cards[0].type).toBe("typo");
  });

  const brokenDefaultsKind: StoryCardDefinition = {
    id: "broken-defaults",
    requires: () => true,
    slots: { headline: { type: "text", required: true, maxLength: 40 } },
    // 일부러 자기 스키마를 어기는 기본값 — required text 슬롯을 빈 문자열로 채운다.
    buildDefaultSlots: () => ({ headline: "" }),
    render: () => ""
  };

  // UNC-263 T5 리뷰 반영 (finding 3): 이 케이스를 지우면 degradeToDefaults의
  // 재검증 호출을 지워도 테스트가 안 터진다 — 그래서 재검증이 실제로
  // 하는 일(자기 스키마를 어기는 기본값을 가진 카드를 버리는 것)을 직접 본다.
  it("drops a rejected card whose registered kind's own defaults fail re-validation", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo"), rejected(1, "broken-defaults")],
      summary: createSummary(),
      registry: [...storyCardRegistry, brokenDefaultsKind]
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].source).toBe("generated");
    expect(plan.cards[0].type).toBe("typo");
  });

  const throwingDefaultsKind: StoryCardDefinition = {
    id: "throws-on-defaults",
    requires: () => true,
    slots: { headline: { type: "text", required: true, maxLength: 40 } },
    buildDefaultSlots: () => {
      throw new Error("buildDefaultSlots boom");
    },
    render: () => ""
  };

  // UNC-263 T5 리뷰 반영 (finding 2): 기본값 생성이 던지는 예외가 카드 하나의
  // 실패로 끝나야 한다 — 계획 전체를 죽여서는 안 된다는 이 태스크의 목적과
  // 직결된다.
  it("drops a card whose buildDefaultSlots throws instead of letting the plan crash", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [accepted(0, "typo"), rejected(1, "throws-on-defaults")],
      summary: createSummary(),
      registry: [...storyCardRegistry, throwingDefaultsKind]
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].source).toBe("generated");
    expect(plan.cards[0].type).toBe("typo");
  });

  const brokenTypoKind: StoryCardDefinition = {
    id: "typo",
    requires: () => true,
    slots: { headline: { type: "text", required: true, maxLength: 40 } },
    // typo 자신의 기본값 생성마저 자기 스키마를 어기는, 최악의 시나리오.
    buildDefaultSlots: () => ({ headline: "" }),
    render: () => ""
  };

  // UNC-263 T5 리뷰 반영 (finding 1c): typo의 기본값 생성조차 재검증에
  // 실패해도, 승인된 고정 문구로 만든 카드 1장은 반드시 남아야 한다 —
  // 부모 AC5가 요구하는 "그날의 최후의 한 장"은 실패할 수 있는 코드에
  // 기대지 않는다.
  it("still yields exactly one valid typo card from the fixed constant when typo's own defaults fail re-validation", () => {
    const plan = assembleStoryCardPlan({
      outcomes: [],
      summary: createSummary(),
      registry: [brokenTypoKind]
    });

    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0].type).toBe("typo");
    expect(plan.cards[0].source).toBe("fallback");
    expect(plan.cards[0].slots.headline).toBe(TYPO_FALLBACK_HEADLINE);
  });
});
