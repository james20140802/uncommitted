import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Resolved draft revision location under a draft root.
 */
export type RevisionResult = {
  revision: string;
  outputDir: string;
};

/**
 * Thrown by {@link resolveSpecificRev} when the caller passes a revision
 * string that doesn't match the canonical `rev-NNN` (three-digit) format.
 *
 * CLI callers should catch this and surface a friendly usage message.
 */
export class RevisionFormatError extends Error {
  constructor(public readonly revision: string) {
    super(
      `Invalid revision format: "${revision}". Expected "rev-NNN" (e.g. rev-001).`
    );
    this.name = "RevisionFormatError";
  }
}

const REVISION_PATTERN = /^rev-\d{3}$/;

/**
 * Find the highest revision under `draftRoot/targetDate/`.
 * Returns `null` when the date directory is missing or contains no
 * `rev-NNN` entries.
 */
export async function resolveLatestRevForDate(
  draftRoot: string,
  targetDate: string
): Promise<RevisionResult | null> {
  const dateDir = join(draftRoot, targetDate);

  try {
    const entries = await readdir(dateDir);
    const revisions = entries
      .filter((e) => REVISION_PATTERN.test(e))
      .sort((a, b) => b.localeCompare(a)); // descending

    if (revisions.length === 0) {
      return null;
    }

    const revision = revisions[0];
    return { revision, outputDir: join(dateDir, revision) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Resolve a specific revision under `draftRoot/targetDate/<revision>`.
 *
 * Throws {@link RevisionFormatError} when `revision` does not match
 * the canonical `rev-NNN` format. Returns `null` when the revision
 * directory is missing.
 */
export async function resolveSpecificRev(
  draftRoot: string,
  targetDate: string,
  revision: string
): Promise<RevisionResult | null> {
  if (!REVISION_PATTERN.test(revision)) {
    throw new RevisionFormatError(revision);
  }

  const dateDir = join(draftRoot, targetDate);

  try {
    const entries = await readdir(dateDir);
    if (!entries.includes(revision)) {
      return null;
    }
    return { revision, outputDir: join(dateDir, revision) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
