import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  readSlotText,
  type StoryCardDefinition,
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

export const modalStoryCard: StoryCardDefinition = {
  id: "modal",
  requires: (summary) =>
    summary.blockersOrConfusion.length > 0 || summary.unfinishedThreads.length > 0,
  slots: {
    title: { type: "text", required: true },
    body: { type: "text", required: true },
    primaryAction: { type: "text", required: true },
    secondaryAction: { type: "text", required: false }
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
