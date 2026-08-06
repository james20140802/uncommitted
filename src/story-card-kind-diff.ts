import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  readSlotLines,
  readSlotText,
  type StoryCardDefinition,
  type StoryCardSlots
} from "./story-card-slots.js";

const diffStyles = `
    .diff {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
      padding: 1em 1.1em;
      border-radius: 0.4em;
      background: #ffffff;
      border: 2px solid #e2e8f0;
      font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
      line-height: 1.4;
      overflow: hidden;
    }

    .diff-filename {
      margin: 0 0 0.35em;
      font-weight: 800;
      color: #475569;
      overflow-wrap: anywhere;
    }

    .diff-line {
      display: flex;
      gap: 0.6em;
      padding: 0.25em 0.5em;
      border-radius: 0.2em;
      overflow-wrap: anywhere;
    }

    .diff-line[data-diff="added"] { background: #dcfce7; color: #14532d; }
    .diff-line[data-diff="removed"] { background: #fee2e2; color: #7f1d1d; }

    .diff-marker { flex: none; font-weight: 800; }
`;

function renderDiffLines(lines: string[], kind: "added" | "removed"): string {
  const marker = kind === "added" ? "+" : "-";

  return lines
    .map(
      (line) => `      <div class="diff-line" data-diff="${kind}">
        <span class="diff-marker">${marker}</span>
        <span class="diff-text">${escapeHtml(line)}</span>
      </div>`
    )
    .join("\n");
}

export const diffStoryCard: StoryCardDefinition = {
  id: "diff",
  requires: (summary) => summary.commitSignals.filesChanged > 0,
  slots: {
    filename: { type: "text", required: true },
    added: { type: "lines", required: false },
    removed: { type: "lines", required: false }
  },
  render(slots: StoryCardSlots, chrome: StoryCardChrome): string {
    const filename = escapeHtml(readSlotText(slots, "filename").trim());
    const removedHtml = renderDiffLines(readSlotLines(slots, "removed"), "removed");
    const addedHtml = renderDiffLines(readSlotLines(slots, "added"), "added");
    const linesHtml = [removedHtml, addedHtml]
      .filter((part) => part.length > 0)
      .join("\n");

    return renderStoryCardDocument({
      kindId: "diff",
      title: readSlotText(slots, "filename").trim(),
      stageStyles: diffStyles,
      stageHtml: `    <div class="diff">
      <p class="diff-filename">${filename}</p>
${linesHtml}
    </div>`,
      chrome
    });
  }
};
