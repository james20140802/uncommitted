import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockAiProvider } from "../src/ai-provider.js";
import type { ActivitySummary } from "../src/activity-summary.js";
import { generateDiaryDraft } from "../src/diary-generator.js";
import type { MoodPlan } from "../src/story-format-plan.js";
import {
  DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET,
  assembleRawNarrativeProjection,
  defaultTokenCounter,
  emptyRawNarrativeProjection,
  readCaptionProjectionTokenBudget
} from "../src/raw-narrative-projection.js";
import type {
  NarrativeTurn,
  RawNarrativeProjection
} from "../src/raw-narrative-projection.js";

describe("defaultTokenCounter", () => {
  it("returns 0 for empty string", () => {
    expect(defaultTokenCounter.estimate("")).toBe(0);
  });

  it("uses ceil(length / 4)", () => {
    expect(defaultTokenCounter.estimate("abcd")).toBe(1);
    expect(defaultTokenCounter.estimate("abcde")).toBe(2);
  });
});

describe("emptyRawNarrativeProjection", () => {
  it("returns a zeroed projection echoing the budget", () => {
    expect(emptyRawNarrativeProjection(123)).toEqual({
      turns: [],
      totalTokens: 0,
      droppedTurns: 0,
      droppedTokens: 0,
      budget: 123
    });
  });
});

describe("assembleRawNarrativeProjection", () => {
  const turn = (source: NarrativeTurn["source"], text: string): NarrativeTurn => ({
    source,
    text,
    timestamp: "",
    sessionId: "s",
    hasCodeOrToolMarker: false
  });

  it("keeps all turns when they fit and computes totals", () => {
    const turns = [turn("claude", "abcd"), turn("codex", "abcdefgh")];
    const result = assembleRawNarrativeProjection(turns, { budget: 100 });

    expect(result.turns).toEqual([
      { source: "claude", text: "abcd", tokenEstimate: 1 },
      { source: "codex", text: "abcdefgh", tokenEstimate: 2 }
    ]);
    expect(result.totalTokens).toBe(3);
    expect(result.droppedTurns).toBe(0);
    expect(result.droppedTokens).toBe(0);
    expect(result.budget).toBe(100);
  });

  it("drops trailing turns once the budget is exceeded", () => {
    // estimates: 1, 1, 1 (each 4 chars). budget 2 keeps first two, drops third.
    const turns = [
      turn("claude", "aaaa"),
      turn("claude", "bbbb"),
      turn("codex", "cccc")
    ];
    const result = assembleRawNarrativeProjection(turns, { budget: 2 });

    expect(result.turns).toEqual([
      { source: "claude", text: "aaaa", tokenEstimate: 1 },
      { source: "claude", text: "bbbb", tokenEstimate: 1 }
    ]);
    expect(result.totalTokens).toBe(2);
    expect(result.droppedTurns).toBe(1);
    expect(result.droppedTokens).toBe(1);
    expect(result.budget).toBe(2);
  });

  it("drops an oversized single turn", () => {
    const turns = [turn("github", "a".repeat(20))]; // estimate 5
    const result = assembleRawNarrativeProjection(turns, { budget: 3 });

    expect(result.turns).toEqual([]);
    expect(result.totalTokens).toBe(0);
    expect(result.droppedTurns).toBe(1);
    expect(result.droppedTokens).toBe(5);
    expect(result.budget).toBe(3);
  });

  it("returns a zeroed projection for empty input", () => {
    const result = assembleRawNarrativeProjection([], { budget: 50 });
    expect(result).toEqual({
      turns: [],
      totalTokens: 0,
      droppedTurns: 0,
      droppedTokens: 0,
      budget: 50
    });
  });

  it("returns a zeroed projection when budget <= 0", () => {
    const turns = [turn("claude", "aaaa")];
    const result = assembleRawNarrativeProjection(turns, { budget: 0 });
    expect(result).toEqual({
      turns: [],
      totalTokens: 0,
      droppedTurns: 0,
      droppedTokens: 0,
      budget: 0
    });
  });
});

describe("readCaptionProjectionTokenBudget", () => {
  async function writeConfig(value: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "unc-cap-budget-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify(value), "utf8");
    return file;
  }

  it("uses a present positive value (floored)", async () => {
    const file = await writeConfig({ captionProjectionTokenBudget: 1500.9 });
    expect(await readCaptionProjectionTokenBudget(file)).toBe(1500);
  });

  it("falls back to the default when the key is missing", async () => {
    const file = await writeConfig({ somethingElse: 7 });
    expect(await readCaptionProjectionTokenBudget(file)).toBe(
      DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET
    );
    expect(DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET).toBe(4000);
  });

  it("falls back to the default for an invalid type", async () => {
    const file = await writeConfig({ captionProjectionTokenBudget: "lots" });
    expect(await readCaptionProjectionTokenBudget(file)).toBe(4000);
  });

  it("falls back to the default for a non-positive value", async () => {
    const file = await writeConfig({ captionProjectionTokenBudget: 0 });
    expect(await readCaptionProjectionTokenBudget(file)).toBe(4000);
  });

  it("falls back to the default for a fractional value below 1", async () => {
    // 0.5 is positive but floors to 0, which would silently empty projections.
    const file = await writeConfig({ captionProjectionTokenBudget: 0.5 });
    expect(await readCaptionProjectionTokenBudget(file)).toBe(4000);
  });

  it("falls back to the default for a nonexistent file", async () => {
    expect(
      await readCaptionProjectionTokenBudget(
        join(tmpdir(), "unc-cap-budget-does-not-exist", "config.json")
      )
    ).toBe(4000);
  });
});

describe("generateDiaryDraft rawNarrativeProjection integration", () => {
  it("includes rawNarrativeProjection in the provider input when provided", async () => {
    const provider = new MockAiProvider({ response: createProviderDraft() });
    const projection: RawNarrativeProjection = {
      turns: [{ source: "claude", text: "renamed a test for clarity", tokenEstimate: 7 }],
      totalTokens: 7,
      droppedTurns: 0,
      droppedTokens: 0,
      budget: 4000
    };

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan(),
      provider,
      persona: "wry coworker",
      roastLevel: 2,
      rawNarrativeProjection: projection
    });

    const input = provider.requests[0]?.input as Record<string, unknown>;
    expect(input.rawNarrativeProjection).toEqual(projection);
    expect(input.activitySignals).toBeDefined();
  });

  it("omits the rawNarrativeProjection key when not provided", async () => {
    const provider = new MockAiProvider({ response: createProviderDraft() });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan(),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const input = provider.requests[0]?.input as Record<string, unknown>;
    expect("rawNarrativeProjection" in input).toBe(false);
    expect(input.activitySignals).toBeDefined();
  });
});

function createProviderDraft() {
  return {
    title: "Provider Boundary Day",
    slides: [
      {
        index: 1,
        title: "Opening statement",
        body: "Provider validation work moved from vibes to typed boundaries.",
        visualMood: "quiet terminal with warm contrast"
      },
      {
        index: 2,
        title: "Evidence",
        body: "Two commits and one note kept the AI request shape honest.",
        visualMood: "annotated checklist"
      },
      {
        index: 3,
        title: "Verdict",
        body: "The mock provider behaved, which is suspicious but welcome.",
        visualMood: "rubber stamp on terminal"
      }
    ],
    altText:
      "AI coworker diary carousel about provider validation work in Uncommitted."
  };
}

function createStoryFormatPlan(): MoodPlan {
  return {
    schemaVersion: 2,
    mood: "grind",
    angle: "The day circled the same flaky provider validation bug.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 3
    },
    voice: "tired QA narrator",
    tone: "deadpan, witty, affectionate",
    reason: "Medium coding day with clear evidence suits a wry recap.",
    structure: [
      { part: "Opening", purpose: "Set the scene" },
      { part: "Evidence", purpose: "Show the work" },
      { part: "Verdict", purpose: "Land the joke" }
    ],
    captionStyle: "wry",
    doNotMention: [],
    formatName: "grind"
  };
}

function createActivitySummary(): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-12",
    generatedAt: "2026-05-12T23:30:00.000Z",
    activityLevel: "medium",
    dominantTheme: "coding",
    projects: [
      {
        projectId: "uncommitted",
        projectName: "Uncommitted",
        summary: "Worked on provider boundary validation.",
        commitCount: 2,
        filesChanged: 3,
        insertions: 40,
        deletions: 5,
        uncommittedChangeCount: 1,
        manualNoteCount: 1,
        themes: ["coding"]
      }
    ],
    commitSignals: {
      totalCommits: 2,
      filesChanged: 3,
      insertions: 40,
      deletions: 5,
      subjects: ["add provider boundary", "validate request shape"],
      themes: ["coding"]
    },
    uncommittedChanges: {
      totalFiles: 1,
      byStatus: {
        modified: 1,
        added: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        untracked: 0,
        other: 0
      },
      files: []
    },
    manualContext: {
      noteCount: 1,
      notes: [
        {
          projectId: "uncommitted",
          timestamp: "2026-05-12T10:00:00.000Z",
          text: "Kept the request shape honest."
        }
      ]
    },
    smallWins: ["Provider boundary now typed."],
    blockersOrConfusion: [],
    unfinishedThreads: ["One uncommitted file waiting."],
    possibleJokes: ["The mock provider behaved."],
    publicSafetyNotes: [],
    privateItemsToAvoid: [],
    uncertaintyNotes: []
  } as ActivitySummary;
}
