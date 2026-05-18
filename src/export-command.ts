import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLatestDraftPointer } from "./draft-storage.js";
import type { SafetyStatus } from "./safety-report.js";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type ExportCommandErrorCode =
  | "invalid-arguments"
  | "invalid-config"
  | "missing-draft"
  | "missing-carousel"
  | "safety-blocked"
  | "export-failed";

export class ExportCommandError extends Error {
  constructor(
    message: string,
    public readonly code: ExportCommandErrorCode
  ) {
    super(message);
    this.name = "ExportCommandError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportCommandOptions = {
  /** Draft root directory (e.g. ~/Uncommitted/drafts) */
  draftRoot: string;
  /** Returns ISO timestamp for export time. Defaults to new Date().toISOString() */
  now?: () => string;
};

export type ExportCommandResult = {
  /** Absolute path to the created export folder */
  exportDir: string;
  /** List of file names (relative to exportDir) that were written */
  exportedFiles: string[];
  safetyStatus: SafetyStatus;
  sourceDraftPath: string;
  exportedAt: string;
};

export type ExportMetadata = {
  schemaVersion: 1;
  sourceDraftPath: string;
  exportedAt: string;
  safetyStatus: SafetyStatus;
  exportedFiles: string[];
};

// ---------------------------------------------------------------------------
// Usage hint
// ---------------------------------------------------------------------------

const USAGE = "Usage: uncommitted export instagram";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the `export instagram [latest]` command.
 *
 * Happy-path flow (UNC-92 scaffold):
 *  1. Resolve the latest draft via latest.json pointer.
 *  2. Create export folder under {draftRoot}/exports/instagram/{date}/{revision}/.
 *  3. Copy caption.txt verbatim.
 *  4. Copy carousel PNGs with zero-padded names (carousel-01.png, ...).
 *  5. Write metadata.json recording source, timestamp, safety status, file list.
 *
 * Safety policy enforcement (UNC-94), missing-file handling (UNC-95), and
 * idempotency (UNC-96) are layered on top in subsequent sub-issues.
 */
export async function runExportCommand(
  args: string[],
  options: ExportCommandOptions
): Promise<ExportCommandResult> {
  // 1. Validate arguments
  validateArgs(args);

  const exportedAt = options.now ? options.now() : new Date().toISOString();
  const { draftRoot } = options;

  // 2. Resolve latest draft pointer
  const pointer = await resolveLatestPointer(draftRoot);
  const sourceDraftPath = pointer.path;

  // 3. Read safety report from the draft
  const safetyStatus = await readSafetyStatus(sourceDraftPath);

  // 4. Enforce safety policy
  enforceSafetyPolicy(safetyStatus);

  // 5. Collect carousel PNGs
  const carouselPngs = await collectCarouselPngs(sourceDraftPath);

  // 6. Create export folder
  const exportDir = join(
    draftRoot,
    "exports",
    "instagram",
    pointer.targetDate,
    pointer.revision
  );
  await createExportDir(exportDir);

  // 7. Copy files
  const exportedFiles: string[] = [];

  await copyCaptionTxt(sourceDraftPath, exportDir, exportedFiles);
  await copyCarouselPngs(sourceDraftPath, carouselPngs, exportDir, exportedFiles);

  // 8. Write export metadata.json
  await writeExportMetadata(exportDir, {
    schemaVersion: 1,
    sourceDraftPath,
    exportedAt,
    safetyStatus,
    exportedFiles: [...exportedFiles, "metadata.json"]
  });
  exportedFiles.push("metadata.json");

  return {
    exportDir,
    exportedFiles,
    safetyStatus,
    sourceDraftPath,
    exportedAt
  };
}

// ---------------------------------------------------------------------------
// Safety policy helpers (extended in UNC-94)
// ---------------------------------------------------------------------------

/**
 * Returns a warning message when the safety status is "warning", or undefined
 * when safe. Throws ExportCommandError for "blocked".
 *
 * This is intentionally a small, isolated function so UNC-94 can wrap it.
 */
export function checkSafetyPolicy(
  safetyStatus: SafetyStatus,
  warningReason?: string
): { warningMessage?: string } {
  if (safetyStatus === "blocked") {
    throw new ExportCommandError(
      "Export blocked: draft contains sensitive content. Review safety-report.json.",
      "safety-blocked"
    );
  }

  if (safetyStatus === "warning") {
    const reason = warningReason ?? "Review redacted content before posting.";
    return { warningMessage: `Safety warning: ${reason}` };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateArgs(args: string[]): void {
  const [subcommand, target] = args;

  if (subcommand !== "instagram") {
    throw new ExportCommandError(USAGE, "invalid-arguments");
  }

  if (target !== undefined && target !== "latest") {
    throw new ExportCommandError(USAGE, "invalid-arguments");
  }
}

async function resolveLatestPointer(draftRoot: string) {
  try {
    return await readLatestDraftPointer(draftRoot);
  } catch {
    throw new ExportCommandError(
      "No latest draft found. Run `uncommitted generate today` and `uncommitted render latest` first.",
      "missing-draft"
    );
  }
}

async function readSafetyStatus(sourceDraftPath: string): Promise<SafetyStatus> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(join(sourceDraftPath, "safety-report.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (
      isRecord(parsed) &&
      (parsed.status === "safe" ||
        parsed.status === "warning" ||
        parsed.status === "blocked")
    ) {
      return parsed.status as SafetyStatus;
    }
  } catch {
    // If no safety report, treat as safe for scaffold (UNC-94 adds strict policy)
  }

  return "safe";
}

function enforceSafetyPolicy(safetyStatus: SafetyStatus): void {
  // Scaffold: only block "blocked" status. UNC-94 adds warning output.
  if (safetyStatus === "blocked") {
    throw new ExportCommandError(
      "Export blocked: draft contains sensitive content. Review safety-report.json.",
      "safety-blocked"
    );
  }
}

async function collectCarouselPngs(sourceDraftPath: string): Promise<string[]> {
  const carouselDir = join(sourceDraftPath, "carousel");

  try {
    const entries = await readdir(carouselDir);
    const pngs = entries
      .filter((e) => e.endsWith(".png"))
      .sort();

    if (pngs.length === 0) {
      throw new ExportCommandError(
        "No carousel PNGs found. Run `uncommitted render latest` first.",
        "missing-carousel"
      );
    }

    return pngs;
  } catch (error) {
    if (error instanceof ExportCommandError) {
      throw error;
    }

    throw new ExportCommandError(
      "No carousel PNGs found. Run `uncommitted render latest` first.",
      "missing-carousel"
    );
  }
}

async function createExportDir(exportDir: string): Promise<void> {
  try {
    await mkdir(exportDir, { recursive: true });
  } catch {
    throw new ExportCommandError(
      "Could not create export folder.",
      "export-failed"
    );
  }
}

async function copyCaptionTxt(
  sourceDraftPath: string,
  exportDir: string,
  exportedFiles: string[]
): Promise<void> {
  const src = join(sourceDraftPath, "caption.txt");
  const dst = join(exportDir, "caption.txt");

  try {
    await copyFile(src, dst);
    exportedFiles.push("caption.txt");
  } catch {
    throw new ExportCommandError(
      "caption.txt is missing from the draft.",
      "export-failed"
    );
  }
}

async function copyCarouselPngs(
  sourceDraftPath: string,
  carouselPngs: string[],
  exportDir: string,
  exportedFiles: string[]
): Promise<void> {
  for (let i = 0; i < carouselPngs.length; i++) {
    const srcName = carouselPngs[i];
    const dstName = `carousel-${String(i + 1).padStart(2, "0")}.png`;
    const src = join(sourceDraftPath, "carousel", srcName);
    const dst = join(exportDir, dstName);

    try {
      await copyFile(src, dst);
      exportedFiles.push(dstName);
    } catch {
      throw new ExportCommandError(
        `Carousel file ${srcName} could not be copied.`,
        "export-failed"
      );
    }
  }
}

async function writeExportMetadata(
  exportDir: string,
  metadata: ExportMetadata
): Promise<void> {
  try {
    await writeFile(
      join(exportDir, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
  } catch {
    throw new ExportCommandError(
      "Could not write export metadata.",
      "export-failed"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
