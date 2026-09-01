import { describe, expect, it } from "vitest";

import { ARCHITECTURE_DISCLOSURE_REPLACEMENT } from "../src/architecture-disclosure.js";
import { buildCaptionCardGist } from "../src/caption-card-gist.js";
import type { StoryCardPlan, StoryCardPlanCardSource } from "../src/story-card-plan.js";

function planOf(
  cards: {
    type: string;
    slots: Record<string, string | string[]>;
    source?: StoryCardPlanCardSource;
  }[]
): StoryCardPlan {
  return {
    schemaVersion: 1,
    cards: cards.map((card) => ({
      type: card.type,
      slots: card.slots,
      source: card.source ?? ("generated" as const)
    }))
  };
}

describe("buildCaptionCardGist (UNC-236)", () => {
  it("카드 종류와 실제 문구 줄만 남기고 슬롯 이름은 싣지 않는다", () => {
    const gist = buildCaptionCardGist(
      planOf([
        {
          type: "modal",
          slots: {
            headline: "좋은 UX 팁 ①",
            lines: ["사용자가 입력하는 중에", "모달을 띄우세요"]
          }
        }
      ])
    );

    expect(gist).toEqual([
      {
        cardType: "modal",
        lines: ["좋은 UX 팁 ①", "사용자가 입력하는 중에", "모달을 띄우세요"]
      }
    ]);
    expect(JSON.stringify(gist)).not.toContain("headline");
  });

  it("빈 줄과 공백뿐인 줄을 버린다", () => {
    const gist = buildCaptionCardGist(
      planOf([{ type: "typo", slots: { headline: "  ", lines: ["", "  ", "살아남은 줄"] } }])
    );

    expect(gist).toEqual([{ cardType: "typo", lines: ["살아남은 줄"] }]);
  });

  it("문구가 하나도 남지 않는 카드는 결과에서 제외한다", () => {
    const gist = buildCaptionCardGist(
      planOf([
        { type: "typo", slots: { headline: "   " } },
        { type: "chat", slots: { turns: ["말이 남은 카드"] } }
      ])
    );

    expect(gist).toEqual([{ cardType: "chat", lines: ["말이 남은 카드"] }]);
  });

  it("아키텍처 폭로 문구를 캡션 입력에 넘기기 전에 지운다", () => {
    const gist = buildCaptionCardGist(
      planOf([
        {
          type: "terminal",
          slots: { lines: ["the route guard let it through again"] }
        }
      ])
    );

    const joined = gist.flatMap((card) => card.lines).join(" ");
    expect(joined).not.toContain("route guard");
    expect(joined).toContain(ARCHITECTURE_DISCLOSURE_REPLACEMENT);
  });

  it("계획이 없거나 카드가 없으면 빈 배열을 돌려준다", () => {
    expect(buildCaptionCardGist(undefined)).toEqual([]);
    expect(buildCaptionCardGist({ schemaVersion: 1, cards: [] })).toEqual([]);
  });

  it("fallback 카드만 있는 날은 빈 배열을 돌려준다 (고정 문구는 농담을 지지 않는다)", () => {
    const gist = buildCaptionCardGist(
      planOf([
        {
          type: "typo",
          slots: { headline: "오늘은 쉬어가는 날" },
          source: "fallback"
        }
      ])
    );

    expect(gist).toEqual([]);
  });

  it("generated·degraded 카드는 남기고 fallback 카드만 제외한다", () => {
    const gist = buildCaptionCardGist(
      planOf([
        {
          type: "modal",
          slots: { headline: "좋은 UX 팁 ①" },
          source: "generated"
        },
        {
          type: "chat",
          slots: { turns: ["말이 남은 카드"] },
          source: "degraded"
        },
        {
          type: "typo",
          slots: { headline: "오늘은 쉬어가는 날" },
          source: "fallback"
        }
      ])
    );

    expect(gist).toEqual([
      { cardType: "modal", lines: ["좋은 UX 팁 ①"] },
      { cardType: "chat", lines: ["말이 남은 카드"] }
    ]);
  });
});
