// Tier 1 raw archive reader + Tier 2 projection orchestration (UNC-164).
//
// This module is READ-ONLY over the Tier 1 `raw/` archives written by the
// session/github collectors. It never collects or mutates source data; it only
// projects the day's raw narrative material into a budgeted projection for the
// downstream caption writer.
//
// Per-source gating honors the UNC-120 opt-out config: a disabled source
// contributes ZERO turns and is recorded distinctly from an absent archive, so
// callers can tell "user turned this off" apart from "nothing happened here".
//
// Raw archives are SUPPLEMENTARY, already-redacted input: a malformed line or a
// missing file must never throw or block diary generation. We mirror
// `readSessionActivitySignals` in generate-command.ts — skip bad lines silently
// and treat ENOENT as an empty (no-archive) source.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assembleRawNarrativeProjection,
  defaultTokenCounter,
  emptyRawNarrativeProjection,
  readCaptionProjectionTokenBudget,
  type NarrativeSource,
  type NarrativeTurn,
  type RawNarrativeProjection,
  type TokenCounter
} from "./raw-narrative-projection.js";
import { selectTurns } from "./raw-narrative-selection.js";
import { revalidateTurnsForEgress } from "./raw-narrative-egress.js";
import type { SourceConfigMap } from "./source-config.js";

// Sources whose Tier 1 raw archives this reader projects. Git is excluded — it
// has no conversational raw archive (its events are structured commit data).
const RAW_NARRATIVE_SOURCES: readonly NarrativeSource[] = [
  "claude",
  "codex",
  "github"
];

export type Tier1DiscoveryStatus = "disabled" | "no-archive" | "read";

export type Tier1Discovery = {
  projectId: string;
  source: NarrativeSource;
  status: Tier1DiscoveryStatus;
  turnCount: number;
};

export type ProjectInput = {
  id: string;
  root: string;
};

export type ReadTier1ArchivesInput = {
  projects: ProjectInput[];
  // Normalized per-source toggle map from loadSourceConfig (UNC-120). Typed
  // (not `unknown`) so the gate below is compile-checked against the actual
  // shape callers pass — a `SourceConfigMap` keyed by source, NOT the raw
  // config object with a `.sources` wrapper.
  sourceConfig: SourceConfigMap;
  targetDate: string;
};

export type ReadTier1ArchivesResult = {
  turns: NarrativeTurn[];
  discoveries: Tier1Discovery[];
};

/**
 * Lightweight, deterministic marker check: does the text look like it carries
 * code or a tool/command reference? Cheap regex over common, stable markers —
 * code fences (```), inline backticks, and a handful of language/CLI tokens.
 * Conservative on purpose: a false positive only nudges selection density, it
 * never mutates text or egresses anything.
 */
export function hasCodeOrToolMarker(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  if (text.includes("```") || text.includes("`")) {
    return true;
  }
  return /\b(function|const|=>|import |class |def |\$ |npm |git )/.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

/**
 * Normalize a single parsed JSONL entry into a NarrativeTurn, or undefined when
 * the entry carries no usable text (skip it silently).
 */
function normalizeEntry(
  entry: unknown,
  source: NarrativeSource,
  sessionId: string
): NarrativeTurn | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const kind = entry.kind;

  if (kind === "turn") {
    // claude/codex conversation turn.
    if (typeof entry.text !== "string" || entry.text.length === 0) {
      return undefined;
    }
    const text = entry.text;
    return {
      source,
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      sessionId,
      hasCodeOrToolMarker: hasCodeOrToolMarker(text)
    };
  }

  if (kind === "tool") {
    // claude/codex tool fact. Combine `tool` + optional `target`.
    if (typeof entry.tool !== "string" || entry.tool.length === 0) {
      return undefined;
    }
    const target = typeof entry.target === "string" ? entry.target : "";
    const text = `${entry.tool}${target ? " " + target : ""}`.trim();
    if (text.length === 0) {
      return undefined;
    }
    return {
      source,
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      sessionId,
      hasCodeOrToolMarker: true
    };
  }

  // GitHub own-authored body entries have NO `kind`. The human-authored text
  // lives in `text` (see OwnAuthoredBody in github-event-normalizer.ts); the
  // timestamp field is `timestamp`.
  if (source === "github") {
    const text = firstString(entry.text);
    if (text.length === 0) {
      return undefined;
    }
    return {
      source: "github",
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      sessionId,
      hasCodeOrToolMarker: hasCodeOrToolMarker(text)
    };
  }

  return undefined;
}

/**
 * Read the day's Tier 1 raw archives across all projects and sources,
 * normalizing each entry into a NarrativeTurn. Source gating, absence, and read
 * are all recorded as distinct discovery statuses.
 *
 * One archive FILE is treated as one session (we lack explicit session markers
 * in the raw archive), keyed `${source}:${projectId}:${targetDate}`.
 */
export async function readTier1Archives(
  input: ReadTier1ArchivesInput
): Promise<ReadTier1ArchivesResult> {
  const turns: NarrativeTurn[] = [];
  const discoveries: Tier1Discovery[] = [];

  for (const project of input.projects) {
    for (const source of RAW_NARRATIVE_SOURCES) {
      if (input.sourceConfig[source].enabled === false) {
        discoveries.push({
          projectId: project.id,
          source,
          status: "disabled",
          turnCount: 0
        });
        continue;
      }

      const file = join(
        project.root,
        ".uncommitted",
        "events",
        source,
        "raw",
        `${input.targetDate}.jsonl`
      );

      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        if (isNotFoundError(error)) {
          discoveries.push({
            projectId: project.id,
            source,
            status: "no-archive",
            turnCount: 0
          });
          continue;
        }
        // Any other read error (permissions/IO): treat as no-archive rather
        // than blocking generation. Raw archives are supplementary input.
        discoveries.push({
          projectId: project.id,
          source,
          status: "no-archive",
          turnCount: 0
        });
        continue;
      }

      const sessionId = `${source}:${project.id}:${input.targetDate}`;
      let turnCount = 0;

      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Malformed line: skip silently, never throw.
          continue;
        }
        const turn = normalizeEntry(parsed, source, sessionId);
        if (turn !== undefined) {
          turns.push(turn);
          turnCount += 1;
        }
      }

      discoveries.push({
        projectId: project.id,
        source,
        status: "read",
        turnCount
      });
    }
  }

  return { turns, discoveries };
}

export type BuildRawNarrativeProjectionInput = {
  projects: ProjectInput[];
  sourceConfig: SourceConfigMap;
  configFilePath: string;
  targetDate: string;
  budget?: number;
  tokenCounter?: TokenCounter;
};

/**
 * Orchestrate the full Tier 2 pipeline over the day's Tier 1 archives:
 *   read archives -> selectTurns (budgeted) -> egress revalidation ->
 *   assemble projection. Egress drops are FOLDED (summed) into the final
 *   projection counters so dropped secret turns remain visible to callers.
 *
 * When there are no turns at all (absent or all-disabled), returns an empty
 * projection echoing the resolved budget — a faithful no-op.
 */
export async function buildRawNarrativeProjection(
  input: BuildRawNarrativeProjectionInput
): Promise<RawNarrativeProjection> {
  const tokenCounter = input.tokenCounter ?? defaultTokenCounter;
  const budget =
    input.budget ?? (await readCaptionProjectionTokenBudget(input.configFilePath));

  const { turns } = await readTier1Archives({
    projects: input.projects,
    sourceConfig: input.sourceConfig,
    targetDate: input.targetDate
  });

  if (turns.length === 0) {
    return emptyRawNarrativeProjection(budget);
  }

  const selected = selectTurns(turns, { budget, tokenCounter });
  const reval = revalidateTurnsForEgress(selected, tokenCounter);
  const projection = assembleRawNarrativeProjection(reval.kept, {
    budget,
    tokenCounter
  });

  return {
    ...projection,
    droppedTurns: projection.droppedTurns + reval.droppedTurns,
    droppedTokens: projection.droppedTokens + reval.droppedTokens
  };
}
