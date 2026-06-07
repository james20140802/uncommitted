import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DraftStorageError, readLatestDraftPointer } from "./draft-storage.js";
import { isSafetyReport, type SafetyReport } from "./safety-report.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PreviewLoaderSuccess = {
  outcome: "success";
  targetDate: string;
  revision: string;
  outputDir: string;
  caption: string | null;
  story: Record<string, unknown>;
  metadata: Record<string, unknown>;
  safetyReport: SafetyReport;
  carouselPngs: string[]; // sorted relative paths, e.g. ["carousel/01.png"]
};

export type PreviewLoaderMissing = {
  outcome: "missing";
  message: string;
};

export type PreviewLoaderMalformed = {
  outcome: "malformed";
  file: string;
  message: string;
};

export type PreviewLoaderResult =
  | PreviewLoaderSuccess
  | PreviewLoaderMissing
  | PreviewLoaderMalformed;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function loadLatestDraftPreview(
  draftRoot: string
): Promise<PreviewLoaderResult> {
  // 1. Resolve latest pointer
  let outputDir: string;
  let targetDate: string;
  let revision: string;

  try {
    const pointer = await readLatestDraftPointer(draftRoot);
    outputDir = pointer.path;
    targetDate = pointer.targetDate;
    revision = pointer.revision;
  } catch (error) {
    if (error instanceof DraftStorageError) {
      return {
        outcome: "missing",
        message: "No latest draft found. Run `uncommitted generate today` first."
      };
    }
    throw error;
  }

  if (!isPathInside(draftRoot, outputDir)) {
    return malformed(
      join(draftRoot, "latest.json"),
      "Latest draft pointer references a path outside the draft root."
    );
  }

  return loadDraftArtifacts(outputDir, targetDate, revision);
}

/**
 * Load preview artifacts for a specific revision directory.
 *
 * Mirrors {@link loadLatestDraftPreview} starting from the caption/JSON
 * artifact reads, but takes the resolved `outputDir`, `targetDate`, and
 * `revision` directly (callers resolve these via `draft-revision-resolver`).
 *
 * Guards that `outputDir` resolves inside `draftRoot`; otherwise returns
 * a `malformed` outcome citing the offending path.
 */
export async function loadDraftPreviewForRevision(
  draftRoot: string,
  outputDir: string,
  targetDate: string,
  revision: string
): Promise<PreviewLoaderResult> {
  if (!isPathInside(draftRoot, outputDir)) {
    return malformed(
      outputDir,
      "Draft revision path is outside the draft root."
    );
  }

  return loadDraftArtifacts(outputDir, targetDate, revision);
}

/**
 * Shared core: read caption.txt + the three required JSON artifacts +
 * scan the carousel directory. Used by both the latest-pointer entry
 * point and the explicit revision entry point.
 */
async function loadDraftArtifacts(
  outputDir: string,
  targetDate: string,
  revision: string
): Promise<PreviewLoaderResult> {
  // 1. Read caption.txt (optional — null if missing)
  const caption = await readCaptionOptional(outputDir);

  // 2. Parse required JSON artifacts
  const storyResult = await readRequiredJson(outputDir, "story.json");
  if (storyResult.outcome === "malformed") return storyResult;
  if (!isRecord(storyResult.value)) {
    return malformed(join(outputDir, "story.json"), "story.json is not a JSON object.");
  }

  const metadataResult = await readRequiredJson(outputDir, "metadata.json");
  if (metadataResult.outcome === "malformed") return metadataResult;
  if (!isRecord(metadataResult.value)) {
    return malformed(join(outputDir, "metadata.json"), "metadata.json is not a JSON object.");
  }

  const safetyResult = await readRequiredJson(outputDir, "safety-report.json");
  if (safetyResult.outcome === "malformed") return safetyResult;
  if (!isSafetyReport(safetyResult.value)) {
    return malformed(
      join(outputDir, "safety-report.json"),
      "safety-report.json does not match expected schema."
    );
  }

  // 3. Scan carousel directory for *.png files
  const carouselPngs = await readCarouselPngs(outputDir);

  return {
    outcome: "success",
    targetDate,
    revision,
    outputDir,
    caption,
    story: storyResult.value,
    metadata: metadataResult.value,
    safetyReport: safetyResult.value,
    carouselPngs
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type JsonReadSuccess = { outcome: "ok"; value: unknown };
type JsonReadMalformed = PreviewLoaderMalformed;
type JsonReadResult = JsonReadSuccess | JsonReadMalformed;

async function readRequiredJson(
  outputDir: string,
  filename: string
): Promise<JsonReadResult> {
  const filePath = join(outputDir, filename);
  try {
    const raw = await readFile(filePath, "utf8");
    const value = JSON.parse(raw) as unknown;
    return { outcome: "ok", value };
  } catch {
    return malformed(filePath, `${filename} is missing or contains invalid JSON.`);
  }
}

async function readCaptionOptional(outputDir: string): Promise<string | null> {
  try {
    return await readFile(join(outputDir, "caption.txt"), "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

async function readCarouselPngs(outputDir: string): Promise<string[]> {
  const carouselDir = join(outputDir, "carousel");
  let entries: string[];

  try {
    entries = await readdir(carouselDir);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    throw err;
  }

  return entries
    .filter((e) => e.toLowerCase().endsWith(".png"))
    .sort()
    .map((e) => `carousel/${e}`);
}

function malformed(filePath: string, message: string): PreviewLoaderMalformed {
  return { outcome: "malformed", file: filePath, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
