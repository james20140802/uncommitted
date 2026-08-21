import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep, win32 } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { CAROUSEL_HEIGHT, CAROUSEL_WIDTH } from "./carousel-dimensions.js";
import type { DiarySlide } from "./diary-generator.js";
import {
  type DraftRevision,
  DraftStorageError,
  writeDraftArtifactBinary
} from "./draft-storage.js";
import { escapeHtml } from "./html-escape.js";
import {
  type StoryCardPlan,
  type StoryCardPlanCard
} from "./story-card-plan.js";
import { findStoryCardKind } from "./story-card-registry.js";
import { fitSlotText, type StoryCardSlots } from "./story-card-slots.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import { TYPO_FALLBACK_HEADLINE } from "./story-card-kind-typo.js";

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
    public readonly code: CarouselPngRenderErrorCode,
    public readonly partialResult?: CarouselPngRenderResult
  ) {
    super(message);
    this.name = "CarouselPngRenderError";
  }
}

export type CarouselRenderInput = {
  targetDate: string;
  projectMarker: string;
  slides: DiarySlide[];
  /**
   * UNC-266: story.json이 실어 온 카드 계획. 이전에는 파싱에서 버려져
   * 렌더가 레거시 제네릭 카드로만 갔다. plan이 없는 pre-UNC-233
   * 드래프트도 정상이므로 optional이다.
   */
  storyCardPlan?: StoryCardPlan;
};

export type CarouselVisualStyleMode = "photo-first" | "story-card";

export type CarouselVisualTreatmentKind = "photo" | "story-card";

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
  visualStyle: CarouselVisualStyleMode;
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

export type CarouselPngRenderFailure = {
  schemaVersion: 1;
  slideIndex: number;
  assetSlotId: string;
  sourceHtmlFileName: string;
  filePath: string;
  code: CarouselPngRenderErrorCode;
  message: string;
};

export type CarouselPngRenderResult = {
  schemaVersion: 1;
  status: "rendered" | "failed";
  files: string[];
  images: CarouselPngMetadata[];
  failures?: CarouselPngRenderFailure[];
};

export type RenderCarouselPngsOptions = {
  revision: DraftRevision;
  cards: CarouselHtmlCard[];
  visualAssets?: CarouselPngVisualAsset[];
  renderer?: CarouselHtmlToPngRenderer;
};

export type CreateCarouselHtmlCardsOptions = {
  visualStyle?: CarouselVisualStyleMode;
  /**
   * 명시적으로 넘긴 계획이 story.json 안의 계획을 이긴다. render-command가
   * 이미 파싱한 계획을 다시 넘길 때 쓴다.
   */
  storyCardPlan?: StoryCardPlan;
};

const invalidStoryMessage =
  "story.json must include ordered slides with title and body.";
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const renderFailureMessage = "Could not render carousel PNGs.";
const layoutFits = ["base", "tight", "compact"] as const;
type CarouselLayoutFit = (typeof layoutFits)[number];

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
  const storyCardPlan = parseStoryCardPlan(value.storyCardPlan);

  return {
    targetDate: value.targetDate,
    projectMarker: deriveProjectMarker(value),
    slides,
    ...(storyCardPlan ? { storyCardPlan } : {})
  };
}

export function createCarouselHtmlCards(
  value: unknown,
  options: CreateCarouselHtmlCardsOptions = {}
): CarouselHtmlCard[] {
  const input = parseCarouselRenderInput(value);
  const pageCount = input.slides.length;
  const visualStyle = options.visualStyle ?? "story-card";
  const planCards = (options.storyCardPlan ?? input.storyCardPlan)?.cards ?? [];

  return input.slides.map((slide, index) => {
    const pageNumber = index + 1;
    const visualTreatment = createVisualTreatment(slide, pageNumber, visualStyle);

    return {
      fileName: `${String(pageNumber).padStart(2, "0")}.html`,
      slideIndex: slide.index,
      pageNumber,
      pageCount,
      visualStyle,
      visualTreatment,
      html: renderCardHtml({
        targetDate: input.targetDate,
        projectMarker: input.projectMarker,
        slide,
        planCard: planCards[index],
        visualStyle,
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
  // Renderer is created lazily so photo-first-only drafts never launch Chromium.
  let renderer: CarouselHtmlToPngRenderer | undefined = options.renderer;
  const shouldCloseRenderer = options.renderer === undefined;
  const files: string[] = [];
  const images: CarouselPngMetadata[] = [];
  const failures: CarouselPngRenderFailure[] = [];

  try {
    for (const [index, card] of options.cards.entries()) {
      const visualAsset = findVisualAsset(card, options.visualAssets ?? []);
      const filePath = `carousel/${String(index + 1).padStart(2, "0")}.png`;
      let png: Uint8Array;

      // photo-first fast-path: when a visual asset is available, copy its raw
      // bytes directly to the carousel output without going through Playwright.
      if (card.visualStyle === "photo-first" && visualAsset) {
        try {
          const rawImage = await readFile(
            resolveDraftArtifactPath(options.revision.outputDir, visualAsset.filePath)
          );

          assertPng(rawImage);
          await assertCarouselPngDimensions(rawImage);
          png = rawImage;
        } catch (error) {
          const renderError = toCarouselPngRenderError(error, "render-failed");

          failures.push({
            schemaVersion: 1,
            slideIndex: card.slideIndex,
            assetSlotId: card.visualTreatment.assetSlotId,
            sourceHtmlFileName: card.fileName,
            filePath,
            code: renderError.code,
            message: renderError.message
          });

          throw withPartialRenderResult(renderError, {
            status: "failed",
            files,
            images,
            failures
          });
        }
      } else {
        // story-card mode (or photo-first with no visual asset): use Playwright.
        renderer ??= new PlaywrightCarouselPngRenderer();

        try {
          png = await renderCardWithLayoutFallbacks({
            revision: options.revision,
            card,
            visualAsset,
            renderer
          });
        } catch (error) {
          const renderError = toCarouselPngRenderError(error, "render-failed");

          failures.push({
            schemaVersion: 1,
            slideIndex: card.slideIndex,
            assetSlotId: card.visualTreatment.assetSlotId,
            sourceHtmlFileName: card.fileName,
            filePath,
            code: renderError.code,
            message: renderError.message
          });

          throw withPartialRenderResult(renderError, {
            status: "failed",
            files,
            images,
            failures
          });
        }
      }

      try {
        await writeDraftArtifactBinary(options.revision, filePath, png);
      } catch (error) {
        const renderError = toCarouselPngRenderError(error, "write-failed");

        failures.push({
          schemaVersion: 1,
          slideIndex: card.slideIndex,
          assetSlotId: card.visualTreatment.assetSlotId,
          sourceHtmlFileName: card.fileName,
          filePath,
          code: renderError.code,
          message: renderError.message
        });

        throw withPartialRenderResult(renderError, {
          status: "failed",
          files,
          images,
          failures
        });
      }

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

    throw new CarouselPngRenderError(
      renderFailureMessage,
      "render-failed",
      buildCarouselPngRenderResult({
        status: "failed",
        files,
        images,
        failures
      })
    );
  } finally {
    if (shouldCloseRenderer) {
      await renderer?.close?.();
    }
  }

  return {
    schemaVersion: 1,
    status: "rendered",
    files,
    images
  };
}

async function renderCardWithLayoutFallbacks(options: {
  revision: DraftRevision;
  card: CarouselHtmlCard;
  visualAsset?: CarouselPngVisualAsset;
  renderer: CarouselHtmlToPngRenderer;
}): Promise<Uint8Array> {
  const composedHtml = await composeCardHtml({
    revision: options.revision,
    card: options.card,
    visualAsset: options.visualAsset
  });
  let lastLayoutError: CarouselPngRenderError | undefined;

  for (const layoutFit of layoutFits) {
    try {
      const png = await options.renderer.renderHtmlToPng({
        html: applyLayoutFit(composedHtml, layoutFit),
        width: CAROUSEL_WIDTH,
        height: CAROUSEL_HEIGHT
      });

      assertPng(png);

      return png;
    } catch (error) {
      if (error instanceof CarouselPngRenderError && error.code === "render-failed") {
        lastLayoutError = error;
        continue;
      }

      throw error;
    }
  }

  throw (
    lastLayoutError ??
    new CarouselPngRenderError(renderFailureMessage, "render-failed")
  );
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
      const validation = await page.evaluate(validateRenderedCard);

      if (!validation.ok) {
        throw new CarouselPngRenderError(
          renderFailureMessage,
          "render-failed"
        );
      }

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

function validateRenderedCard(): { ok: true } | { ok: false } {
  function overflowsOwnBox(element: HTMLElement): boolean {
    return (
      element.scrollHeight > element.clientHeight + 16 ||
      element.scrollWidth > element.clientWidth + 16
    );
  }

  function overflowsCard(cardRect: DOMRect, childRect: DOMRect): boolean {
    return (
      childRect.top < cardRect.top - 2 ||
      childRect.left < cardRect.left - 2 ||
      childRect.right > cardRect.right + 2 ||
      childRect.bottom > cardRect.bottom + 2
    );
  }

  const card = document.querySelector<HTMLElement>(".card");
  const footer = document.querySelector<HTMLElement>(".footer");
  const visualImage = document.querySelector<HTMLImageElement>(".visual-asset");
  const visualStyle = card?.dataset.carouselVisualStyle;

  if (!card || !footer) {
    return { ok: false };
  }

  const cardRect = card.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();

  if (overflowsOwnBox(card) || overflowsCard(cardRect, footerRect)) {
    return { ok: false };
  }

  if (visualStyle === "photo-first") {
    const visualStage = document.querySelector<HTMLElement>(".visual-stage");

    if (!visualStage) {
      return { ok: false };
    }

    const visualRect = visualStage.getBoundingClientRect();

    if (overflowsCard(cardRect, visualRect)) {
      return { ok: false };
    }
  } else {
    // UNC-266: registry story cards have no .visual-stage/.content — their
    // single layout region is .card-stage (see story-card-chrome.ts).
    const content = document.querySelector<HTMLElement>(".card-stage");

    if (!content) {
      return { ok: false };
    }

    const contentRect = content.getBoundingClientRect();

    if (
      overflowsOwnBox(content) ||
      overflowsCard(cardRect, contentRect) ||
      contentRect.bottom > footerRect.top - 16
    ) {
      return { ok: false };
    }
  }

  if (
    visualImage &&
    (!visualImage.complete ||
      visualImage.naturalWidth < 1 ||
      visualImage.naturalHeight < 1)
  ) {
    return { ok: false };
  }

  return { ok: true };
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

  assertPng(image);

  const dataUri = `data:image/png;base64,${image.toString("base64")}`;
  const visualAssetCss = `
    .visual-stage.has-visual-asset,
    .photo-stage.has-visual-asset {
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

    .visual-stage.has-visual-asset:not(.photo-stage) .visual-placeholder {
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
    .replace(
      'class="photo-stage visual-stage"',
      'class="photo-stage has-visual-asset visual-stage"'
    )
    .replace(
      'class="visual-stage"',
      'class="visual-stage has-visual-asset"'
    )
    .replace(
      '<div class="visual-placeholder">',
      `${imgHtml}\n      <div class="visual-placeholder">`
    );
}

function applyLayoutFit(html: string, layoutFit: CarouselLayoutFit): string {
  return html.replace(
    /(<article\b[^>]*\sdata-layout-fit=")[^"]+"/,
    `$1${layoutFit}"`
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
      renderFailureMessage,
      "render-failed"
    );
  }
}

/**
 * UNC-267: raw-copy 경로로 들어오는 photo-first 자산이 story-card와 같은
 * 프레임인지 본다. 규격이 어긋난 자산을 그대로 복사하면 한 캐러셀 안에서
 * 장마다 크기가 달라진다 (부모 AC5 위반).
 */
export async function assertCarouselPngDimensions(value: Uint8Array): Promise<void> {
  const metadata = await sharp(Buffer.from(value)).metadata();

  if (metadata.width !== CAROUSEL_WIDTH || metadata.height !== CAROUSEL_HEIGHT) {
    throw new CarouselPngRenderError(
      `Carousel asset must be ${CAROUSEL_WIDTH}x${CAROUSEL_HEIGHT} but is ${metadata.width}x${metadata.height}.`,
      "render-failed"
    );
  }
}

function toCarouselPngRenderError(
  error: unknown,
  draftStorageCode: CarouselPngRenderErrorCode
): CarouselPngRenderError {
  if (error instanceof CarouselPngRenderError) {
    return error;
  }

  if (error instanceof DraftStorageError) {
    return new CarouselPngRenderError(error.message, draftStorageCode);
  }

  return new CarouselPngRenderError(renderFailureMessage, "render-failed");
}

function withPartialRenderResult(
  error: CarouselPngRenderError,
  result: Omit<CarouselPngRenderResult, "schemaVersion">
): CarouselPngRenderError {
  return new CarouselPngRenderError(
    error.message,
    error.code,
    buildCarouselPngRenderResult(result)
  );
}

function buildCarouselPngRenderResult(
  result: Omit<CarouselPngRenderResult, "schemaVersion">
): CarouselPngRenderResult {
  return {
    schemaVersion: 1,
    status: result.status,
    files: [...result.files],
    images: [...result.images],
    ...(result.failures ? { failures: [...result.failures] } : {})
  };
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
  planCard?: StoryCardPlanCard;
  visualStyle: CarouselVisualStyleMode;
  visualTreatment: CarouselVisualTreatment;
  pageNumber: number;
  pageCount: number;
}): string {
  if (options.visualStyle === "photo-first") {
    return renderPhotoFirstCardHtml(options);
  }

  const chrome: StoryCardChrome = {
    projectMarker: options.projectMarker,
    targetDate: options.targetDate,
    pageNumber: options.pageNumber,
    pageCount: options.pageCount
  };

  return renderStoryCardFromPlan(options.planCard, options.slide, chrome);
}

/**
 * UNC-266: story-card 모드의 유일한 렌더 경로. 계획이 지목한 카드 종류를
 * 레지스트리에서 찾아 그 종류의 render()로 그린다. 계획이 없거나 종류를
 * 못 찾으면 그 **슬라이드 자신**에서 파생한 기본 카드로 채운다 — 렌더가
 * 실패하는 대신 그날의 진짜 내용으로 완주하는 쪽을 고른다.
 */
function renderStoryCardFromPlan(
  planCard: StoryCardPlanCard | undefined,
  slide: DiarySlide,
  chrome: StoryCardChrome
): string {
  if (planCard) {
    const definition = findStoryCardKind(planCard.type);

    if (definition) {
      return definition.render(planCard.slots, chrome);
    }
  }

  return renderSlideDerivedDefaultCard(slide, chrome);
}

/**
 * 기본 카드는 typo 한 종류로 고정한다 — typo의 requires()가 무조건 참이라
 * 어떤 드래프트에서도 유효하고, 슬롯이 headline/kicker 둘뿐이라 슬라이드
 * 제목만으로 제약을 만족시킬 수 있다.
 *
 * 계획의 buildDefaultSlots를 쓰지 않는 이유: 그 경로는 ActivitySummary를
 * 요구하는데 렌더 입력은 story.json뿐이고, 같은 요약으로 N장을 만들면
 * N장이 전부 같은 카드가 된다.
 */
function renderSlideDerivedDefaultCard(
  slide: DiarySlide,
  chrome: StoryCardChrome
): string {
  const definition = findStoryCardKind("typo");

  if (definition === undefined) {
    // 레지스트리에서 typo가 사라진 상황 — 카드 문법 없이 최소 문서라도 낸다.
    return renderStoryCardDocument({
      kindId: "typo",
      title: TYPO_FALLBACK_HEADLINE,
      stageStyles: "",
      stageHtml: `    <p>${escapeHtml(TYPO_FALLBACK_HEADLINE)}</p>`,
      chrome
    });
  }

  const headlineSpec = definition.slots.headline;
  const kickerSpec = definition.slots.kicker;
  const rawHeadline = slide.title.trim();
  const slots: StoryCardSlots = {
    headline:
      rawHeadline.length > 0 && headlineSpec !== undefined
        ? fitSlotText(rawHeadline, headlineSpec)
        : TYPO_FALLBACK_HEADLINE,
    ...(kickerSpec === undefined
      ? {}
      : { kicker: fitSlotText(chrome.targetDate, kickerSpec) })
  };

  return definition.render(slots, chrome);
}

function createVisualTreatment(
  slide: DiarySlide,
  pageNumber: number,
  visualStyle: CarouselVisualStyleMode
): CarouselVisualTreatment {
  const prompt = slide.visualMood.trim();
  const isPhotoFirst = visualStyle === "photo-first";

  return {
    kind: isPhotoFirst ? "photo" : "story-card",
    assetSlotId: `slide-${String(pageNumber).padStart(2, "0")}-visual`,
    prompt,
    altText: `${isPhotoFirst ? "Photo-first" : "Story-card"} visual concept: ${prompt}`
  };
}

function renderPhotoFirstCardHtml(options: {
  targetDate: string;
  projectMarker: string;
  slide: DiarySlide;
  visualStyle: CarouselVisualStyleMode;
  visualTreatment: CarouselVisualTreatment;
  pageNumber: number;
  pageCount: number;
}): string {
  const title = escapeHtml(options.slide.title.trim());
  const targetDate = escapeHtml(options.targetDate.trim());
  const projectMarker = escapeHtml(options.projectMarker.trim());
  const visualStyle = escapeHtml(options.visualStyle);
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
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 42px 46px 46px;
      background: #f7f7f5;
      color: #161616;
      overflow: hidden;
    }

    .topline,
    .footer {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 28px;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: 0;
      line-height: 1.2;
      color: #f8fafc;
      text-shadow: 0 2px 16px rgba(15, 23, 42, 0.62);
    }

    .project-marker {
      max-width: 640px;
      overflow-wrap: anywhere;
    }

    .photo-stage {
      position: absolute;
      inset: 0;
      z-index: 0;
      background:
        linear-gradient(135deg, rgba(15, 118, 110, 0.18), rgba(15, 23, 42, 0) 42%),
        linear-gradient(315deg, rgba(234, 179, 8, 0.18), rgba(15, 23, 42, 0) 44%),
        #dfe7ef;
      overflow: hidden;
    }

    .photo-stage::after {
      position: absolute;
      inset: 0;
      z-index: 1;
      content: "";
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.36), rgba(15, 23, 42, 0) 24%),
        linear-gradient(0deg, rgba(15, 23, 42, 0.46), rgba(15, 23, 42, 0) 28%);
      pointer-events: none;
    }

    .visual-placeholder {
      position: absolute;
      inset: 180px 120px;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 0;
      border: 2px solid rgba(15, 23, 42, 0.14);
      background: rgba(248, 250, 252, 0.32);
      color: transparent;
      overflow: hidden;
    }

    .mark {
      font-size: 34px;
      font-weight: 900;
      color: #f8fafc;
    }
  </style>
</head>
<body>
  <article class="card" aria-label="Uncommitted carousel card ${escapeHtml(
    pageIndicator
  )}" data-layout-fit="base" data-carousel-visual-style="${visualStyle}">
    <header class="topline">
      <div class="project-marker">${projectMarker}</div>
      <time datetime="${targetDate}">${targetDate}</time>
    </header>
    <section
      class="photo-stage visual-stage"
      data-visual-kind="${visualKind}"
      data-asset-slot-id="${visualAssetSlotId}"
      data-visual-prompt="${visualPrompt}"
      aria-label="${visualAltText}"
    >
      <div class="visual-placeholder">${visualPrompt}</div>
    </section>
    <footer class="footer">
      <div class="mark">Uncommitted</div>
      <div>${escapeHtml(pageIndicator)}</div>
    </footer>
  </article>
</body>
</html>
`;
}

/**
 * plan이 깨져 있어도 렌더를 실패시키지 않는다 — 그 자리는 기본 카드가
 * 메운다. 드래프트 전체를 죽이는 쪽이 훨씬 나쁜 결과다.
 */
function parseStoryCardPlan(value: unknown): StoryCardPlan | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (!Array.isArray(value.cards)) return undefined;

  const cards: StoryCardPlanCard[] = [];

  for (const raw of value.cards) {
    if (!isRecord(raw)) continue;
    if (!isNonEmptyString(raw.type)) continue;
    if (!isRecord(raw.slots)) continue;

    const slots: Record<string, string | string[]> = {};

    for (const [name, slotValue] of Object.entries(raw.slots)) {
      if (typeof slotValue === "string") {
        slots[name] = slotValue;
        continue;
      }

      if (
        Array.isArray(slotValue) &&
        slotValue.every((line): line is string => typeof line === "string")
      ) {
        slots[name] = [...slotValue];
      }
    }

    cards.push({
      type: raw.type,
      slots,
      source: raw.source === "degraded" || raw.source === "fallback" ? raw.source : "generated"
    });
  }

  return { schemaVersion: 1, cards };
}

function deriveProjectMarker(value: Record<string, unknown>): string {
  const metadata = value.metadata;

  if (!isRecord(metadata) || !Array.isArray(metadata.projectIds)) {
    return "Uncommitted";
  }

  const firstProjectId = metadata.projectIds.find(isNonEmptyString);

  return firstProjectId?.trim() ?? "Uncommitted";
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
