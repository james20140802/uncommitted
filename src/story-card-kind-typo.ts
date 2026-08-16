import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import { readSlotText, type StoryCardDefinition, type StoryCardSlots } from "./story-card-slots.js";

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

export const typoStoryCard: StoryCardDefinition = {
  id: "typo",
  requires: () => true,
  // 슬롯 한계값(UNC-259): headline은 2.6em 대형 타이포라 4:5 카드 폭에서
  // 두 줄을 넘기지 않는 선이 이 정도다. UNC-235에서 렌더 경로가 배선되면
  // 실측으로 재조정될 가능성이 가장 높은 수치다.
  slots: {
    headline: { type: "text", required: true, maxLength: 40 },
    kicker: { type: "text", required: false, maxLength: 24 }
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
