import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep, win32 } from "node:path";
import { chromium, type Browser } from "playwright";
import type { DiarySlide } from "./diary-generator.js";
import {
  type DraftRevision,
  DraftStorageError,
  writeDraftArtifactBinary
} from "./draft-storage.js";

export type CarouselRenderInputErrorCode = "invalid-story";
export type CarouselPngRenderErrorCode = "render-failed" | "write-failed";

export class CarouselRenderInputError extends Error {
  constructor(
    message: string,
    public readonly code: CarouselRenderInputErrorCode
  ) {
    super(message);
    this.name = "CarouselRenderInputError";
  }
}

export class CarouselPngRenderError extends Error {
  constructor(
    message: string,
    public readonly code: CarouselPngRenderErrorCode
  ) {
    super(message);
    this.name = "CarouselPngRenderError";
  }
}

export type CarouselRenderInput = {
  targetDate: string;
  projectMarker: string;
  slides: DiarySlide[];
};

export type CarouselVisualTreatmentKind = "illustration";

export type CarouselVisualTreatment = {
  kind: CarouselVisualTreatmentKind;
  assetSlotId: string;
  prompt: string;
  altText: string;
};

export type CarouselHtmlCard = {
  fileName: string;
  slideIndex: number;
  pageNumber: number;
  pageCount: number;
  visualTreatment: CarouselVisualTreatment;
  html: string;
};

export type CarouselPngVisualAsset = {
  slideIndex: number;
  assetSlotId: string;
  filePath: string;
};

export type CarouselHtmlToPngRenderer = {
  renderHtmlToPng(options: {
    html: string;
    width: number;
    height: number;
  }): Promise<Uint8Array>;
  close?(): Promise<void>;
};

export type CarouselPngMetadata = {
  schemaVersion: 1;
  slideIndex: number;
  assetSlotId: string;
  sourceHtmlFileName: string;
  filePath: string;
  visualAssetPath?: string;
};

export type CarouselPngRenderResult = {
  schemaVersion: 1;
  files: string[];
  images: CarouselPngMetadata[];
};

export type RenderCarouselPngsOptions = {
  revision: DraftRevision;
  cards: CarouselHtmlCard[];
  visualAssets?: CarouselPngVisualAsset[];
  renderer?: CarouselHtmlToPngRenderer;
};

const invalidStoryMessage =
  "story.json must include ordered slides with title and body.";
const carouselWidth = 1080;
const carouselHeight = 1350;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
    const visualTreatment = createVisualTreatment(slide, pageNumber);

    return {
      fileName: `${String(pageNumber).padStart(2, "0")}.html`,
      slideIndex: slide.index,
      pageNumber,
      pageCount,
      visualTreatment,
      html: renderCardHtml({
        targetDate: input.targetDate,
        projectMarker: input.projectMarker,
        slide,
        visualTreatment,
        pageNumber,
        pageCount
      })
    };
  });
}

export async function renderCarouselPngs(
  options: RenderCarouselPngsOptions
): Promise<CarouselPngRenderResult> {
  const renderer = options.renderer ?? new PlaywrightCarouselPngRenderer();
  const shouldCloseRenderer = options.renderer === undefined;
  const files: string[] = [];
  const images: CarouselPngMetadata[] = [];

  try {
    for (const [index, card] of options.cards.entries()) {
      const visualAsset = findVisualAsset(card, options.visualAssets ?? []);
      const html = await composeCardHtml({
        revision: options.revision,
        card,
        visualAsset
      });
      const png = await renderer.renderHtmlToPng({
        html,
        width: carouselWidth,
        height: carouselHeight
      });

      assertPng(png);

      const filePath = `carousel/${String(index + 1).padStart(2, "0")}.png`;

      await writeDraftArtifactBinary(options.revision, filePath, png);

      files.push(filePath);
      images.push({
        schemaVersion: 1,
        slideIndex: card.slideIndex,
        assetSlotId: card.visualTreatment.assetSlotId,
        sourceHtmlFileName: card.fileName,
        filePath,
        ...(visualAsset ? { visualAssetPath: visualAsset.filePath } : {})
      });
    }
  } catch (error) {
    if (error instanceof CarouselPngRenderError) {
      throw error;
    }

    if (error instanceof DraftStorageError) {
      throw new CarouselPngRenderError(error.message, "write-failed");
    }

    throw new CarouselPngRenderError(
      "Could not render carousel PNGs.",
      "render-failed"
    );
  } finally {
    if (shouldCloseRenderer) {
      await renderer.close?.();
    }
  }

  return {
    schemaVersion: 1,
    files,
    images
  };
}

class PlaywrightCarouselPngRenderer implements CarouselHtmlToPngRenderer {
  private browser: Browser | undefined;

  async renderHtmlToPng(options: {
    html: string;
    width: number;
    height: number;
  }): Promise<Uint8Array> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      viewport: {
        width: options.width,
        height: options.height
      },
      deviceScaleFactor: 1
    });

    try {
      await page.setContent(options.html, { waitUntil: "load" });

      return await page.screenshot({
        type: "png",
        clip: {
          x: 0,
          y: 0,
          width: options.width,
          height: options.height
        }
      });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }

  private async getBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch({ headless: true });

    return this.browser;
  }
}

async function composeCardHtml(options: {
  revision: DraftRevision;
  card: CarouselHtmlCard;
  visualAsset?: CarouselPngVisualAsset;
}): Promise<string> {
  if (!options.visualAsset) {
    return options.card.html;
  }

  const image = await readFile(
    resolveDraftArtifactPath(
      options.revision.outputDir,
      options.visualAsset.filePath
    )
  );
  const dataUri = `data:image/png;base64,${image.toString("base64")}`;
  const visualAssetCss = `
    .visual-stage.has-visual-asset {
      background: #eef2f7;
    }

    .visual-asset {
      position: absolute;
      inset: 0;
      z-index: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .visual-stage.has-visual-asset .visual-placeholder {
      padding: 18px 22px;
      background: rgba(247, 247, 245, 0.82);
      border: 2px solid rgba(15, 23, 42, 0.12);
    }
`;
  const imgHtml = `<img class="visual-asset" src="${dataUri}" alt="${escapeHtml(
    options.card.visualTreatment.altText
  )}">`;

  return options.card.html
    .replace("</style>", `${visualAssetCss}  </style>`)
    .replace('class="visual-stage"', 'class="visual-stage has-visual-asset"')
    .replace(
      '<div class="visual-placeholder">',
      `${imgHtml}\n      <div class="visual-placeholder">`
    );
}

function findVisualAsset(
  card: CarouselHtmlCard,
  visualAssets: CarouselPngVisualAsset[]
): CarouselPngVisualAsset | undefined {
  return visualAssets.find(
    (asset) =>
      asset.slideIndex === card.slideIndex &&
      asset.assetSlotId === card.visualTreatment.assetSlotId
  );
}

function resolveDraftArtifactPath(outputDir: string, filePath: string): string {
  const root = resolve(outputDir);
  const separatorNormalized = filePath.replace(/\\/g, "/");
  const normalized = normalize(separatorNormalized);
  const resolved = resolve(root, normalized);
  const relativePath = relative(root, resolved);

  if (
    filePath.trim().length === 0 ||
    isAbsolute(normalized) ||
    win32.isAbsolute(filePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new CarouselPngRenderError(
      "Could not render carousel PNGs.",
      "render-failed"
    );
  }

  return resolved;
}

function assertPng(value: Uint8Array): void {
  const hasPngSignature = pngSignature.every(
    (byte, index) => value[index] === byte
  );

  if (!hasPngSignature) {
    throw new CarouselPngRenderError(
      "Could not render carousel PNGs.",
      "render-failed"
    );
  }
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
  visualTreatment: CarouselVisualTreatment;
  pageNumber: number;
  pageCount: number;
}): string {
  const title = escapeHtml(options.slide.title.trim());
  const body = escapeHtml(options.slide.body.trim());
  const targetDate = escapeHtml(options.targetDate.trim());
  const projectMarker = escapeHtml(options.projectMarker.trim());
  const visualAssetSlotId = escapeHtml(options.visualTreatment.assetSlotId);
  const visualKind = escapeHtml(options.visualTreatment.kind);
  const visualPrompt = escapeHtml(options.visualTreatment.prompt);
  const visualAltText = escapeHtml(options.visualTreatment.altText);
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

    .visual-stage {
      position: relative;
      min-height: 670px;
      margin: 54px 0 44px;
      border: 2px solid #d4d4d8;
      background:
        linear-gradient(135deg, rgba(15, 118, 110, 0.16), rgba(15, 23, 42, 0) 42%),
        linear-gradient(315deg, rgba(251, 191, 36, 0.2), rgba(15, 23, 42, 0) 44%),
        #eef2f7;
      overflow: hidden;
    }

    .visual-stage::before,
    .visual-stage::after {
      position: absolute;
      content: "";
      border: 2px solid rgba(15, 23, 42, 0.18);
    }

    .visual-stage::before {
      width: 430px;
      height: 430px;
      right: -92px;
      top: 70px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.42);
    }

    .visual-stage::after {
      width: 360px;
      height: 240px;
      left: 92px;
      bottom: 92px;
      background: rgba(255, 255, 255, 0.58);
      transform: rotate(-7deg);
    }

    .visual-placeholder {
      position: absolute;
      left: 72px;
      right: 72px;
      bottom: 58px;
      z-index: 1;
      font-size: 30px;
      font-weight: 700;
      line-height: 1.25;
      color: #334155;
      overflow-wrap: anywhere;
    }

    .content {
      display: flex;
      flex-direction: column;
      gap: 52px;
      margin: 0 0 44px;
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
    <section
      class="visual-stage"
      data-visual-kind="${visualKind}"
      data-asset-slot-id="${visualAssetSlotId}"
      data-visual-prompt="${visualPrompt}"
      aria-label="${visualAltText}"
    >
      <div class="visual-placeholder">${visualPrompt}</div>
    </section>
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

function createVisualTreatment(
  slide: DiarySlide,
  pageNumber: number
): CarouselVisualTreatment {
  const prompt = slide.visualMood.trim();

  return {
    kind: "illustration",
    assetSlotId: `slide-${String(pageNumber).padStart(2, "0")}-visual`,
    prompt,
    altText: `Illustration concept: ${prompt}`
  };
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
