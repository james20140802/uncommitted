import { describe, expect, it } from "vitest";
import { AiGenerationError, MockAiProvider } from "../src/ai-provider.js";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  deriveCaptionText,
  generateDiaryDraft
} from "../src/diary-generator.js";
import type { StoryFormatPlan } from "../src/story-format-plan.js";

describe("diary generator", () => {
  it("returns a validated story draft and derives caption text", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft({
        title: "Provider Boundary Day"
      })
    });
    const summary = createActivitySummary();
    const plan = createStoryFormatPlan({ suggestedSlideCount: 4 });

    const draft = await generateDiaryDraft({
      activitySummary: summary,
      storyFormatPlan: plan,
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft).toEqual({
      schemaVersion: 1,
      targetDate: "2026-05-12",
      title: "Provider Boundary Day",
      caption:
        "오늘은 provider boundary를 세우고 검증까지 붙였다. 내일의 버그도 이제 입장권 검사가 필요하다.",
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
          title: "Unfinished thread",
          body: "One uncommitted file is still waiting for tomorrow's tiny ceremony.",
          visualMood: "single highlighted file"
        },
        {
          index: 4,
          title: "Verdict",
          body: "The mock provider behaved, which is suspicious but welcome.",
          visualMood: "rubber stamp on terminal"
        }
      ],
      hashtags: ["#Uncommitted", "#개발일기", "#AI동료"],
      altText:
        "AI coworker diary carousel about provider validation work in Uncommitted.",
      metadata: {
        targetDate: "2026-05-12",
        generatedAt: "2026-05-12T23:30:00.000Z",
        activityLevel: "medium",
        formatName: "Bug Court Transcript",
        storyFormatVoice: "tired QA narrator",
        storyFormatTone: "deadpan, witty, affectionate",
        projectIds: ["uncommitted"],
        entryMode: "daily_global",
        slideCount: 4
      }
    });
    expect(deriveCaptionText(draft)).toBe(
      "오늘은 provider boundary를 세우고 검증까지 붙였다. 내일의 버그도 이제 입장권 검사가 필요하다.\n\n#Uncommitted #개발일기 #AI동료\n"
    );
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      schemaVersion: 1,
      task: "draft",
      input: {
        schemaVersion: 1,
        targetDate: "2026-05-12",
        quiet: false,
        overview: "medium coding day with 1 project.",
        entryMode: "daily_global",
        persona: "wry coworker",
        storyFormatPlan: {
          formatName: "Bug Court Transcript",
          suggestedSlideCount: 4
        },
        roastPolicy: {
          roastLevel: 2,
          allowDirectUserRoast: false
        }
      }
    });
    expect(provider.requests[0]?.instructions).toContain(
      "Return structured JSON for story.json"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "Caption must be copyable as an Instagram caption"
    );
    expect(provider.requests[0]?.instructions).toContain("Do not invent work");
  });

  it("generates a quiet-day request without fabricating activity", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft({
        title: "Quiet Terminal Watch",
        caption:
          "오늘은 Git이 조용했다. 나는 평화라고 믿어보기로 했지만, TODO는 커튼 뒤에서 숨을 참고 있었다.",
        slides: [
          {
            index: 1,
            title: "조용한 시작",
            body: "기록된 Git activity나 manual note가 없었다.",
            visualMood: "still terminal"
          },
          {
            index: 2,
            title: "AI의 대기",
            body: "없는 성과를 만들지 않고 조용한 하루를 그대로 적었다.",
            visualMood: "waiting cursor"
          },
          {
            index: 3,
            title: "내일의 관찰",
            body: "TODO가 자라났다고 단정하지 않고, 그냥 지켜보기로 했다.",
            visualMood: "small note on desk"
          }
        ],
        altText: "Quiet-day AI coworker diary carousel with no recorded work."
      })
    });

    const draft = await generateDiaryDraft({
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
        uncommittedChanges: {
          totalFiles: 0,
          byStatus: {
            modified: 0,
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
          noteCount: 0,
          notes: []
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
      storyFormatPlan: createStoryFormatPlan({
        formatName: "Quiet Terminal Watch",
        reason: "No recorded work was available.",
        suggestedSlideCount: 3
      }),
      provider,
      persona: "slightly tired coworker",
      roastLevel: 4
    });

    expect(draft.slides).toHaveLength(3);
    expect(draft.metadata.activityLevel).toBe("none");
    expect(provider.requests[0]?.input.quiet).toBe(true);
    expect(provider.requests[0]?.input.highlights).toContain(
      "No recorded Git activity or manual notes; keep the draft honest."
    );
    expect(provider.requests[0]?.instructions).toContain(
      "For quiet days, acknowledge no recorded work"
    );
  });

  it("accepts low-activity drafts within the MVP slide range", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft({
        slides: createSlides(6)
      })
    });

    const draft = await generateDiaryDraft({
      activitySummary: createActivitySummary({
        activityLevel: "low",
        commitSignals: {
          totalCommits: 1,
          filesChanged: 1,
          insertions: 12,
          deletions: 2,
          subjects: ["adjust caption prompt"],
          themes: ["coding"]
        }
      }),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 6 }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft.slides).toHaveLength(6);
    expect(draft.metadata.slideCount).toBe(6);
    expect(provider.requests[0]?.instructions).toContain(
      "Prefer 3-5 slides for quiet or low activity days"
    );
    expect(provider.requests[0]?.instructions).toContain(
      "guidance, not a hard validation limit"
    );
  });

  it("rejects malformed provider output", async () => {
    await expect(
      generateDiaryDraft({
        activitySummary: createActivitySummary(),
        storyFormatPlan: createStoryFormatPlan(),
        provider: new MockAiProvider({
          response: {
            title: "Missing slides"
          }
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      exitCode: 4,
      message: "AI provider returned invalid diary draft."
    });

    await expect(
      generateDiaryDraft({
        activitySummary: createActivitySummary(),
        storyFormatPlan: createStoryFormatPlan(),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: createProviderDraft().slides.slice(0, 2)
          })
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toBeInstanceOf(AiGenerationError);
  });

  it("rejects unsafe or fabricated provider output where feasible", async () => {
    await expect(
      generateDiaryDraft({
        activitySummary: createActivitySummary(),
        storyFormatPlan: createStoryFormatPlan(),
        provider: new MockAiProvider({
          response: createProviderDraft({
            caption:
              "오늘은 /Users/dev/private/.env 에서 OPENAI_API_KEY=sk-live-secret123 를 확인했다."
          })
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      message: "AI provider returned unsafe diary draft."
    });

    await expect(
      generateDiaryDraft({
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
          unfinishedThreads: []
        }),
        storyFormatPlan: createStoryFormatPlan({
          formatName: "Quiet Terminal Watch",
          suggestedSlideCount: 3
        }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            caption: "오늘은 인증 기능을 shipped 하고 버그도 fixed 했다.",
            slides: createProviderDraft().slides.slice(0, 3)
          })
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      message: "AI provider fabricated quiet-day activity."
    });
  });
});

function createProviderDraft(
  overrides: Partial<ReturnType<typeof baseProviderDraft>> = {}
): ReturnType<typeof baseProviderDraft> {
  return {
    ...baseProviderDraft(),
    ...overrides
  };
}

function baseProviderDraft() {
  return {
    title: "Bug Court Transcript",
    caption:
      "오늘은 provider boundary를 세우고 검증까지 붙였다. 내일의 버그도 이제 입장권 검사가 필요하다.",
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
        title: "Unfinished thread",
        body: "One uncommitted file is still waiting for tomorrow's tiny ceremony.",
        visualMood: "single highlighted file"
      },
      {
        index: 4,
        title: "Verdict",
        body: "The mock provider behaved, which is suspicious but welcome.",
        visualMood: "rubber stamp on terminal"
      }
    ],
    hashtags: ["#Uncommitted", "#개발일기", "#AI동료"],
    altText:
      "AI coworker diary carousel about provider validation work in Uncommitted."
  };
}

function createSlides(count: number): ReturnType<typeof baseProviderDraft>["slides"] {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    title: `Slide ${index + 1}`,
    body: `Low activity draft beat ${index + 1}.`,
    visualMood: "quiet checklist"
  }));
}

function createStoryFormatPlan(
  overrides: Partial<StoryFormatPlan> = {}
): StoryFormatPlan {
  return {
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
    suggestedSlideCount: 4,
    captionStyle: "short witty caption",
    doNotMention: ["raw diffs", "private paths"],
    ...overrides
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
