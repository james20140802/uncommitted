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

const modalStyles = `
    .modal-scrim {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.4em;
      border-radius: 0.4em;
      background: repeating-linear-gradient(
        135deg,
        rgba(15, 23, 42, 0.12),
        rgba(15, 23, 42, 0.12) 10px,
        rgba(15, 23, 42, 0.06) 10px,
        rgba(15, 23, 42, 0.06) 20px
      );
    }

    .modal-dialog {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.7em;
      padding: 1.3em 1.4em;
      border-radius: 0.5em;
      background: #ffffff;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28);
    }

    .modal-title {
      margin: 0;
      font-size: 1.35em;
      font-weight: 800;
      line-height: 1.15;
      color: #111827;
      overflow-wrap: anywhere;
    }

    .modal-body {
      margin: 0;
      color: #334155;
      overflow-wrap: anywhere;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.6em;
      margin-top: 0.5em;
    }

    .modal-action {
      padding: 0.5em 1.1em;
      border-radius: 0.3em;
      font-weight: 700;
    }

    .modal-action-primary { background: #0f766e; color: #ffffff; }

    .modal-action-secondary {
      border: 2px solid #cbd5e1;
      color: #475569;
    }
`;

// 슬롯 한계값(UNC-259): 모달 본문은 버튼 두 개를 아래에 두고도 남는
// 높이에서 역산. 버튼 라벨은 짧아야 잘리지 않는다.
// UNC-235에서 재조정될 수 있다.
const modalSlots = {
  title: { type: "text", required: true, maxLength: 32 },
  body: { type: "text", required: true, maxLength: 120 },
  primaryAction: { type: "text", required: true, maxLength: 16 },
  secondaryAction: { type: "text", required: false, maxLength: 16 }
} as const satisfies StoryCardSlotSchema;

export const modalStoryCard: StoryCardDefinition = {
  id: "modal",
  // 조용한 날에도 후보로 남는다 — 반어형 조언 카드의 주 용도가 재료 빈약한 날을 살리는 것이다.
  // 반대로 바쁜데 blocker·미완 스레드가 없는 날에는 후보에서 빠진다.
  requires: (summary) =>
    summary.blockersOrConfusion.length > 0 ||
    summary.unfinishedThreads.length > 0 ||
    summary.activityLevel === "none" ||
    summary.activityLevel === "low",
  slots: modalSlots,
  buildDefaultSlots({ summary }) {
    const body =
      firstMeaningfulText(
        summary.blockersOrConfusion[0],
        summary.unfinishedThreads[0]
      ) ?? "오늘은 쉬어가는 날입니다. 내일의 나에게 넘깁니다.";

    return {
      title: fitSlotText("알림", modalSlots.title),
      body: fitSlotText(body, modalSlots.body),
      primaryAction: fitSlotText("확인", modalSlots.primaryAction),
      secondaryAction: fitSlotText("나중에", modalSlots.secondaryAction)
    };
  },
  render(slots: StoryCardSlots, chrome: StoryCardChrome): string {
    const title = escapeHtml(readSlotText(slots, "title").trim());
    const body = escapeHtml(readSlotText(slots, "body").trim());
    const primary = escapeHtml(readSlotText(slots, "primaryAction").trim());
    const secondary = escapeHtml(readSlotText(slots, "secondaryAction").trim());

    const secondaryHtml = secondary
      ? `          <div class="modal-action modal-action-secondary">${secondary}</div>\n`
      : "";

    return renderStoryCardDocument({
      kindId: "modal",
      title: readSlotText(slots, "title").trim(),
      stageStyles: modalStyles,
      stageHtml: `    <div class="modal-scrim">
      <div class="modal-dialog">
        <p class="modal-title">${title}</p>
        <p class="modal-body">${body}</p>
        <div class="modal-actions">
${secondaryHtml}          <div class="modal-action modal-action-primary">${primary}</div>
        </div>
      </div>
    </div>`,
      chrome
    });
  }
};
