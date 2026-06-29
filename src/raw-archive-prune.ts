import { readdir, stat, unlink } from "node:fs/promises";
import { loadGlobalConfig } from "./global-config.js";
import { isRecord } from "./type-guards.js";
import { join } from "node:path";

export type RawArchiveSource = "claude" | "codex" | "github";

export type PruneRawArchivesInput = {
  projectRoot: string;
  source: RawArchiveSource;
  today: string;
  retentionDays: number;
};

export type PruneRawArchivesResult = {
  deletedFiles: string[];
  errors: Array<{ file: string; message: string }>;
};

const DATE_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$/;

export async function pruneRawArchives(
  input: PruneRawArchivesInput
): Promise<PruneRawArchivesResult> {
  const { projectRoot, source, today, retentionDays } = input;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { deletedFiles: [], errors: [] };
  }

  const rawDir = join(projectRoot, ".uncommitted", "events", source, "raw");

  let entries: string[];
  try {
    entries = await readdir(rawDir);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { deletedFiles: [], errors: [] };
    }
    return {
      deletedFiles: [],
      errors: [{ file: rawDir, message: errorMessage(error) }]
    };
  }

  const cutoff = computeCutoff(today, retentionDays);
  if (cutoff === null) {
    return { deletedFiles: [], errors: [] };
  }

  const deletedFiles: string[] = [];
  const errors: Array<{ file: string; message: string }> = [];

  for (const entry of entries) {
    const match = entry.match(DATE_FILENAME_RE);
    if (!match) {
      continue;
    }
    const fileDate = match[1];
    if (!isValidYyyyMmDd(fileDate)) {
      continue;
    }
    if (fileDate >= cutoff) {
      continue;
    }
    const full = join(rawDir, entry);
    try {
      const s = await stat(full);
      if (!s.isFile()) {
        continue;
      }
      await unlink(full);
      deletedFiles.push(full);
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      errors.push({ file: full, message: errorMessage(error) });
    }
  }

  return { deletedFiles, errors };
}

export async function readRawRetentionDays(
  configFilePath: string
): Promise<number> {
  // 0 means "keep forever" (the unlimited sentinel), so every unreadable,
  // malformed, or invalid case falls back to no pruning.
  const outcome = await loadGlobalConfig(configFilePath);
  if (outcome.status !== "ok" || !isRecord(outcome.value)) {
    return 0;
  }
  const value = outcome.value.rawRetentionDays;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function computeCutoff(today: string, retentionDays: number): string | null {
  if (!isValidYyyyMmDd(today)) {
    return null;
  }
  const days = Math.floor(retentionDays);
  // Keep the most recent `days` days INCLUDING today. So cutoff is the
  // smallest YYYY-MM-DD that is kept; anything strictly less is deleted.
  // cutoff = today - (days - 1) days.
  const t = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10))
  );
  const cutoffMs = t - (days - 1) * 86_400_000;
  const d = new Date(cutoffMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isValidYyyyMmDd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
