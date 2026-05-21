import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FEEDBACK_REASONS, REASON_PROMPT_AREA_MAP, type FeedbackReason } from "./feedback-types.js";

const JSONL_FILENAME = "daily-feedback.jsonl";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReasonCount = {
  reason: FeedbackReason;
  count: number;
};

export type FormatSummary = {
  formatName: string;
  averageFun: number;
  averageShare: number;
};

export type FeedbackAggregate = {
  days: number;
  totalDrafts: number;
  averageFun: number | null;
  averageShare: number | null;
  averageAccuracy: number | null;
  wouldPostCount: number;
  topReasons: ReasonCount[];
  bestFormats: FormatSummary[];
  recommendedWork: string[];
};

// ---------------------------------------------------------------------------
// JSONL row shape (as stored by feedback-storage)
// ---------------------------------------------------------------------------

type JsonlRow = {
  date: string;
  revision: string;
  formatName: string;
  fun: number;
  share: number;
  accuracy: number;
  wouldPost: boolean;
  reasons: string[];
  note: string;
};

// ---------------------------------------------------------------------------
// aggregateFeedback
// ---------------------------------------------------------------------------

/**
 * Read ~/Uncommitted/evals/daily-feedback.jsonl, filter to entries within
 * the last `days` days (inclusive, from `referenceDate`), and aggregate.
 *
 * @param evalsDir   Directory containing daily-feedback.jsonl
 * @param days       Number of days window (default 7)
 * @param referenceDate ISO date string "YYYY-MM-DD" (defaults to today)
 */
export async function aggregateFeedback(
  evalsDir: string,
  days = 7,
  referenceDate?: string
): Promise<FeedbackAggregate> {
  const cutoffDate = computeCutoffDate(referenceDate ?? todayIso(), days);
  const rows = await readFilteredRows(evalsDir, cutoffDate, referenceDate ?? todayIso());

  return computeAggregate(rows, days);
}

// ---------------------------------------------------------------------------
// formatFeedbackReport
// ---------------------------------------------------------------------------

/**
 * Format an aggregate as human-readable text matching the spec.
 */
export function formatFeedbackReport(agg: FeedbackAggregate): string {
  const lines: string[] = [];

  lines.push(`Feedback report: last ${agg.days} drafts`);
  lines.push("");

  if (agg.totalDrafts === 0) {
    lines.push(`No feedback found in the last ${agg.days} days. Submit feedback with \`uncommitted feedback latest\`.`);
    return lines.join("\n");
  }

  // Average scores
  lines.push("Average scores:");
  lines.push(`- Fun: ${fmt(agg.averageFun)} / 5`);
  lines.push(`- Share: ${fmt(agg.averageShare)} / 5`);
  lines.push(`- Accuracy: ${fmt(agg.averageAccuracy)} / 5`);
  lines.push("");

  // Would post
  lines.push("Would post:");
  lines.push(`- ${agg.wouldPostCount} / ${agg.totalDrafts} drafts`);
  lines.push("");

  // Top issues
  if (agg.topReasons.length > 0) {
    lines.push("Top issues:");
    for (const { reason, count } of agg.topReasons) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }

  // Best performing formats
  if (agg.bestFormats.length > 0) {
    lines.push("Best performing formats:");
    for (const { formatName, averageFun, averageShare } of agg.bestFormats) {
      lines.push(`- ${formatName}: fun ${fmt(averageFun)}, share ${fmt(averageShare)}`);
    }
    lines.push("");
  }

  // Recommended next prompt work
  if (agg.recommendedWork.length > 0) {
    lines.push("Recommended next prompt work:");
    agg.recommendedWork.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item}`);
    });
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute the inclusive lower-bound date given a reference date and window.
 * e.g. referenceDate=2026-05-19, days=7 → cutoff=2026-05-13
 */
function computeCutoffDate(referenceDate: string, days: number): string {
  const ref = new Date(`${referenceDate}T00:00:00.000Z`);
  ref.setUTCDate(ref.getUTCDate() - (days - 1));
  return ref.toISOString().slice(0, 10);
}

async function readFilteredRows(
  evalsDir: string,
  cutoffDate: string,
  referenceDate: string
): Promise<JsonlRow[]> {
  const jsonlPath = join(evalsDir, JSONL_FILENAME);

  let text: string;

  try {
    text = await readFile(jsonlPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const rows: JsonlRow[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (isJsonlRow(parsed)) {
        if (parsed.date >= cutoffDate && parsed.date <= referenceDate) {
          rows.push(parsed);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return rows;
}

function computeAggregate(rows: JsonlRow[], days: number): FeedbackAggregate {
  if (rows.length === 0) {
    return {
      days,
      totalDrafts: 0,
      averageFun: null,
      averageShare: null,
      averageAccuracy: null,
      wouldPostCount: 0,
      topReasons: [],
      bestFormats: [],
      recommendedWork: []
    };
  }

  const totalDrafts = rows.length;

  // Averages
  const averageFun = avg(rows.map((r) => r.fun));
  const averageShare = avg(rows.map((r) => r.share));
  const averageAccuracy = avg(rows.map((r) => r.accuracy));

  // Would post
  const wouldPostCount = rows.filter((r) => r.wouldPost).length;

  // Top reasons
  const reasonCounts = new Map<FeedbackReason, number>();

  for (const row of rows) {
    for (const reason of row.reasons) {
      if (isFeedbackReason(reason)) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
  }

  const topReasons: ReasonCount[] = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  // Best formats — group by formatName, compute avg fun/share
  const formatMap = new Map<string, { funSum: number; shareSum: number; count: number }>();

  for (const row of rows) {
    const name = row.formatName || "(unnamed)";
    const existing = formatMap.get(name) ?? { funSum: 0, shareSum: 0, count: 0 };
    formatMap.set(name, {
      funSum: existing.funSum + row.fun,
      shareSum: existing.shareSum + row.share,
      count: existing.count + 1
    });
  }

  const bestFormats: FormatSummary[] = Array.from(formatMap.entries())
    .map(([formatName, { funSum, shareSum, count }]) => ({
      formatName,
      averageFun: round1(funSum / count),
      averageShare: round1(shareSum / count)
    }))
    .sort((a, b) => b.averageFun - a.averageFun || b.averageShare - a.averageShare);

  // Recommended work — deduplicate prompt areas from top reasons
  const seenAreas = new Set<string>();
  const recommendedWork: string[] = [];

  for (const { reason } of topReasons) {
    const area = REASON_PROMPT_AREA_MAP[reason];

    if (area && !seenAreas.has(area)) {
      seenAreas.add(area);
      recommendedWork.push(buildRecommendation(reason, area));
    }
  }

  return {
    days,
    totalDrafts,
    averageFun: round1(averageFun),
    averageShare: round1(averageShare),
    averageAccuracy: round1(averageAccuracy),
    wouldPostCount,
    topReasons,
    bestFormats,
    recommendedWork
  };
}

function buildRecommendation(reason: FeedbackReason, area: string): string {
  const verbs: Partial<Record<FeedbackReason, string>> = {
    "too-report-like": "avoid report-like phrasing",
    "too-generic": "add specificity constraints",
    "repetitive-format": "add format novelty constraints",
    "weak-caption": "add stronger caption examples",
    "inaccurate": "improve accuracy constraints",
    "hallucinated-work": "tighten factual constraints",
    "too-harsh": "soften roast policy",
    "not-instagram-like": "align with Instagram tone",
    "card-overflow": "enforce length limits",
    "safety-concern": "review safety rules",
    "too-boring": "increase variety",
    "too-long": "enforce brevity",
    "awkward-roast": "refine persona voice",
    "other": "review general quality"
  };

  const verb = verbs[reason] ?? "improve output quality";
  return `Improve ${area} to ${verb}.`;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function fmt(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(1);
}

function isFeedbackReason(value: string): value is FeedbackReason {
  return (FEEDBACK_REASONS as readonly string[]).includes(value);
}

function isJsonlRow(value: unknown): value is JsonlRow {
  if (!isRecord(value)) return false;

  return (
    typeof value.date === "string" &&
    typeof value.revision === "string" &&
    typeof value.formatName === "string" &&
    typeof value.fun === "number" &&
    typeof value.share === "number" &&
    typeof value.accuracy === "number" &&
    typeof value.wouldPost === "boolean" &&
    Array.isArray(value.reasons) &&
    typeof value.note === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
