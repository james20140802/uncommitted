import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  firstMeaningfulLines,
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

// 슬롯 한계값(UNC-259, UNC-235에서 실측 재조정): done과 todo가 한
// 스테이지를 나눠 쓰므로, 둘 다 동시에 한도까지 차는 최악의 경우를
// 기준으로 재야 한다. 원래 값(각 5줄)은 실측 전 추정치였고, 실제로는
// base 레이아웃 fit에서 912px 폭 기준 40자짜리 항목이 이미 1줄로
// 꽉 차기 때문에(maxLength를 더 줄여도 줄 수가 줄지 않는다) 카드 높이는
// 사실상 항목 "수"에만 좌우된다. done 5 + todo 5(총 10항목)를 채우면
// .card-stage보다 704px 더 커져 base/tight/compact 세 fit 모두에서
// 넘친다(Playwright로 실측, tests/carousel-renderer-smoke.test.ts).
// done=2 / todo=2(최악의 경우 총 4항목)는 base fit에서 248px의 실제
// 여유를 두고 들어간다 — compact까지 가야만 겨우 맞는 게 아니라, 가장
// 넓은 fit에서부터 여유가 있다.
const checkboardSlots = {
  heading: { type: "text", required: true, maxLength: 32 },
  done: { type: "lines", required: false, maxLines: 2, maxLength: 40 },
  todo: { type: "lines", required: false, maxLines: 2, maxLength: 40 }
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
        firstMeaningfulLines(summary.smallWins, ["오늘은 쉬어가는 날"]),
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
