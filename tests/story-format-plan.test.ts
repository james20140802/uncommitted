import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiGenerationError, MockAiProvider } from "../src/ai-provider.js";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  generateStoryFormatPlan,
  loadRecentStoryFormatHistory
} from "../src/story-format-plan.js";

describe("story format plan", () => {
  it("returns a validated format plan for a normal activity summary", async () => {
    const provider = new MockAiProvider({
      response: createProviderPlan({
        formatName: "Bug Court Transcript",
        suggestedSlideCount: 5
      })
    });
    const summary = createActivitySummary({
      activityLevel: "medium",
      dominantTheme: "debugging",
      smallWins: ["Fixed flaky provider validation."],
      blockersOrConfusion: ["Blocked by unclear retry handling."]
    });

    await expect(
      generateStoryFormatPlan({
        activitySummary: summary,
        provider,
        persona: "wry coworker",
        roastLevel: 2
      })
    ).resolves.toEqual({
      schemaVersion: 1,
      formatName: "Bug Court Transcript",
      voice: "tired QA narrator",
      tone: "deadpan, witty, affectionate",
      reason: "The day had enough debugging evidence for a courtroom bit.",
      structure: [
        {
          part: "Opening statement",
          purpose: "Introduce the actual debugging work."
        },
        {
          part: "Evidence",
          purpose: "Mention real commits and blockers only."
        },
        {
          part: "Verdict",
          purpose: "Close with a light situation joke."
        }
      ],
      suggestedSlideCount: 5,
      captionStyle: "short witty caption",
      doNotMention: ["raw diffs", "private paths"]
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      schemaVersion: 1,
      task: "story-plan",
      input: {
        schemaVersion: 1,
        targetDate: "2026-05-12",
        quiet: false,
        overview: "medium debugging day with 1 project.",
        highlights: expect.arrayContaining([
          "Fixed flaky provider validation.",
          "Blocked by unclear retry handling."
        ]),
        entryMode: "daily_global",
        persona: "wry coworker",
        roastPolicy: {
          roastLevel: 2,
          allowDirectUserRoast: false
        }
      }
    });
    expect(provider.requests[0]?.instructions).toContain("daily_global");
    expect(provider.requests[0]?.instructions).toContain("Roast policy");
    expect(provider.requests[0]?.instructions).toContain("Do not invent work");
  });

  it("builds a quiet-day request without fabricating activity", async () => {
    const provider = new MockAiProvider({
      response: createProviderPlan({
        formatName: "Quiet Terminal Watch",
        reason: "No recorded work was available, so the plan admits a quiet day.",
        suggestedSlideCount: 3
      })
    });

    const plan = await generateStoryFormatPlan({
      activitySummary: createActivitySummary({
        activityLevel: "none",
        dominantTheme: "quiet",
        projects: [],
        commitSignals: {
          totalCommits: 0,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          subjects: [],
          themes: []
        },
        possibleJokes: [
          "Quiet day, but the draft still has to admit nothing exploded."
        ],
        uncertaintyNotes: [
          "No Git activity or manual notes were found for 2026-05-12."
        ]
      }),
      provider,
      persona: "slightly tired coworker",
      roastLevel: 4
    });

    expect(plan.formatName).toBe("Quiet Terminal Watch");
    expect(plan.suggestedSlideCount).toBe(3);
    expect(provider.requests[0]?.input.quiet).toBe(true);
    expect(provider.requests[0]?.input.highlights).toContain(
      "No recorded Git activity or manual notes; keep the draft honest."
    );
    expect(provider.requests[0]?.instructions).toContain(
      "For quiet days, acknowledge low or no recorded work"
    );
  });

  it("includes recent format history for repeated-format avoidance", async () => {
    const homeDir = await createHomeWithFormatHistory({
      formats: [
        {
          date: "2026-05-11",
          formatName: "TODO Night Council",
          voice: "TODO list",
          tone: "deadpan"
        },
        {
          date: "2026-05-10",
          formatName: "Commit Weather",
          voice: "weather report",
          tone: "witty"
        }
      ]
    });
    const recentFormats = await loadRecentStoryFormatHistory({ homeDir });
    const provider = new MockAiProvider({
      response: createProviderPlan({
        formatName: "Refactor Field Notes"
      })
    });

    await generateStoryFormatPlan({
      activitySummary: createActivitySummary(),
      provider,
      persona: "wry coworker",
      roastLevel: 1,
      recentFormats
    });

    expect(recentFormats).toEqual([
      {
        date: "2026-05-11",
        formatName: "TODO Night Council",
        voice: "TODO list",
        tone: "deadpan"
      },
      {
        date: "2026-05-10",
        formatName: "Commit Weather",
        voice: "weather report",
        tone: "witty"
      }
    ]);
    expect(provider.requests[0]?.input.recentFormats).toEqual(recentFormats);
    expect(provider.requests[0]?.instructions).toContain(
      "Avoid near-duplicates of recentFormats"
    );
  });

  it("fails with a short actionable generation error for malformed provider output", async () => {
    const provider = new MockAiProvider({
      response: {
        formatName: "Missing required plan fields"
      }
    });

    await expect(
      generateStoryFormatPlan({
        activitySummary: createActivitySummary(),
        provider,
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      exitCode: 4,
      message: "AI provider returned invalid story format plan."
    });

    await expect(
      generateStoryFormatPlan({
        activitySummary: createActivitySummary(),
        provider: new MockAiProvider({
          response: createProviderPlan({ suggestedSlideCount: 10 })
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toBeInstanceOf(AiGenerationError);
  });
});

function createProviderPlan(
  overrides: Partial<ReturnType<typeof baseProviderPlan>> = {}
): ReturnType<typeof baseProviderPlan> {
  return {
    ...baseProviderPlan(),
    ...overrides
  };
}

function baseProviderPlan() {
  return {
    formatName: "Bug Court Transcript",
    voice: "tired QA narrator",
    tone: "deadpan, witty, affectionate",
    reason: "The day had enough debugging evidence for a courtroom bit.",
    structure: [
      {
        part: "Opening statement",
        purpose: "Introduce the actual debugging work."
      },
      {
        part: "Evidence",
        purpose: "Mention real commits and blockers only."
      },
      {
        part: "Verdict",
        purpose: "Close with a light situation joke."
      }
    ],
    suggestedSlideCount: 4,
    captionStyle: "short witty caption",
    doNotMention: ["raw diffs", "private paths"]
  };
}

function createActivitySummary(
  overrides: Partial<ActivitySummary> = {}
): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-12",
    generatedAt: "2026-05-12T23:30:00.000Z",
    activityLevel: "medium",
    dominantTheme: "coding",
    projects: [
      {
        projectId: "uncommitted",
        projectName: "uncommitted",
        repositoryName: "uncommitted",
        commitCount: 2,
        filesChanged: 4,
        insertions: 120,
        deletions: 18,
        uncommittedChangeCount: 1,
        manualNoteCount: 1,
        themes: ["coding"],
        summary: "2 commits, 1 manual note, 1 uncommitted file"
      }
    ],
    commitSignals: {
      totalCommits: 2,
      filesChanged: 4,
      insertions: 120,
      deletions: 18,
      subjects: ["implement provider validation"],
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
      files: [
        {
          projectId: "uncommitted",
          projectName: "uncommitted",
          path: "src/ai-provider.ts",
          status: "modified"
        }
      ]
    },
    manualContext: {
      noteCount: 1,
      notes: [
        {
          projectId: "uncommitted",
          timestamp: "2026-05-12T15:00:00.000Z",
          text: "Need to keep story plans structured."
        }
      ]
    },
    smallWins: ["Implemented provider validation."],
    blockersOrConfusion: [],
    unfinishedThreads: ["1 uncommitted file remains in uncommitted."],
    possibleJokes: ["The working tree kept a few tabs open for tomorrow."],
    publicSafetyNotes: ["Summary excludes raw diffs and raw code."],
    privateItemsToAvoid: ["raw code snippets"],
    uncertaintyNotes: [],
    ...overrides
  };
}

async function createHomeWithFormatHistory(content: unknown): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-story-format-"));
  const historyDir = join(homeDir, ".uncommitted", "history");

  await mkdir(historyDir, { recursive: true });
  await writeFile(
    join(historyDir, "formats.json"),
    `${JSON.stringify(content)}\n`,
    "utf8"
  );

  return homeDir;
}
