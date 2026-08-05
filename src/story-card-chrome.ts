import { escapeHtml } from "./html-escape.js";

export type StoryCardChrome = {
  projectMarker: string;
  targetDate: string;
  pageNumber: number;
  pageCount: number;
};

export type StoryCardDocumentOptions = {
  kindId: string;
  title: string;
  stageHtml: string;
  stageStyles: string;
  chrome: StoryCardChrome;
};

export function renderStoryCardDocument(
  options: StoryCardDocumentOptions
): string {
  const kindId = escapeHtml(options.kindId);
  const title = escapeHtml(options.title.trim());
  const projectMarker = escapeHtml(options.chrome.projectMarker.trim());
  const targetDate = escapeHtml(options.chrome.targetDate.trim());
  const pageIndicator = escapeHtml(
    `${options.chrome.pageNumber} / ${options.chrome.pageCount}`
  );

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1080, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f7f5;
      color: #161616;
    }

    * { box-sizing: border-box; }

    body { margin: 0; background: #f7f7f5; }

    .card {
      width: 1080px;
      height: 1350px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 88px 84px 72px;
      background: #f7f7f5;
      color: #161616;
      overflow: hidden;
    }

    .topline,
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 32px;
      font-size: 30px;
      font-weight: 700;
      line-height: 1.2;
      color: #4b5563;
    }

    .project-marker {
      max-width: 640px;
      overflow-wrap: anywhere;
    }

    .card-stage {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      margin: 54px 0 44px;
      font-size: 34px;
      line-height: 1.35;
      overflow: hidden;
    }

    .mark {
      font-size: 34px;
      font-weight: 800;
      color: #0f766e;
    }

    .card[data-layout-fit="tight"] { padding: 78px 78px 66px; }
    .card[data-layout-fit="tight"] .card-stage {
      margin: 44px 0 34px;
      font-size: 30px;
    }

    .card[data-layout-fit="compact"] { padding: 66px 72px 58px; }
    .card[data-layout-fit="compact"] .topline,
    .card[data-layout-fit="compact"] .footer { font-size: 28px; }
    .card[data-layout-fit="compact"] .card-stage {
      margin: 34px 0 28px;
      font-size: 26px;
    }

${options.stageStyles}
  </style>
</head>
<body>
  <article
    class="card"
    aria-label="Uncommitted carousel card ${pageIndicator}"
    data-layout-fit="base"
    data-carousel-visual-style="story-card"
    data-story-card-kind="${kindId}"
  >
    <header class="topline">
      <div class="project-marker">${projectMarker}</div>
      <time datetime="${targetDate}">${targetDate}</time>
    </header>
    <main class="card-stage">
${options.stageHtml}
    </main>
    <footer class="footer">
      <div class="mark">Uncommitted</div>
      <div>${pageIndicator}</div>
    </footer>
  </article>
</body>
</html>
`;
}
