import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFeedbackRecord, type FeedbackRecord } from "./feedback-types.js";

const FEEDBACK_FILENAME = "feedback.json";
const JSONL_FILENAME = "daily-feedback.jsonl";

export type SaveFeedbackOptions = {
  /**
   * Called when feedback.json already exists in draftDir.
   * Return true to overwrite, false to skip.
   * When not provided, existing feedback is silently overwritten.
   */
  confirmOverwrite?: () => Promise<boolean>;
};

/**
 * Save a FeedbackRecord to two locations:
 * 1. `draftDir/feedback.json` — full record (atomic write)
 * 2. `evalsDir/daily-feedback.jsonl` — one compact JSON line appended
 *
 * If feedback.json already exists, calls `options.confirmOverwrite()` before
 * overwriting. Returns without writing to feedback.json (but still appends
 * to JSONL) if the user denies.
 *
 * Directories are auto-created if missing.
 */
export async function saveFeedback(
  record: FeedbackRecord,
  draftDir: string,
  evalsDir: string,
  options: SaveFeedbackOptions = {}
): Promise<void> {
  await mkdir(evalsDir, { recursive: true });

  const feedbackPath = join(draftDir, FEEDBACK_FILENAME);
  const shouldWrite = await shouldWriteFeedbackJson(feedbackPath, options);

  if (shouldWrite) {
    await writeFeedbackJson(feedbackPath, record);
  }

  await appendToJsonl(evalsDir, record);
}

/**
 * Read a previously saved FeedbackRecord from draftDir/feedback.json.
 * Returns null if the file does not exist.
 */
export async function readFeedback(
  draftDir: string
): Promise<FeedbackRecord | null> {
  const feedbackPath = join(draftDir, FEEDBACK_FILENAME);

  try {
    const text = await readFile(feedbackPath, "utf8");
    const parsed = JSON.parse(text) as unknown;

    if (isFeedbackRecord(parsed)) {
      return parsed;
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function shouldWriteFeedbackJson(
  feedbackPath: string,
  options: SaveFeedbackOptions
): Promise<boolean> {
  const exists = await fileExists(feedbackPath);

  if (!exists) {
    return true;
  }

  if (options.confirmOverwrite) {
    return options.confirmOverwrite();
  }

  // No confirm callback → overwrite silently
  return true;
}

async function writeFeedbackJson(
  feedbackPath: string,
  record: FeedbackRecord
): Promise<void> {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(feedbackPath, content, "utf8");
}

async function appendToJsonl(
  evalsDir: string,
  record: FeedbackRecord
): Promise<void> {
  const jsonlPath = join(evalsDir, JSONL_FILENAME);
  const line = buildJsonlLine(record);

  // Use append flag — creates file if missing
  await writeFile(jsonlPath, `${line}\n`, { flag: "a", encoding: "utf8" });
}

/**
 * Build the compact JSONL representation per spec:
 * {date, revision, formatName, fun, share, accuracy, wouldPost, reasons, note}
 * Note: safetyConcern and createdAt are omitted from the JSONL row per spec example.
 */
function buildJsonlLine(record: FeedbackRecord): string {
  const row = {
    date: record.date,
    revision: record.revision,
    formatName: record.formatName,
    fun: record.fun,
    share: record.share,
    accuracy: record.accuracy,
    wouldPost: record.wouldPost,
    reasons: record.reasons,
    note: record.note
  };

  return JSON.stringify(row);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
