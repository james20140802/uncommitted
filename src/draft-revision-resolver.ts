import { readdir, readFile } from "node:fs/promises";
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
 * Resolve the latest revision under `draftRoot/targetDate/`.
 *
 * Prefers the per-date latest pointer (`<targetDate>/latest.json`), which the
 * storage layer writes only after a generation finishes writing all artifacts,
 * so it records the last *complete* draft. This guards against a crashed
 * generation that leaves a higher `rev-NNN` directory behind: a plain directory
 * scan would wrongly select that incomplete revision. Falls back to the highest
 * `rev-NNN` on disk when the pointer is absent or malformed.
 *
 * Returns `null` when the date directory is missing or contains no
 * `rev-NNN` entries.
 */
export async function resolveLatestRevForDate(
  draftRoot: string,
  targetDate: string
): Promise<RevisionResult | null> {
  const dateDir = join(draftRoot, targetDate);

  const pointed = await readDatePointerRevision(dateDir);
  if (pointed !== null) {
    return { revision: pointed, outputDir: join(dateDir, pointed) };
  }

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
 * Read the revision recorded by `<dateDir>/latest.json`, the per-date latest
 * pointer. Returns `null` when the pointer is absent or malformed so callers
 * fall back to a directory scan.
 */
async function readDatePointerRevision(
  dateDir: string
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(dateDir, "latest.json"), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).revision === "string"
    ) {
      const revision = (parsed as Record<string, unknown>).revision as string;
      if (REVISION_PATTERN.test(revision)) {
        return revision;
      }
    }
  } catch {
    return null;
  }

  return null;
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
