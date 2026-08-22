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

// 슬롯 한계값(UNC-259, UNC-235에서 실측 재조정): 원래 5줄은 줄 길이만
// 등폭 폭에서 역산한 값이고 세로 방향은 실측 전 추정치였다.
// Playwright로 재보니 두 가지가 겹쳐 있었다: (1) added 5 + removed 5를
// 채우면 .diff 요소의 실제 콘텐츠 높이(scrollHeight)가 base fit에서
// 필요한 높이보다 305px 부족했고, (2) .diff는 자기 CSS에 overflow:hidden을
// 두고 있어서 — .card-stage(단일 자식 flex column, justify-content:center)
// 아래에서 flex-shrink가 기본값 1이라 min-height:auto가 0으로 풀리고
// — 넘치는 콘텐츠를 상자 밖으로 밀어내는 대신 상자 **안에서 조용히
// 잘라낸다. 그 결과 .card-stage의 scrollHeight/clientHeight 비교
// (validateRenderedCard가 쓰는 바로 그 검사)는 아무 이상도 감지하지
// 못한다 — 카드가 "성공"으로 렌더되면서 텍스트 일부가 소리 없이
// 사라지는, render-failed보다 더 나쁜 결과다. 그래서 이 한도는
// .diff.scrollHeight를 직접 재서(=클리핑에 흔들리지 않는 진짜 콘텐츠
// 높이) 정했다. added=3/removed=3(최악의 경우 총 6줄)은 base fit에서
// 160px의 실제 여유를 두고 들어간다(tests/carousel-renderer-smoke
// .test.ts로 실측). overflow:hidden + flex-shrink 조합 자체는 이
// 이슈 범위 밖이라 손대지 않았다 — 별도로 보고한다.
const diffSlots = {
  filename: { type: "text", required: true, maxLength: 48 },
  added: { type: "lines", required: false, maxLines: 3, maxLength: 56 },
  removed: { type: "lines", required: false, maxLines: 3, maxLength: 56 }
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
