/**
 * Normalized activity signal contract shared by all event sources
 * (git, Claude session logs, Codex session logs, GitHub PRs, manual notes).
 *
 * The shape is intentionally minimal:
 *   - projectId    — stable id of the originating project
 *   - timestamp    — ISO-8601 UTC instant of the signal
 *   - kind         — extensible union string; consumers should treat
 *                    unknown kinds as opaque and route by string match
 *   - summary      — short human-readable line, already sanitized
 *   - safetyNotes  — redaction categories that were applied to summary
 *                    (subset of the canonical list maintained by
 *                    activity-summary.ts: 'emails', 'local absolute paths',
 *                    'private URLs', 'raw code snippets')
 *
 * Source-specific metadata (commit stats, file status, etc.) is NOT
 * carried on the signal. Consumers needing source-specific aggregation
 * must read it from the source-shaped event input (e.g. GitActivityEvent),
 * not from the signal stream.
 */
export type ActivitySignalKind =
  | "commit"
  | "pr"
  | "note"
  | "dirty-file"
  | (string & {}); // extensible union — future sources may add their own kinds

export type ActivitySignal = {
  projectId: string;
  timestamp: string;
  kind: ActivitySignalKind;
  summary: string;
  safetyNotes: string[];
};

export interface EventSource {
  collect(): Promise<ActivitySignal[]>;
}

export function isActivitySignal(value: unknown): value is ActivitySignal {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.projectId === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.safetyNotes) &&
    candidate.safetyNotes.every((note) => typeof note === "string")
  );
}
