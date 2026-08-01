import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  readSlotLines,
  type StoryCardDefinition,
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
  const separator = line.indexOf(":");
  if (separator === -1) {
    return { speaker: "", message: line.trim() };
  }

  return {
    speaker: line.slice(0, separator).trim(),
    message: line.slice(separator + 1).trim()
  };
}

export const chatStoryCard: StoryCardDefinition = {
  id: "chat",
  requires: (summary) => summary.manualContext.noteCount > 0,
  slots: {
    messages: { type: "lines", required: true }
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
