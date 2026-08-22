import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CarouselPngRenderError,
  CarouselRenderInputError,
  createCarouselHtmlCards,
  type CarouselVisualStyleMode,
  renderCarouselPngs,
  type CarouselHtmlToPngRenderer,
  type CarouselHtmlCard,
  type CarouselPngRenderResult,
  type CarouselPngVisualAsset
} from "./carousel-renderer.js";
import { resolveConfigPaths } from "./config-paths.js";
import { loadGlobalConfig } from "./global-config.js";
import { isRecord } from "./type-guards.js";
import {
  DraftStorageError,
  readLatestDraftPointer,
  type DraftRevision,
  writeDraftArtifactJson
} from "./draft-storage.js";

export type RenderCommandErrorCode =
  | "invalid-arguments"
  | "invalid-config"
  | "render-failed"
  | "safety-blocked";

export class RenderCommandError extends Error {
  constructor(
    message: string,
    public readonly code: RenderCommandErrorCode
  ) {
    super(message);
    this.name = "RenderCommandError";
  }
}

export type RenderCommandOptions = {
  homeDir?: string;
  renderer?: CarouselHtmlToPngRenderer;
};

export type RenderCommandResult = {
  targetDate: string;
  outputDir: string;
  carouselDir: string;
  renderResult: CarouselPngRenderResult;
  /** UNC-270: degrade가 일어났을 때 CLI가 출력할 경고 문구. */
  warnings?: string[];
};

const usage = "Usage: uncommitted render latest";

export async function runRenderCommand(
  args: string[],
  options: RenderCommandOptions = {}
): Promise<RenderCommandResult> {
  if (args.length !== 1 || args[0] !== "latest") {
    throw new RenderCommandError(usage, "invalid-arguments");
  }

  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const draftRoot = await readDraftRoot(paths.configFile, options.homeDir);
  const pointer = await readLatestPointer(draftRoot);

  if (!isPathInside(draftRoot, pointer.path)) {
    throw new RenderCommandError(
      "Latest draft pointer is invalid. Regenerate the draft.",
      "render-failed"
    );
  }

  const revision: DraftRevision = {
    targetDate: pointer.targetDate,
    revision: pointer.revision,
    dateDir: dirname(pointer.path),
    outputDir: pointer.path,
    latestPointerPath: join(draftRoot, "latest.json"),
    dateLatestPointerPath: join(draftRoot, pointer.targetDate, "latest.json")
  };
  const metadata = await readMetadata(revision.outputDir);

  assertDraftIsComplete(metadata);
  assertDraftIsRenderable(metadata);

  const story = await readJsonArtifact(
    join(revision.outputDir, "story.json"),
    "Draft story is not renderable. Regenerate the draft."
  );

  const cards = createCardsWithStyle(story, readCarouselVisualStyle(metadata));
  // UNC-235 리뷰 반영 (PR #138 Codex): 이전 렌더가 photo-first 자산을 못 써
  // story-card로 degrade한 드래프트라면, 그 자산은 지금도 여전히 못 쓴다.
  // 같은 실행 안에서는 renderCarouselPngs가 이미 자산을 떼고 다시 그리지만
  // (carousel-renderer.ts의 `visualAssets: []`), 그 사실이 다음 실행으로
  // 이어지지 않았다. 그래서 재렌더는 story-card 카드에 그 못 쓰는 자산을
  // 다시 붙이려다 composeCardHtml에서 같은 파일을 열고 죽었고, 카드가 이미
  // story-card라 degrade 경로도 걸리지 않아 render-failed(exit 5)로 끝났다 —
  // degrade가 살려낸 드래프트가 재렌더에서 죽는 것이다. degrade 뒤에는
  // 자산을 붙이지 않는다는 규칙을 실행 경계 너머로 이어 붙인다.
  const visualAssets = hasDegradedFromPhotoFirst(metadata)
    ? []
    : readVisualAssets(metadata);

  if (visualAssets.length > 0) {
    assertVisualAssetsCoverCards(cards, visualAssets);
  }

  try {
    const renderResult = await renderCarouselPngs({
      revision,
      cards,
      visualAssets,
      renderer: options.renderer,
      // UNC-270: photo-first 자산이 못 쓰게 되면 같은 story.json으로
      // story-card 카드를 다시 만들어 드래프트 전체를 그 세트로 렌더한다.
      photoFirstDegrade: () => createCardsWithStyle(story, "story-card")
    });

    await writeDraftArtifactJson(
      revision,
      "metadata.json",
      buildRenderedMetadata(metadata, renderResult)
    );

    const warnings = renderResult.degraded
      ? [
          `Photo-first assets were unusable, so the whole draft was rendered as story-card. Reason: ${renderResult.degraded.reason}`
        ]
      : undefined;

    return {
      targetDate: revision.targetDate,
      outputDir: revision.outputDir,
      carouselDir: join(revision.outputDir, "carousel"),
      renderResult,
      ...(warnings ? { warnings } : {})
    };
  } catch (error) {
    if (error instanceof CarouselPngRenderError) {
      throw new RenderCommandError(error.message, "render-failed");
    }

    if (error instanceof DraftStorageError) {
      throw new RenderCommandError(error.message, "render-failed");
    }

    throw error;
  }
}

async function readDraftRoot(
  configFile: string,
  homeDir: string | undefined
): Promise<string> {
  const outcome = await loadGlobalConfig(configFile);

  if (outcome.status === "missing") {
    throw new RenderCommandError(
      "AI config is missing. Run `uncommitted init` first.",
      "invalid-config"
    );
  }

  if (
    outcome.status !== "ok" ||
    !isRecord(outcome.value) ||
    outcome.value.schemaVersion !== 1 ||
    typeof outcome.value.draftRoot !== "string"
  ) {
    throw new RenderCommandError("AI config is invalid.", "invalid-config");
  }

  return resolveConfigPaths({
    homeDir,
    draftRoot: outcome.value.draftRoot
  }).defaultDraftRoot;
}

async function readLatestPointer(draftRoot: string) {
  try {
    return await readLatestDraftPointer(draftRoot);
  } catch (error) {
    if (error instanceof DraftStorageError) {
      throw new RenderCommandError(
        "No latest draft found. Run `uncommitted generate today` first.",
        "render-failed"
      );
    }

    throw error;
  }
}

async function readJsonArtifact(
  path: string,
  failureMessage: string
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new RenderCommandError(failureMessage, "render-failed");
  }
}

async function readMetadata(outputDir: string): Promise<Record<string, unknown>> {
  const metadata = await readJsonArtifact(
    join(outputDir, "metadata.json"),
    "Draft metadata is invalid. Regenerate the draft."
  );

  if (!isRecord(metadata)) {
    throw new RenderCommandError(
      "Draft metadata is invalid. Regenerate the draft.",
      "render-failed"
    );
  }

  return metadata;
}

/**
 * UNC-256 / T5: 캡션 단계에서 실패해 산출물이 반쪽만 남은 리비전
 * (UNC-253이 남긴 status=incomplete)을 완성본처럼 렌더하지 않는다.
 */
function assertDraftIsComplete(metadata: Record<string, unknown>): void {
  if (metadata.status !== "incomplete") {
    return;
  }

  const stage = isRecord(metadata.incomplete)
    ? String(metadata.incomplete.stage ?? "unknown")
    : "unknown";

  throw new RenderCommandError(
    `Draft is incomplete (failed at the ${stage} stage). Regenerate before rendering.`,
    "render-failed"
  );
}

function assertDraftIsRenderable(metadata: Record<string, unknown>): void {
  if (
    metadata.exportPolicy === "blocked" ||
    (isRecord(metadata.safety) && metadata.safety.status === "blocked")
  ) {
    throw new RenderCommandError(
      "Draft is blocked by safety checks. Regenerate or edit before rendering.",
      "safety-blocked"
    );
  }
}

// UNC-266: story.json이 실어 온 storyCardPlan은 parseCarouselRenderInput이
// 보존하므로 여기서 따로 넘기지 않아도 registry 렌더까지 도달한다.
function createCardsWithStyle(story: unknown, visualStyle: CarouselVisualStyleMode) {
  try {
    return createCarouselHtmlCards(story, { visualStyle });
  } catch (error) {
    if (error instanceof CarouselRenderInputError) {
      throw new RenderCommandError(
        "Draft story is not renderable. Regenerate the draft.",
        "render-failed"
      );
    }

    throw error;
  }
}

function readCarouselVisualStyle(
  metadata: Record<string, unknown>
): CarouselVisualStyleMode {
  return metadata.carouselVisualStyle === "photo-first" ? "photo-first" : "story-card";
}

/**
 * degrade가 일어났음은 두 값의 어긋남으로 드러난다 — 요청된 모드는
 * requestedCarouselVisualStyle에 그대로 남고, 실제로 그려진 모드만
 * carouselVisualStyle로 덮어써지기 때문이다(buildRenderedMetadata 참고).
 * carousel.degraded 기록에 기대지 않는 이유: 그 기록은 렌더 결과마다
 * 덮어써져서, 재렌더 한 번이면 사라진다.
 */
function hasDegradedFromPhotoFirst(metadata: Record<string, unknown>): boolean {
  return (
    metadata.requestedCarouselVisualStyle === "photo-first" &&
    readCarouselVisualStyle(metadata) === "story-card"
  );
}

function readVisualAssets(
  metadata: Record<string, unknown>
): CarouselPngVisualAsset[] {
  if (!Array.isArray(metadata.visualAssets) || metadata.visualAssets.length === 0) {
    throw new RenderCommandError(
      "Draft visual assets are missing. Regenerate the draft.",
      "render-failed"
    );
  }

  const visualAssets = metadata.visualAssets.map((asset) => {
    if (!isVisualAssetMetadata(asset)) {
      throw new RenderCommandError(
        "Draft visual asset metadata is invalid. Regenerate the draft.",
        "render-failed"
      );
    }

    return {
      slideIndex: asset.slideIndex,
      assetSlotId: asset.assetSlotId,
      filePath: asset.filePath
    };
  });

  return visualAssets;
}

function assertVisualAssetsCoverCards(
  cards: CarouselHtmlCard[],
  visualAssets: CarouselPngVisualAsset[]
): void {
  const hasMissingAsset = cards.some(
    (card) =>
      !visualAssets.some(
        (asset) =>
          asset.slideIndex === card.slideIndex &&
          asset.assetSlotId === card.visualTreatment.assetSlotId
      )
  );

  if (hasMissingAsset) {
    throw new RenderCommandError(
      "Draft visual assets are missing. Regenerate the draft.",
      "render-failed"
    );
  }
}

function buildRenderedMetadata(
  metadata: Record<string, unknown>,
  renderResult: CarouselPngRenderResult
): Record<string, unknown> {
  return {
    ...metadata,
    files: mergeFiles(metadata.files, renderResult.files),
    carousel: renderResult,
    // UNC-270: 실제로 그려진 모드를 metadata에 반영한다. 요청된 모드는
    // requestedCarouselVisualStyle에 그대로 남아 있어 두 값을 비교하면
    // degrade가 일어났음이 드러난다.
    ...(renderResult.degraded
      ? { carouselVisualStyle: renderResult.degraded.to }
      : {})
  };
}

function mergeFiles(existingFiles: unknown, renderedFiles: string[]): string[] {
  const files = Array.isArray(existingFiles)
    ? existingFiles.filter((file): file is string => typeof file === "string")
    : [];

  return Array.from(new Set([...files, ...renderedFiles]));
}

function isVisualAssetMetadata(value: unknown): value is CarouselPngVisualAsset {
  return (
    isRecord(value) &&
    typeof value.slideIndex === "number" &&
    Number.isInteger(value.slideIndex) &&
    value.slideIndex > 0 &&
    typeof value.assetSlotId === "string" &&
    value.assetSlotId.trim().length > 0 &&
    typeof value.filePath === "string" &&
    value.filePath.trim().length > 0
  );
}

function isPathInside(rootPath: string, valuePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(valuePath));

  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}
