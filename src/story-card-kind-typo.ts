import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  firstMeaningfulText,
  fitSlotText,
  readSlotText,
  type StoryCardDefinition,
  type StoryCardSlotSchema,
  type StoryCardSlots
} from "./story-card-slots.js";

/**
 * UNC-263 T5 리뷰 반영 (finding 1c): 승인된 최종 고정 문구. 조립 단계
 * (assembleStoryCardPlan)의 최후 안전망이 typo의 buildDefaultSlots를
 * 다시 호출하지 않고 이 상수로 직접 카드를 만든다 — 실패할 수 있는
 * 코드에 기대지 않는 바닥을 보장하기 위해서다. 두 자리에서 같은 리터럴을
 * 중복 선언하지 않도록 이 상수 하나로 공유한다.
 */
export const TYPO_FALLBACK_HEADLINE = "오늘은 쉬어가는 날";

const typoStyles = `
    .typo {
      display: flex;
      flex-direction: column;
      gap: 0.6em;
      justify-content: center;
    }

    .typo-kicker {
      font-size: 0.9em;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #0f766e;
    }

    .typo-headline {
      margin: 0;
      font-size: 2.6em;
      font-weight: 800;
      line-height: 1.02;
      color: #111827;
      overflow-wrap: anywhere;
    }
`;

// 슬롯 한계값(UNC-259): headline은 2.6em 대형 타이포라 4:5 카드 폭에서
// 두 줄을 넘기지 않는 선이 이 정도다. UNC-235에서 렌더 경로가 배선되면
// 실측으로 재조정될 가능성이 가장 높은 수치다.
const typoSlots = {
  headline: { type: "text", required: true, maxLength: 40 },
  kicker: { type: "text", required: false, maxLength: 24 }
} as const satisfies StoryCardSlotSchema;

export const typoStoryCard: StoryCardDefinition = {
  id: "typo",
  requires: () => true,
  slots: typoSlots,
  buildDefaultSlots({ summary }) {
    const headline =
      firstMeaningfulText(summary.possibleJokes[0], summary.smallWins[0]) ??
      TYPO_FALLBACK_HEADLINE;

    return {
      headline: fitSlotText(headline, typoSlots.headline),
      kicker: fitSlotText(summary.targetDate, typoSlots.kicker)
    };
  },
  render(slots: StoryCardSlots, chrome: StoryCardChrome): string {
    const headline = escapeHtml(readSlotText(slots, "headline").trim());
    const kicker = escapeHtml(readSlotText(slots, "kicker").trim());

    const kickerHtml = kicker
      ? `      <div class="typo-kicker">${kicker}</div>\n`
      : "";

    return renderStoryCardDocument({
      kindId: "typo",
      title: readSlotText(slots, "headline").trim(),
      stageStyles: typoStyles,
      stageHtml: `    <div class="typo">
${kickerHtml}      <p class="typo-headline">${headline}</p>
    </div>`,
      chrome
    });
  }
};
