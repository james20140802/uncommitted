import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import { createCarouselHtmlCards, parseCarouselRenderInput } from "../src/carousel-renderer.js";
import { findStoryCardKind, storyCardRegistry } from "../src/story-card-registry.js";

// tests/story-card-defaults.test.ts의 createSummary() 픽스처를 그대로
// 가져온다 — "quiet" 인자 없이 부르면 그 파일의 quiet 케이스와 동일한
// 최소 ActivitySummary가 된다.
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

const quietSummary = createSummary();

describe("findStoryCardKind (UNC-266)", () => {
  it("resolves every registered kind id to its definition", () => {
    for (const kind of storyCardRegistry) {
      expect(findStoryCardKind(kind.id)?.id).toBe(kind.id);
    }
  });

  it("returns undefined for an unknown id", () => {
    expect(findStoryCardKind("no-such-kind")).toBeUndefined();
  });
});

const story = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  targetDate: "2026-08-22",
  slides: [
    { index: 1, title: "첫 장", body: "본문 하나", visualMood: "calm" },
    { index: 2, title: "둘째 장", body: "본문 둘", visualMood: "warm" }
  ],
  ...overrides
});

describe("storyCardPlan preservation (UNC-266 AC1)", () => {
  it("keeps storyCardPlan on the parsed render input", () => {
    const plan = {
      schemaVersion: 1 as const,
      cards: [{ type: "typo", slots: { headline: "지나간 하루" }, source: "generated" as const }]
    };

    expect(parseCarouselRenderInput(story({ storyCardPlan: plan }))).toMatchObject({
      storyCardPlan: plan
    });
  });

  it("leaves storyCardPlan undefined when story.json has none", () => {
    expect(parseCarouselRenderInput(story()).storyCardPlan).toBeUndefined();
  });
});

const sixSlides = Array.from({ length: 6 }, (_, index) => ({
  index: index + 1,
  title: `장 ${index + 1}`,
  body: `본문 ${index + 1}`,
  visualMood: "calm"
}));

describe("story-card registry dispatch (UNC-266 AC2/AC3/AC4)", () => {
  it("renders each of the six registered kinds through its own renderer", () => {
    const plan = {
      schemaVersion: 1,
      cards: storyCardRegistry.map((kind) => ({
        type: kind.id,
        slots: kind.buildDefaultSlots({ summary: quietSummary }),
        source: "generated"
      }))
    };

    const cards = createCarouselHtmlCards(
      { schemaVersion: 1, targetDate: "2026-08-22", slides: sixSlides, storyCardPlan: plan },
      { visualStyle: "story-card" }
    );

    expect(cards).toHaveLength(6);

    for (const [index, kind] of storyCardRegistry.entries()) {
      // 각 카드 종류의 render()는 renderStoryCardDocument에 자기 kindId를
      // 넘긴다 — data-kind 속성이 그 종류가 실제로 돌았다는 증거다.
      expect(cards[index].html).toContain(`data-story-card-kind="${kind.id}"`);
    }
  });

  it("fills missing cards from the slide itself when the plan is shorter than slides", () => {
    const plan = {
      schemaVersion: 1,
      cards: [{ type: "typo", slots: { headline: "계획된 한 장" }, source: "generated" }]
    };

    const cards = createCarouselHtmlCards(
      { schemaVersion: 1, targetDate: "2026-08-22", slides: sixSlides, storyCardPlan: plan },
      { visualStyle: "story-card" }
    );

    expect(cards).toHaveLength(6);
    expect(cards[0].html).toContain("계획된 한 장");
    // 부족분은 그 슬라이드 제목에서 파생된 typo 카드
    expect(cards[1].html).toContain("data-story-card-kind=\"typo\"");
    expect(cards[1].html).toContain("장 2");
  });

  it("renders default cards for a pre-UNC-233 draft with no plan at all", () => {
    const cards = createCarouselHtmlCards(
      { schemaVersion: 1, targetDate: "2026-08-22", slides: sixSlides },
      { visualStyle: "story-card" }
    );

    expect(cards).toHaveLength(6);
    expect(cards.every((card) => card.html.includes("data-story-card-kind=\"typo\""))).toBe(true);
    expect(cards[3].html).toContain("장 4");
  });
});

// UNC-235 리뷰 반영: story.json의 플랜 슬롯은 계획 검증을 통과한 뒤에도
// redactArchitectureDisclosureFromDraft(diary-generator.ts:212-214)나
// local-path 마스킹처럼 검증 이후 단계에서 다시 길어질 수 있다. 렌더
// 직전에 definition.slots의 선언된 한도로 다시 자르지 않으면, 그 오버사이즈
// 슬롯이 그대로 render()에 들어가 validateRenderedCard의 오버플로 판정을
// 거쳐 render-failed(exit 5)로 이어질 수 있다.
describe("plan slot clamping before render (UNC-235)", () => {
  it("clamps a text slot exceeding its declared maxLength instead of overflowing it into the card", () => {
    // typo.slots.headline.maxLength === 40 (src/story-card-kind-typo.ts).
    const oversizedHeadline = `${"헤".repeat(40)}${"넘친-부분"}`;
    expect(oversizedHeadline.length).toBeGreaterThan(40);

    const plan = {
      schemaVersion: 1,
      cards: [
        { type: "typo", slots: { headline: oversizedHeadline }, source: "generated" }
      ]
    };

    const cards = createCarouselHtmlCards(
      {
        schemaVersion: 1,
        targetDate: "2026-08-22",
        slides: [sixSlides[0]],
        storyCardPlan: plan
      },
      { visualStyle: "story-card" }
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].html).toContain("헤".repeat(40));
    // 잘려 나간 꼬리는 렌더 산출물 어디에도 남지 않는다.
    expect(cards[0].html).not.toContain("넘친-부분");
  });

  it("clamps a lines slot exceeding its declared maxLines instead of overflowing it into the card", () => {
    // chat.slots.messages.maxLines === 4 (src/story-card-kind-chat.ts,
    // re-tuned down from 6 in UNC-235 after the 6-line default was measured
    // to overflow .card-stage by 207px at base fit).
    const fiveMessages = Array.from({ length: 5 }, (_, index) => `메시지 ${index + 1}`);

    const plan = {
      schemaVersion: 1,
      cards: [
        { type: "chat", slots: { messages: fiveMessages }, source: "generated" }
      ]
    };

    const cards = createCarouselHtmlCards(
      {
        schemaVersion: 1,
        targetDate: "2026-08-22",
        slides: [sixSlides[0]],
        storyCardPlan: plan
      },
      { visualStyle: "story-card" }
    );

    expect(cards).toHaveLength(1);
    for (let index = 1; index <= 4; index += 1) {
      expect(cards[0].html).toContain(`메시지 ${index}`);
    }
    // 5번째 줄은 maxLines를 넘어 잘려 나간다.
    expect(cards[0].html).not.toContain("메시지 5");
  });
});
