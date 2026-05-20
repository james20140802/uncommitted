import { describe, expect, it } from "vitest";
import {
  FEEDBACK_REASONS,
  REASON_PROMPT_AREA_MAP,
  isFeedbackReason,
  isFeedbackRecord,
  isValidScore,
  validateScore
} from "../src/feedback-types.js";
import type { FeedbackReason, FeedbackRecord } from "../src/feedback-types.js";

describe("FeedbackReason", () => {
  it("contains all 14 expected reason values", () => {
    const expected: FeedbackReason[] = [
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
    ];

    expect(FEEDBACK_REASONS).toHaveLength(14);
    for (const reason of expected) {
      expect(FEEDBACK_REASONS).toContain(reason);
    }
  });

  it("isFeedbackReason returns true for valid reasons", () => {
    expect(isFeedbackReason("too-boring")).toBe(true);
    expect(isFeedbackReason("too-report-like")).toBe(true);
    expect(isFeedbackReason("too-long")).toBe(true);
    expect(isFeedbackReason("too-generic")).toBe(true);
    expect(isFeedbackReason("repetitive-format")).toBe(true);
    expect(isFeedbackReason("inaccurate")).toBe(true);
    expect(isFeedbackReason("hallucinated-work")).toBe(true);
    expect(isFeedbackReason("weak-caption")).toBe(true);
    expect(isFeedbackReason("awkward-roast")).toBe(true);
    expect(isFeedbackReason("too-harsh")).toBe(true);
    expect(isFeedbackReason("not-instagram-like")).toBe(true);
    expect(isFeedbackReason("card-overflow")).toBe(true);
    expect(isFeedbackReason("safety-concern")).toBe(true);
    expect(isFeedbackReason("other")).toBe(true);
  });

  it("isFeedbackReason returns false for invalid values", () => {
    expect(isFeedbackReason("unknown")).toBe(false);
    expect(isFeedbackReason("")).toBe(false);
    expect(isFeedbackReason(null)).toBe(false);
    expect(isFeedbackReason(42)).toBe(false);
    expect(isFeedbackReason(undefined)).toBe(false);
  });
});

describe("REASON_PROMPT_AREA_MAP", () => {
  it("every FeedbackReason has a mapping entry", () => {
    for (const reason of FEEDBACK_REASONS) {
      expect(
        REASON_PROMPT_AREA_MAP[reason],
        `Missing mapping for reason: ${reason}`
      ).toBeDefined();
      expect(typeof REASON_PROMPT_AREA_MAP[reason]).toBe("string");
      expect(REASON_PROMPT_AREA_MAP[reason].length).toBeGreaterThan(0);
    }
  });

  it("maps each reason to the expected prompt area per spec", () => {
    expect(REASON_PROMPT_AREA_MAP["too-report-like"]).toContain(
      "Diary Writer"
    );
    expect(REASON_PROMPT_AREA_MAP["too-generic"]).toContain("Story Inventor");
    expect(REASON_PROMPT_AREA_MAP["repetitive-format"]).toContain(
      "Story Inventor"
    );
    expect(REASON_PROMPT_AREA_MAP["weak-caption"]).toContain("Caption");
    expect(REASON_PROMPT_AREA_MAP["inaccurate"]).toContain("Activity Summary");
    expect(REASON_PROMPT_AREA_MAP["hallucinated-work"]).toContain(
      "Activity Summary"
    );
    expect(REASON_PROMPT_AREA_MAP["too-harsh"]).toContain("Safety");
    expect(REASON_PROMPT_AREA_MAP["not-instagram-like"]).toContain("Caption");
    expect(REASON_PROMPT_AREA_MAP["card-overflow"]).toContain("Renderer");
    expect(REASON_PROMPT_AREA_MAP["safety-concern"]).toContain("Safety");
  });

  it("has no extra keys beyond FEEDBACK_REASONS", () => {
    const mappingKeys = Object.keys(REASON_PROMPT_AREA_MAP);
    expect(mappingKeys).toHaveLength(FEEDBACK_REASONS.length);
    for (const key of mappingKeys) {
      expect(FEEDBACK_REASONS).toContain(key);
    }
  });
});

describe("score validation", () => {
  it("isValidScore returns true for integers 1-5", () => {
    expect(isValidScore(1)).toBe(true);
    expect(isValidScore(2)).toBe(true);
    expect(isValidScore(3)).toBe(true);
    expect(isValidScore(4)).toBe(true);
    expect(isValidScore(5)).toBe(true);
  });

  it("isValidScore returns false for values outside 1-5", () => {
    expect(isValidScore(0)).toBe(false);
    expect(isValidScore(6)).toBe(false);
    expect(isValidScore(-1)).toBe(false);
    expect(isValidScore(100)).toBe(false);
  });

  it("isValidScore returns false for non-integers", () => {
    expect(isValidScore(1.5)).toBe(false);
    expect(isValidScore(3.9)).toBe(false);
    expect(isValidScore(NaN)).toBe(false);
  });

  it("isValidScore returns false for non-numbers", () => {
    expect(isValidScore("3")).toBe(false);
    expect(isValidScore(null)).toBe(false);
    expect(isValidScore(undefined)).toBe(false);
  });

  it("validateScore throws for invalid values", () => {
    expect(() => validateScore(0, "fun")).toThrow("fun");
    expect(() => validateScore(6, "share")).toThrow("share");
    expect(() => validateScore(1.5, "accuracy")).toThrow("accuracy");
  });

  it("validateScore does not throw for valid values", () => {
    expect(() => validateScore(1, "fun")).not.toThrow();
    expect(() => validateScore(5, "share")).not.toThrow();
    expect(() => validateScore(3, "accuracy")).not.toThrow();
  });
});

describe("isFeedbackRecord", () => {
  const validRecord: FeedbackRecord = {
    date: "2026-05-19",
    revision: "rev-001",
    formatName: "AI의 퇴근일지",
    fun: 4,
    share: 3,
    accuracy: 5,
    safetyConcern: false,
    wouldPost: false,
    reasons: ["weak-caption"],
    note: "캡션이 너무 담백함",
    createdAt: "2026-05-19T23:30:00.000Z"
  };

  it("returns true for a valid FeedbackRecord", () => {
    expect(isFeedbackRecord(validRecord)).toBe(true);
  });

  it("returns true with empty reasons and empty note", () => {
    expect(
      isFeedbackRecord({ ...validRecord, reasons: [], note: "" })
    ).toBe(true);
  });

  it("returns false when required fields are missing", () => {
    const { date: _date, ...noDate } = validRecord;
    expect(isFeedbackRecord(noDate)).toBe(false);

    const { revision: _rev, ...noRevision } = validRecord;
    expect(isFeedbackRecord(noRevision)).toBe(false);
  });

  it("returns false when scores are out of range", () => {
    expect(isFeedbackRecord({ ...validRecord, fun: 0 })).toBe(false);
    expect(isFeedbackRecord({ ...validRecord, share: 6 })).toBe(false);
    expect(isFeedbackRecord({ ...validRecord, accuracy: 1.5 })).toBe(false);
  });

  it("returns false when reasons contain invalid values", () => {
    expect(
      isFeedbackRecord({ ...validRecord, reasons: ["unknown-reason"] })
    ).toBe(false);
  });

  it("returns false for null/non-object values", () => {
    expect(isFeedbackRecord(null)).toBe(false);
    expect(isFeedbackRecord(undefined)).toBe(false);
    expect(isFeedbackRecord("string")).toBe(false);
    expect(isFeedbackRecord(42)).toBe(false);
  });
});
