import type { DiarySlide } from "./diary-generator.js";

export type CarouselRenderInputErrorCode = "invalid-story";

export class CarouselRenderInputError extends Error {
  constructor(
    message: string,
    public readonly code: CarouselRenderInputErrorCode
  ) {
    super(message);
    this.name = "CarouselRenderInputError";
  }
}

export type CarouselRenderInput = {
  targetDate: string;
  projectMarker: string;
  slides: DiarySlide[];
};

export type CarouselHtmlCard = {
  fileName: string;
  slideIndex: number;
  pageNumber: number;
  pageCount: number;
  html: string;
};

const invalidStoryMessage =
  "story.json must include ordered slides with title and body.";

export function parseCarouselRenderInput(value: unknown): CarouselRenderInput {
  if (!isRecord(value)) {
    throwInvalidStory();
  }

  if (
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.targetDate) ||
    !Array.isArray(value.slides) ||
    value.slides.length === 0
  ) {
    throwInvalidStory();
  }

  const slides = value.slides.map((slide, index) =>
    parseDiarySlide(slide, index)
  );

  return {
    targetDate: value.targetDate,
    projectMarker: deriveProjectMarker(value),
    slides
  };
}

export function createCarouselHtmlCards(value: unknown): CarouselHtmlCard[] {
  const input = parseCarouselRenderInput(value);
  const pageCount = input.slides.length;

  return input.slides.map((slide, index) => {
    const pageNumber = index + 1;

    return {
      fileName: `${String(pageNumber).padStart(2, "0")}.html`,
      slideIndex: slide.index,
      pageNumber,
      pageCount,
      html: renderCardHtml({
        targetDate: input.targetDate,
        projectMarker: input.projectMarker,
        slide,
        pageNumber,
        pageCount
      })
    };
  });
}

function parseDiarySlide(value: unknown, index: number): DiarySlide {
  if (
    !isRecord(value) ||
    value.index !== index + 1 ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.body) ||
    !isNonEmptyString(value.visualMood)
  ) {
    throwInvalidStory();
  }

  return {
    index: value.index,
    title: value.title,
    body: value.body,
    visualMood: value.visualMood
  };
}

function renderCardHtml(options: {
  targetDate: string;
  projectMarker: string;
  slide: DiarySlide;
  pageNumber: number;
  pageCount: number;
}): string {
  const title = escapeHtml(options.slide.title.trim());
  const body = escapeHtml(options.slide.body.trim());
  const targetDate = escapeHtml(options.targetDate.trim());
  const projectMarker = escapeHtml(options.projectMarker.trim());
  const pageIndicator = `${options.pageNumber} / ${options.pageCount}`;

  return `<!doctype html>
<html lang="en">
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

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f7f7f5;
    }

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
      letter-spacing: 0;
      line-height: 1.2;
      color: #4b5563;
    }

    .project-marker {
      max-width: 640px;
      overflow-wrap: anywhere;
    }

    .content {
      display: flex;
      flex-direction: column;
      gap: 52px;
      margin: 96px 0;
    }

    h1 {
      margin: 0;
      max-width: 900px;
      font-size: 90px;
      line-height: 0.98;
      letter-spacing: 0;
      color: #111827;
    }

    .body {
      margin: 0;
      max-width: 860px;
      font-size: 48px;
      line-height: 1.22;
      letter-spacing: 0;
      color: #1f2937;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .mark {
      font-size: 34px;
      font-weight: 800;
      color: #0f766e;
    }
  </style>
</head>
<body>
  <article class="card" aria-label="Uncommitted carousel card ${escapeHtml(
    pageIndicator
  )}">
    <header class="topline">
      <div class="project-marker">${projectMarker}</div>
      <time datetime="${targetDate}">${targetDate}</time>
    </header>
    <main class="content">
      <h1>${title}</h1>
      <p class="body">${body}</p>
    </main>
    <footer class="footer">
      <div class="mark">Uncommitted</div>
      <div>${escapeHtml(pageIndicator)}</div>
    </footer>
  </article>
</body>
</html>
`;
}

function deriveProjectMarker(value: Record<string, unknown>): string {
  const metadata = value.metadata;

  if (!isRecord(metadata) || !Array.isArray(metadata.projectIds)) {
    return "Uncommitted";
  }

  const firstProjectId = metadata.projectIds.find(isNonEmptyString);

  return firstProjectId?.trim() ?? "Uncommitted";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function throwInvalidStory(): never {
  throw new CarouselRenderInputError(invalidStoryMessage, "invalid-story");
}
