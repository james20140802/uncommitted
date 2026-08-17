import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  firstMeaningfulText,
  fitSlotLines,
  fitSlotText,
  readSlotLines,
  readSlotText,
  type StoryCardDefinition,
  type StoryCardSlotSchema,
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

// 슬롯 한계값(UNC-259): added/removed가 스테이지를 나눠 쓰므로 각각
// 5줄, 등폭 폭에서 줄 길이를 역산. UNC-235에서 재조정될 수 있다.
const diffSlots = {
  filename: { type: "text", required: true, maxLength: 48 },
  added: { type: "lines", required: false, maxLines: 5, maxLength: 56 },
  removed: { type: "lines", required: false, maxLines: 5, maxLength: 56 }
} as const satisfies StoryCardSlotSchema;

export const diffStoryCard: StoryCardDefinition = {
  id: "diff",
  requires: (summary) => summary.commitSignals.filesChanged > 0,
  slots: diffSlots,
  buildDefaultSlots({ summary }) {
    return {
      filename: fitSlotText(
        firstMeaningfulText(summary.commitSignals.subjects[0]) ?? "오늘의 변경",
        diffSlots.filename
      ),
      added: fitSlotLines(summary.smallWins, diffSlots.added),
      removed: fitSlotLines(summary.unfinishedThreads, diffSlots.removed)
    };
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
