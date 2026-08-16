import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  fitSlotLines,
  fitSlotText,
  readSlotLines,
  readSlotText,
  type StoryCardDefinition,
  type StoryCardSlotSchema,
  type StoryCardSlots
} from "./story-card-slots.js";

const checkboardStyles = `
    .checkboard {
      display: flex;
      flex-direction: column;
      gap: 0.75em;
    }

    .checkboard-heading {
      margin: 0 0 0.3em;
      font-size: 1.3em;
      font-weight: 800;
      color: #111827;
      overflow-wrap: anywhere;
    }

    .checkboard-item {
      display: flex;
      align-items: flex-start;
      gap: 0.7em;
      padding: 0.55em 0.7em;
      border-radius: 0.3em;
      background: #ffffff;
      border: 2px solid #e2e8f0;
      overflow-wrap: anywhere;
    }

    .checkboard-box {
      flex: none;
      width: 1.15em;
      height: 1.15em;
      border-radius: 0.2em;
      border: 2px solid #94a3b8;
      text-align: center;
      line-height: 1.05em;
      font-weight: 800;
    }

    .checkboard-item[data-checked="true"] .checkboard-box {
      background: #0f766e;
      border-color: #0f766e;
      color: #ffffff;
    }

    .checkboard-item[data-checked="true"] .checkboard-label {
      color: #475569;
      text-decoration: line-through;
    }

    .checkboard-label { color: #1f2937; }
`;

function renderItems(lines: string[], checked: boolean): string {
  return lines
    .map(
      (line) => `      <div class="checkboard-item" data-checked="${checked ? "true" : "false"}">
        <span class="checkboard-box">${checked ? "✓" : ""}</span>
        <span class="checkboard-label">${escapeHtml(line)}</span>
      </div>`
    )
    .join("\n");
}

// 슬롯 한계값(UNC-259): 체크박스 목록은 done+todo가 한 스테이지를
// 나눠 쓰므로 각각 5줄까지. UNC-235에서 재조정될 수 있다.
const checkboardSlots = {
  heading: { type: "text", required: true, maxLength: 32 },
  done: { type: "lines", required: false, maxLines: 5, maxLength: 40 },
  todo: { type: "lines", required: false, maxLines: 5, maxLength: 40 }
} as const satisfies StoryCardSlotSchema;

export const checkboardStoryCard: StoryCardDefinition = {
  id: "checkboard",
  requires: (summary) =>
    summary.smallWins.length > 0 || summary.unfinishedThreads.length > 0,
  slots: checkboardSlots,
  buildDefaultSlots({ summary }) {
    return {
      heading: fitSlotText("오늘의 체크리스트", checkboardSlots.heading),
      done: fitSlotLines(
        summary.smallWins.length > 0 ? summary.smallWins : ["오늘은 쉬어가는 날"],
        checkboardSlots.done
      ),
      todo: fitSlotLines(summary.unfinishedThreads, checkboardSlots.todo)
    };
  },
  render(slots: StoryCardSlots, chrome: StoryCardChrome): string {
    const heading = escapeHtml(readSlotText(slots, "heading").trim());
    const doneHtml = renderItems(readSlotLines(slots, "done"), true);
    const todoHtml = renderItems(readSlotLines(slots, "todo"), false);
    const itemsHtml = [doneHtml, todoHtml].filter((part) => part.length > 0).join("\n");

    return renderStoryCardDocument({
      kindId: "checkboard",
      title: readSlotText(slots, "heading").trim(),
      stageStyles: checkboardStyles,
      stageHtml: `    <div class="checkboard">
      <p class="checkboard-heading">${heading}</p>
${itemsHtml}
    </div>`,
      chrome
    });
  }
};
