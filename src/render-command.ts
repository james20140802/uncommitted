import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CarouselPngRenderError,
  CarouselRenderInputError,
  createCarouselHtmlCards,
  renderCarouselPngs,
  type CarouselHtmlToPngRenderer,
  type CarouselHtmlCard,
  type CarouselPngRenderResult,
  type CarouselPngVisualAsset
} from "./carousel-renderer.js";
import { resolveConfigPaths } from "./config-paths.js";
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
};

type RenderConfigFile = {
  schemaVersion: 1;
  draftRoot: string;
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
  const story = await readJsonArtifact(
    join(revision.outputDir, "story.json"),
    "Draft story is not renderable. Regenerate the draft."
  );
  const metadata = await readMetadata(revision.outputDir);

  assertDraftIsRenderable(metadata);

  const cards = createCards(story);
  const visualAssets = readVisualAssets(metadata);
  assertVisualAssetsCoverCards(cards, visualAssets);

  try {
    const renderResult = await renderCarouselPngs({
      revision,
      cards,
      visualAssets,
      renderer: options.renderer
    });

    await writeDraftArtifactJson(
      revision,
      "metadata.json",
      buildRenderedMetadata(metadata, renderResult)
    );

    return {
      targetDate: revision.targetDate,
      outputDir: revision.outputDir,
      carouselDir: join(revision.outputDir, "carousel"),
      renderResult
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
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as unknown;

    if (!isRenderConfigFile(parsed)) {
      throw new RenderCommandError("AI config is invalid.", "invalid-config");
    }

    return resolveConfigPaths({
      homeDir,
      draftRoot: parsed.draftRoot
    }).defaultDraftRoot;
  } catch (error) {
    if (error instanceof RenderCommandError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RenderCommandError(
        "AI config is missing. Run `uncommitted init` first.",
        "invalid-config"
      );
    }

    throw new RenderCommandError("AI config is invalid.", "invalid-config");
  }
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

function createCards(story: unknown) {
  try {
    return createCarouselHtmlCards(story);
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
    carousel: renderResult
  };
}

function mergeFiles(existingFiles: unknown, renderedFiles: string[]): string[] {
  const files = Array.isArray(existingFiles)
    ? existingFiles.filter((file): file is string => typeof file === "string")
    : [];

  return Array.from(new Set([...files, ...renderedFiles]));
}

function isRenderConfigFile(value: unknown): value is RenderConfigFile {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.draftRoot === "string"
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
