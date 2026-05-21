/**
 * Feedback domain types, reason enum, prompt-area mapping, and score validation.
 * All other feedback modules depend on this foundational module.
 */

// ---------------------------------------------------------------------------
// FeedbackReason
// ---------------------------------------------------------------------------

export const FEEDBACK_REASONS = [
  "too-boring",
  "too-report-like",
  "too-long",
  "too-generic",
  "repetitive-format",
  "inaccurate",
  "hallucinated-work",
  "weak-caption",
  "awkward-roast",
  "too-harsh",
  "not-instagram-like",
  "card-overflow",
  "safety-concern",
  "other"
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export function isFeedbackReason(value: unknown): value is FeedbackReason {
  return (
    typeof value === "string" &&
    (FEEDBACK_REASONS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Reason → Prompt Area mapping
// Per spec table in UNC-98 / UNC-99 description
// ---------------------------------------------------------------------------

export const REASON_PROMPT_AREA_MAP: Record<FeedbackReason, string> = {
  "too-boring": "Diary Writer prompt",
  "too-report-like": "Diary Writer prompt",
  "too-long": "Writer length constraint",
  "too-generic": "Story Inventor + Writer prompt",
  "repetitive-format": "Story Inventor prompt + format history",
  "inaccurate": "Activity Summary prompt",
  "hallucinated-work": "Activity Summary + Writer constraints",
  "weak-caption": "Caption prompt",
  "awkward-roast": "Persona / roast level prompt",
  "too-harsh": "Roast policy + Safety Reviewer",
  "not-instagram-like": "Caption + slide copy prompt",
  "card-overflow": "Writer length constraint + Renderer",
  "safety-concern": "Safety Reviewer",
  "other": "General review"
};

// ---------------------------------------------------------------------------
// FeedbackRecord
// ---------------------------------------------------------------------------

export type FeedbackScore = 1 | 2 | 3 | 4 | 5;

export type FeedbackRecord = {
  /** ISO date string: YYYY-MM-DD */
  date: string;
  /** Revision identifier, e.g. "rev-001" */
  revision: string;
  /** Human-readable format name from story.json */
  formatName: string;
  /** Fun score 1–5 */
  fun: FeedbackScore;
  /** Share score 1–5 */
  share: FeedbackScore;
  /** Accuracy score 1–5 */
  accuracy: FeedbackScore;
  /** Whether user flagged a safety concern */
  safetyConcern: boolean;
  /** Whether user would post to Instagram */
  wouldPost: boolean;
  /** Selected reasons for negative feedback */
  reasons: FeedbackReason[];
  /** Free-text note */
  note: string;
  /** ISO timestamp when feedback was created */
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Score validation
// ---------------------------------------------------------------------------

export function isValidScore(value: unknown): value is FeedbackScore {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

export function validateScore(value: unknown, fieldName: string): void {
  if (!isValidScore(value)) {
    throw new RangeError(
      `${fieldName} must be an integer between 1 and 5, got: ${String(value)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.date === "string" &&
    typeof value.revision === "string" &&
    typeof value.formatName === "string" &&
    isValidScore(value.fun) &&
    isValidScore(value.share) &&
    isValidScore(value.accuracy) &&
    typeof value.safetyConcern === "boolean" &&
    typeof value.wouldPost === "boolean" &&
    Array.isArray(value.reasons) &&
    value.reasons.every(isFeedbackReason) &&
    typeof value.note === "string" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
