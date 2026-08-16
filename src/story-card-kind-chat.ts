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

// 슬롯 한계값(UNC-259): 말풍선은 줄마다 여백을 먹으므로 6줄이 상한.
// UNC-235에서 재조정될 수 있다.
const chatSlots = {
  messages: { type: "lines", required: true, maxLines: 6, maxLength: 60 }
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

    return {
      messages: fitSlotLines(
        firstMeaningfulLines(material, ["오늘은 쉬어가는 날", "내일 다시"]),
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
