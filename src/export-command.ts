import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  /**
   * Present when safetyStatus is "warning". Includes the reason from
   * safety-report.json. The caller (CLI layer) should print this to stderr.
   */
  warningMessage?: string;
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
 * Safety policy (UNC-94):
 *  - safe: export proceeds silently.
 *  - warning: export proceeds; result.warningMessage contains the reason.
 *  - blocked: throws ExportCommandError("safety-blocked") before any folder is created.
 *
 * Ordering: safety is enforced BEFORE creating the export folder so that a
 * blocked draft never leaves behind a partial export directory.
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

  // 3. Read safety report (status + reason)
  const safetyInfo = await readSafetyInfo(sourceDraftPath);

  // 4. Enforce safety policy BEFORE touching the export folder
  const policyResult = checkSafetyPolicy(safetyInfo.status, safetyInfo.reason);

  // 5. Collect carousel PNGs (validate BEFORE creating export folder)
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
    safetyStatus: safetyInfo.status,
    exportedFiles: [...exportedFiles, "metadata.json"]
  });
  exportedFiles.push("metadata.json");

  return {
    exportDir,
    exportedFiles,
    safetyStatus: safetyInfo.status,
    sourceDraftPath,
    exportedAt,
    warningMessage: policyResult.warningMessage
  };
}

// ---------------------------------------------------------------------------
// Safety policy helpers
// ---------------------------------------------------------------------------

/**
 * Enforces the MVP safety policy.
 *
 * - "safe": returns {} (no warning).
 * - "warning": returns { warningMessage } with the reason string.
 * - "blocked": throws ExportCommandError with code "safety-blocked".
 *
 * Kept as a small dedicated function so future overrides can wrap it.
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

  if (args.length > 2) {
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

type SafetyInfo = {
  status: SafetyStatus;
  /** The human-readable reason from safety-report.json (used as warning reason) */
  reason?: string;
};

async function readSafetyInfo(sourceDraftPath: string): Promise<SafetyInfo> {
  try {
    const raw = await readFile(
      join(sourceDraftPath, "safety-report.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as unknown;

    if (
      isRecord(parsed) &&
      (parsed.status === "safe" ||
        parsed.status === "warning" ||
        parsed.status === "blocked")
    ) {
      const reason =
        typeof parsed.message === "string" ? parsed.message : undefined;
      return { status: parsed.status as SafetyStatus, reason };
    }
  } catch {
    // If no safety report file, treat as safe (graceful degradation)
  }

  return { status: "safe" };
}

async function collectCarouselPngs(sourceDraftPath: string): Promise<string[]> {
  const carouselDir = join(sourceDraftPath, "carousel");

  let entries: string[];
  try {
    entries = await readdir(carouselDir);
  } catch {
    throw new ExportCommandError(
      "No carousel PNGs found. Run `uncommitted render latest` first.",
      "missing-carousel"
    );
  }

  const pngs = entries.filter((e) => e.endsWith(".png")).sort();

  if (pngs.length === 0) {
    throw new ExportCommandError(
      "No carousel PNGs found. Run `uncommitted render latest` first.",
      "missing-carousel"
    );
  }

  return pngs;
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
