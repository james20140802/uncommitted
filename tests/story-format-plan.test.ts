import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiGenerationError, MockAiProvider } from "../src/ai-provider.js";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  generateStoryFormatPlan,
  loadRecentStoryFormatHistory,
  recordStoryFormatHistory,
  isMood,
  isMoodPlan,
  MOOD_VOCABULARY
} from "../src/story-format-plan.js";
import type { MoodPlan, RecentStoryFormat } from "../src/story-format-plan.js";

describe("story format plan", () => {
  it("derives a MoodPlan from activity signals instead of inventing a genre", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({
        mood: "firefight",
        pacing: {
          openWith: "scene",
          shape: "hook-turn-landing",
          suggestedSlideCount: 5
        }
      })
    });
    const summary = createActivitySummary({
      activityLevel: "medium",
      dominantTheme: "debugging",
      smallWins: ["Fixed flaky provider validation."],
      blockersOrConfusion: ["Blocked by unclear retry handling."]
    });

    const plan = await generateStoryFormatPlan({
      activitySummary: summary,
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(MOOD_VOCABULARY).toContain(plan.mood);
    expect(plan.mood).toBe("firefight");
    expect(plan.angle.length).toBeGreaterThan(0);
    expect(plan.pacing).toEqual({
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 5
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
        },
        activitySignals: {
          smallWins: ["Fixed flaky provider validation."],
          blockersOrConfusion: ["Blocked by unclear retry handling."]
        }
      }
    });
    expect(provider.requests[0]?.instructions).toContain("daily_global");
    expect(provider.requests[0]?.instructions).toContain("Roast policy");
    expect(provider.requests[0]?.instructions).toContain("Do not invent work");
    expect(provider.requests[0]?.instructions).toContain(
      "Choose a format that supports a felt diary"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "Do not make the plan a report"
    );
    expect(provider.requests[0]?.instructions).not.toContain(
      "Pick or invent a clear genre"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "Classify today into exactly ONE mood"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "Choose an angle"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "not the user's diary"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "Do not claim to know the user's private feelings"
    );
  });

  it("derives an honest low-key plan for quiet days without fabricating activity", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({
        mood: "quiet",
        angle: "Nothing much happened; the day was mostly waiting.",
        pacing: {
          openWith: "thought",
          shape: "single-beat",
          suggestedSlideCount: 3
        },
        reason: "No recorded work was available, so the plan admits a quiet day."
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
        smallWins: [],
        blockersOrConfusion: [],
        unfinishedThreads: [],
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

    expect(plan.mood).toBe("quiet");
    expect(plan.pacing.suggestedSlideCount).toBe(3);
    expect(provider.requests[0]?.input.quiet).toBe(true);
    expect(provider.requests[0]?.input.highlights).toContain(
      "No recorded Git activity or manual notes; keep the draft honest."
    );
    expect(provider.requests[0]?.instructions).toContain(
      "This is a quiet day: bias mood toward quiet"
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
      response: createMoodProviderPlan({ mood: "grind" })
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
        formatName: "TODO Night Council"
      },
      {
        date: "2026-05-10",
        formatName: "Commit Weather"
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
        mood: "firefight"
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
          response: createMoodProviderPlan({
            pacing: {
              openWith: "scene",
              shape: "hook-turn-landing",
              suggestedSlideCount: 10
            }
          })
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toBeInstanceOf(AiGenerationError);
  });

  it("rejects a mood outside the fixed vocabulary instead of accepting an invented genre", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({ mood: "thriller" })
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
  });

  it("does not write voice or tone into formats.json", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));

    await recordStoryFormatHistory({
      homeDir,
      targetDate: "2026-05-12",
      storyFormatPlan: createMoodPlan({ mood: "firefight", angle: "flaky retry handling" })
    });

    const raw = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "history", "formats.json"), "utf8")
    ) as { formats: Record<string, unknown>[] };

    expect(raw.formats).toHaveLength(1);
    expect(raw.formats[0]).toEqual({
      date: "2026-05-12",
      mood: "firefight",
      angle: "flaky retry handling"
    });
    expect(raw.formats[0]).not.toHaveProperty("voice");
    expect(raw.formats[0]).not.toHaveProperty("tone");
  });

  it("loads a legacy formats.json entry that still carries voice/tone without error", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));
    const historyDir = join(homeDir, ".uncommitted", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "formats.json"),
      JSON.stringify({
        schemaVersion: 1,
        formats: [
          {
            date: "2026-05-11",
            mood: "grind",
            angle: "slow test suite",
            voice: "night librarian",
            tone: "deadpan"
          }
        ]
      }),
      "utf8"
    );

    const recent = await loadRecentStoryFormatHistory({ homeDir });

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      date: "2026-05-11",
      mood: "grind",
      angle: "slow test suite"
    });
    expect(recent[0]).not.toHaveProperty("voice");
    expect(recent[0]).not.toHaveProperty("tone");
  });

  it("keeps a legacy entry loadable when voice/tone are its only extra fields", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));
    const historyDir = join(homeDir, ".uncommitted", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "formats.json"),
      JSON.stringify({
        schemaVersion: 1,
        formats: [
          { date: "2026-05-10", formatName: "quiet", voice: "quiet observer", tone: "calm" }
        ]
      }),
      "utf8"
    );

    const recent = await loadRecentStoryFormatHistory({ homeDir });

    expect(recent).toHaveLength(1);
    expect(recent[0].mood).toBe("quiet");
    expect(recent[0]).not.toHaveProperty("voice");
  });

  it("accepts a provider plan without voice or tone and returns a voice-neutral MoodPlan", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({ mood: "cleanup" })
    });

    const plan = await generateStoryFormatPlan({
      activitySummary: createActivitySummary({ activityLevel: "low" }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(plan.mood).toBe("cleanup");
    expect(plan).not.toHaveProperty("voice");
    expect(plan).not.toHaveProperty("tone");
  });

  it("does not ask the provider for voice, tone, or a narrative device costume", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({ mood: "grind" })
    });

    await generateStoryFormatPlan({
      activitySummary: createActivitySummary(),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const instructions = (provider.requests[0] as { instructions: string })
      .instructions;

    expect(instructions).toContain("mood, angle, pacing");
    expect(instructions).not.toMatch(/\bvoice\b/i);
    expect(instructions).not.toMatch(/\btone\b/i);
    expect(instructions).not.toMatch(/narrative device/i);
    expect(instructions).not.toMatch(
      /case file|field note|patrol log|object monologue/i
    );
  });
});

describe("format history diversity (UNC-214)", () => {
  it("round-trips mood/angle through recordStoryFormatHistory and loadRecentStoryFormatHistory", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-story-format-"));

    await recordStoryFormatHistory({
      homeDir,
      targetDate: "2026-05-12",
      storyFormatPlan: {
        schemaVersion: 2,
        mood: "grind",
        angle: "The same flaky test kept failing all afternoon.",
        pacing: {
          openWith: "scene",
          shape: "hook-turn-landing",
          suggestedSlideCount: 4
        },
        reason: "The day had enough debugging evidence for a courtroom bit.",
        structure: [
          { part: "Opening statement", purpose: "Introduce the work." }
        ],
        captionStyle: "short witty caption",
        doNotMention: []
      }
    });

    const recentFormats = await loadRecentStoryFormatHistory({ homeDir });

    expect(recentFormats).toEqual([
      {
        date: "2026-05-12",
        mood: "grind",
        angle: "The same flaky test kept failing all afternoon."
      }
    ]);

    const raw = JSON.parse(
      await readFile(
        join(homeDir, ".uncommitted", "history", "formats.json"),
        "utf8"
      )
    ) as { formats: unknown[] };
    expect(raw.formats[0]).not.toHaveProperty("formatName");
  });

  it("migrates a legacy formats.json entry with only formatName, mapping formatName to mood when valid", async () => {
    const homeDir = await createHomeWithFormatHistory({
      formats: [
        {
          date: "2026-05-11",
          formatName: "quiet",
          voice: "quiet observer",
          tone: "calm"
        },
        {
          date: "2026-05-10",
          formatName: "TODO Night Council",
          voice: "TODO list",
          tone: "deadpan"
        }
      ]
    });

    const recentFormats = await loadRecentStoryFormatHistory({ homeDir });

    expect(recentFormats).toEqual([
      {
        date: "2026-05-11",
        formatName: "quiet",
        mood: "quiet"
      },
      {
        date: "2026-05-10",
        formatName: "TODO Night Council"
      }
    ]);
  });

  it("biases story-format instructions away from recently used moods and angles", async () => {
    const recentFormats: RecentStoryFormat[] = [
      {
        date: "2026-05-11",
        mood: "firefight",
        angle: "A flaky test kept failing."
      },
      {
        date: "2026-05-10",
        mood: "grind",
        angle: "Refactor busywork all day."
      }
    ];
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({ mood: "quiet" })
    });

    await generateStoryFormatPlan({
      activitySummary: createActivitySummary(),
      provider,
      persona: "wry coworker",
      roastLevel: 1,
      recentFormats
    });

    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("firefight");
    expect(instructions).toContain("grind");
    expect(instructions).toContain("A flaky test kept failing.");
    expect(instructions).toContain("Refactor busywork all day.");
    expect(instructions).toMatch(/different mood/i);
  });

  it("limits anti-repetition guidance to moods and angles", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({ mood: "release" })
    });

    await generateStoryFormatPlan({
      activitySummary: createActivitySummary(),
      provider,
      persona: "wry coworker",
      roastLevel: 2,
      recentFormats: [
        { date: "2026-05-11", mood: "grind", angle: "slow test suite" },
        { date: "2026-05-10", mood: "quiet", angle: "waiting on review" }
      ]
    });

    const instructions = (provider.requests[0] as { instructions: string })
      .instructions;

    expect(instructions).toContain("Recently used moods");
    expect(instructions).toContain("Recently used angles");
    expect(instructions).not.toMatch(/narrator device/i);
    expect(instructions).not.toMatch(/Recently used voices/i);
  });
});

describe("mood vocabulary and MoodPlan contract", () => {
  it("defines exactly the 6 fixed moods", () => {
    expect(MOOD_VOCABULARY).toEqual([
      "release",
      "firefight",
      "quiet",
      "grind",
      "breakthrough",
      "cleanup"
    ]);
  });

  it("isMood guards known moods and rejects invented genres", () => {
    expect(isMood("firefight")).toBe(true);
    expect(isMood("thriller")).toBe(false);
  });

  it("isMoodPlan accepts a well-formed MoodPlan", () => {
    const plan: MoodPlan = {
      schemaVersion: 2,
      mood: "firefight",
      angle: "The build kept breaking on the same flaky test.",
      pacing: {
        openWith: "scene",
        shape: "hook-turn-landing",
        suggestedSlideCount: 5
      },
      reason: "The day had enough debugging evidence for a courtroom bit.",
      structure: [
        {
          part: "Opening statement",
          purpose: "Introduce the actual debugging work."
        }
      ],
      captionStyle: "short witty caption",
      doNotMention: ["raw diffs", "private paths"]
    };

    expect(isMoodPlan(plan)).toBe(true);
  });

  it("isMoodPlan rejects an invalid mood or out-of-range slide count", () => {
    const basePlan: MoodPlan = {
      schemaVersion: 2,
      mood: "quiet",
      angle: "Nothing much happened today.",
      pacing: {
        openWith: "thought",
        shape: "single-beat",
        suggestedSlideCount: 3
      },
      reason: "Low activity day.",
      structure: [{ part: "Beat", purpose: "Sit with the quiet." }],
      captionStyle: "short",
      doNotMention: []
    };

    expect(
      isMoodPlan({ ...basePlan, mood: "thriller" })
    ).toBe(false);
    expect(
      isMoodPlan({
        ...basePlan,
        pacing: { ...basePlan.pacing, suggestedSlideCount: 10 }
      })
    ).toBe(false);
  });

  it("isMoodPlan accepts a plan without voice or tone", () => {
    expect(
      isMoodPlan({
        schemaVersion: 2,
        mood: "quiet",
        angle: "waiting on review",
        pacing: { openWith: "thought", shape: "single-beat", suggestedSlideCount: 3 },
        reason: "Nothing landed today.",
        structure: [{ part: "open", purpose: "set the scene" }],
        captionStyle: "short and dry",
        doNotMention: []
      })
    ).toBe(true);
  });
});

function createMoodPlan(overrides: Partial<MoodPlan> = {}): MoodPlan {
  return {
    schemaVersion: 2,
    mood: "grind",
    angle: "the test suite that keeps getting slower",
    pacing: { openWith: "scene", shape: "hook-turn-landing", suggestedSlideCount: 4 },
    reason: "The day was mostly maintenance.",
    structure: [{ part: "open", purpose: "set the scene" }],
    captionStyle: "short and dry",
    doNotMention: [],
    ...overrides
  };
}

function createMoodProviderPlan(
  overrides: Partial<ReturnType<typeof baseMoodProviderPlan>> = {}
): ReturnType<typeof baseMoodProviderPlan> {
  return {
    ...baseMoodProviderPlan(),
    ...overrides
  };
}

function baseMoodProviderPlan() {
  return {
    mood: "firefight",
    angle: "The build kept breaking on the same flaky test.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 4
    },
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
