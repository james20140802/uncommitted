import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  firstMeaningfulLines,
  fitSlotLines,
  readSlotLines,
  type StoryCardDefinition,
  type StoryCardSlotSchema,
  type StoryCardSlots
} from "./story-card-slots.js";

const chatStyles = `
    .chat {
      display: flex;
      flex-direction: column;
      gap: 0.75em;
    }

    .chat-row { display: flex; }
    .chat-row[data-side="left"] { justify-content: flex-start; }
    .chat-row[data-side="right"] { justify-content: flex-end; }

    .chat-bubble {
      max-width: 78%;
      display: flex;
      flex-direction: column;
      gap: 0.25em;
      padding: 0.6em 0.85em;
      border-radius: 0.9em;
      background: #ffffff;
      border: 2px solid #e2e8f0;
      overflow-wrap: anywhere;
    }

    .chat-row[data-side="right"] .chat-bubble {
      background: #0f766e;
      border-color: #0f766e;
      color: #ffffff;
    }

    .chat-speaker {
      font-size: 0.72em;
      font-weight: 800;
      letter-spacing: 0.03em;
      color: #64748b;
    }

    .chat-row[data-side="right"] .chat-speaker { color: #99f6e4; }

    .chat-message { color: inherit; }
`;

function splitMessage(line: string): { speaker: string; message: string } {
  const match = /:\s/.exec(line);
  if (!match) {
    return { speaker: "", message: line.trim() };
  }

  const separator = match.index;
  return {
    speaker: line.slice(0, separator).trim(),
    message: line.slice(separator + 1).trim()
  };
}

// 슬롯 한계값(UNC-259, UNC-235에서 실측 재조정): 원래 6줄은 실측 전
// 추정치였다. Playwright로 재보니 60자 6줄을 채우면 base fit에서
// .card-stage보다 207px 더 커서 넘친다 — 그동안 렌더 경로가 배선되지
// 않아 아무도 이 값을 실제로 그려보지 않았다. 4줄은 base fit에서
// 209px의 실제 여유를 두고 들어간다(tests/carousel-renderer-smoke
// .test.ts로 실측).
const chatSlots = {
  messages: { type: "lines", required: true, maxLines: 4, maxLength: 60 }
} as const satisfies StoryCardSlotSchema;

export const chatStoryCard: StoryCardDefinition = {
  id: "chat",
  requires: (summary) => summary.manualContext.noteCount > 0,
  slots: chatSlots,
  buildDefaultSlots({ summary }) {
    const material = [
      ...summary.possibleJokes,
      ...summary.smallWins,
      ...summary.unfinishedThreads
    ];

    // PR #137 리뷰 반영: chat은 noteCount > 0일 때만 후보라, degrade가
    // 도는 날에는 반드시 메모가 기록돼 있다. 분류되지 않은 메모뿐인 날
    // "쉬어가는 날" 고정 문구를 내보내면 기록된 활동과 모순되는 하루를
    // 지어내게 되므로, 실제 기록(메모 수)에서 파생한 문구로 떨어진다.
    return {
      messages: fitSlotLines(
        firstMeaningfulLines(material, [
          `오늘 남긴 메모 ${summary.manualContext.noteCount}건`,
          "정리는 내일의 나에게"
        ]),
        chatSlots.messages
      )
    };
  },
  render(slots: StoryCardSlots, chrome: StoryCardChrome): string {
    const rows = readSlotLines(slots, "messages").map((line, index) => {
      const { speaker, message } = splitMessage(line);
      const side = index % 2 === 0 ? "left" : "right";
      const speakerHtml = speaker
        ? `          <span class="chat-speaker">${escapeHtml(speaker)}</span>\n`
        : "";

      return `      <div class="chat-row" data-side="${side}">
        <div class="chat-bubble">
${speakerHtml}          <span class="chat-message">${escapeHtml(message)}</span>
        </div>
      </div>`;
    });

    return renderStoryCardDocument({
      kindId: "chat",
      title: "chat",
      stageStyles: chatStyles,
      stageHtml: `    <div class="chat">
${rows.join("\n")}
    </div>`,
      chrome
    });
  }
};
