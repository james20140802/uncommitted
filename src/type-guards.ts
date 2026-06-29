/**
 * Shared runtime type guards used across config readers and validators.
 *
 * Previously `isRecord` and `isNodeError` were copy-pasted into six modules,
 * with one copy (`ai-provider.ts`) subtly accepting arrays. The canonical
 * `isRecord` here excludes arrays so every reader agrees on what "a config
 * object" means.
 */

/** True for non-null, non-array objects (plain records). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for `Error` instances carrying a Node `code` (e.g. `ENOENT`). */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
