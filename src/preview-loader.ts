import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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

  // 2. Read caption.txt (optional — null if missing)
  const caption = await readCaptionOptional(outputDir);

  // 3. Parse required JSON artifacts
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

  // 4. Scan carousel directory for *.png files
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
  } catch {
    return null;
  }
}

async function readCarouselPngs(outputDir: string): Promise<string[]> {
  const carouselDir = join(outputDir, "carousel");
  let entries: string[];

  try {
    entries = await readdir(carouselDir);
  } catch {
    return [];
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
