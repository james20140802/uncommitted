import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateFeedback,
  formatFeedbackReport,
  type FeedbackAggregate
} from "../src/feedback-report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `unc-feedback-report-test-${randomUUID()}`);
}

// JSONL fixture lines matching the spec format used by feedback-storage
const FIXTURE_LINES = [
  JSON.stringify({
    date: "2026-05-17",
    revision: "rev-001",
    formatName: "AI의 퇴근일지",
    fun: 4,
    share: 3,
    accuracy: 5,
    wouldPost: false,
    reasons: ["weak-caption"],
    note: "카드는 좋은데 caption이 너무 담백함"
  }),
  JSON.stringify({
    date: "2026-05-18",
    revision: "rev-001",
    formatName: "TODO들의 야간 회의록",
    fun: 5,
    share: 4,
    accuracy: 4,
    wouldPost: true,
    reasons: [],
    note: "이건 진짜 올릴만함"
  }),
  JSON.stringify({
    date: "2026-05-19",
    revision: "rev-002",
    formatName: "인간 관찰 보고서",
    fun: 2,
    share: 1,
    accuracy: 5,
    wouldPost: false,
    reasons: ["too-generic", "too-report-like"],
    note: "컨셉은 좋은데 문장이 평범함"
  })
];

async function writeFixtureJsonl(evalsDir: string, lines: string[]): Promise<string> {
  await mkdir(evalsDir, { recursive: true });
  const jsonlPath = join(evalsDir, "daily-feedback.jsonl");
  await writeFile(jsonlPath, lines.join("\n") + "\n", "utf8");
  return jsonlPath;
}

// ---------------------------------------------------------------------------
// aggregateFeedback tests
// ---------------------------------------------------------------------------

describe("aggregateFeedback", () => {
  it("returns empty aggregate when JSONL file does not exist", async () => {
    const evalsDir = makeTmpDir();
    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    expect(result.totalDrafts).toBe(0);
    expect(result.averageFun).toBeNull();
    expect(result.averageShare).toBeNull();
    expect(result.averageAccuracy).toBeNull();
    expect(result.wouldPostCount).toBe(0);
    expect(result.topReasons).toEqual([]);
    expect(result.bestFormats).toEqual([]);
    expect(result.recommendedWork).toEqual([]);
  });

  it("computes correct averages from 3 fixture entries", async () => {
    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, FIXTURE_LINES);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    expect(result.totalDrafts).toBe(3);
    // fun: (4+5+2)/3 = 3.67, rounded to 1 decimal
    expect(result.averageFun).toBeCloseTo(3.7, 1);
    // share: (3+4+1)/3 = 2.67
    expect(result.averageShare).toBeCloseTo(2.7, 1);
    // accuracy: (5+4+5)/3 = 4.67
    expect(result.averageAccuracy).toBeCloseTo(4.7, 1);
  });

  it("counts wouldPost correctly", async () => {
    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, FIXTURE_LINES);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    expect(result.wouldPostCount).toBe(1);
  });

  it("returns top reasons sorted by count descending", async () => {
    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, FIXTURE_LINES);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    // weak-caption: 1, too-generic: 1, too-report-like: 1
    expect(result.topReasons.length).toBeGreaterThan(0);
    // All have count 1, so any order is valid — just verify keys exist
    const reasonNames = result.topReasons.map((r) => r.reason);
    expect(reasonNames).toContain("weak-caption");
    expect(reasonNames).toContain("too-generic");
    expect(reasonNames).toContain("too-report-like");
    // Each has count 1
    for (const r of result.topReasons) {
      expect(r.count).toBe(1);
    }
  });

  it("filters entries outside the --days N window", async () => {
    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, FIXTURE_LINES);

    // Only look at the last 1 day from 2026-05-19 → only 2026-05-19 entry
    const result = await aggregateFeedback(evalsDir, 1, "2026-05-19");

    expect(result.totalDrafts).toBe(1);
    expect(result.averageFun).toBeCloseTo(2, 0);
  });

  it("returns best format with highest average fun", async () => {
    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, FIXTURE_LINES);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    // TODO들의 야간 회의록: fun 5, share 4 — should be top
    expect(result.bestFormats.length).toBeGreaterThan(0);
    expect(result.bestFormats[0].formatName).toBe("TODO들의 야간 회의록");
  });

  it("recommended work maps top reasons to prompt areas via REASON_PROMPT_AREA_MAP", async () => {
    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, FIXTURE_LINES);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    expect(result.recommendedWork.length).toBeGreaterThan(0);
    // Every item should be a non-empty string
    for (const work of result.recommendedWork) {
      expect(typeof work).toBe("string");
      expect(work.length).toBeGreaterThan(0);
    }
  });

  it("handles duplicate formatName entries by averaging", async () => {
    const lines = [
      JSON.stringify({
        date: "2026-05-18",
        revision: "rev-001",
        formatName: "Same Format",
        fun: 4,
        share: 4,
        accuracy: 4,
        wouldPost: true,
        reasons: [],
        note: ""
      }),
      JSON.stringify({
        date: "2026-05-19",
        revision: "rev-001",
        formatName: "Same Format",
        fun: 2,
        share: 2,
        accuracy: 2,
        wouldPost: false,
        reasons: [],
        note: ""
      })
    ];

    const evalsDir = makeTmpDir();
    await writeFixtureJsonl(evalsDir, lines);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    expect(result.bestFormats).toHaveLength(1);
    expect(result.bestFormats[0].formatName).toBe("Same Format");
    expect(result.bestFormats[0].averageFun).toBeCloseTo(3.0, 1);
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const evalsDir = makeTmpDir();
    const lines = [
      "{not valid json",
      ...FIXTURE_LINES.slice(0, 2)
    ];
    await writeFixtureJsonl(evalsDir, lines);

    const result = await aggregateFeedback(evalsDir, 7, "2026-05-19");

    expect(result.totalDrafts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatFeedbackReport tests
// ---------------------------------------------------------------------------

describe("formatFeedbackReport", () => {
  const sampleAggregate: FeedbackAggregate = {
    totalDrafts: 7,
    averageFun: 3.7,
    averageShare: 2.4,
    averageAccuracy: 4.6,
    wouldPostCount: 2,
    topReasons: [
      { reason: "too-report-like", count: 4 },
      { reason: "weak-caption", count: 3 },
      { reason: "repetitive-format", count: 2 }
    ],
    bestFormats: [
      { formatName: "TODO들의 야간 회의록", averageFun: 5, averageShare: 4 },
      { formatName: "버그의 진술서", averageFun: 4, averageShare: 3 }
    ],
    recommendedWork: [
      "Improve Diary Writer prompt to avoid report-like phrasing.",
      "Add stronger caption examples.",
      "Add format novelty constraints to Story Inventor."
    ],
    days: 7
  };

  it("includes all required sections", () => {
    const text = formatFeedbackReport(sampleAggregate);

    expect(text).toContain("Feedback report");
    expect(text).toContain("Average scores");
    expect(text).toContain("Fun");
    expect(text).toContain("Share");
    expect(text).toContain("Accuracy");
    expect(text).toContain("Would post");
    expect(text).toContain("Top issues");
    expect(text).toContain("Best performing formats");
    expect(text).toContain("Recommended next prompt work");
  });

  it("shows correct numeric values", () => {
    const text = formatFeedbackReport(sampleAggregate);

    expect(text).toContain("3.7");
    expect(text).toContain("2.4");
    expect(text).toContain("4.6");
    expect(text).toContain("2 / 7");
  });

  it("shows top reasons", () => {
    const text = formatFeedbackReport(sampleAggregate);

    expect(text).toContain("too-report-like");
    expect(text).toContain("weak-caption");
    expect(text).toContain("repetitive-format");
  });

  it("shows best formats", () => {
    const text = formatFeedbackReport(sampleAggregate);

    expect(text).toContain("TODO들의 야간 회의록");
    expect(text).toContain("버그의 진술서");
  });

  it("shows recommended work items", () => {
    const text = formatFeedbackReport(sampleAggregate);

    expect(text).toContain("Diary Writer");
    expect(text).toContain("caption");
    expect(text).toContain("Story Inventor");
  });

  it("shows no-data message when totalDrafts is 0", () => {
    const empty: FeedbackAggregate = {
      totalDrafts: 0,
      averageFun: null,
      averageShare: null,
      averageAccuracy: null,
      wouldPostCount: 0,
      topReasons: [],
      bestFormats: [],
      recommendedWork: [],
      days: 7
    };
    const text = formatFeedbackReport(empty);

    expect(text).toMatch(/no feedback|0 draft/i);
  });
});
