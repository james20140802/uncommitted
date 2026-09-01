/**
 * UNC-236 / Task 3: 카드 요지가 캡션 입력에 실제로 배선되는지 확인하는
 * 파이프라인 통합 테스트다.
 *
 * 픽스처(프로바이더 스텁, ActivitySummary, Persona, MoodPlan)는
 * tests/diary-generator.test.ts의 기존 캡션 테스트에서 쓰는 방식을 그대로
 * 옮겨왔다 — 새로 발명하지 않는다.
 */
import { describe, expect, it } from "vitest";
import { MockAiProvider } from "../src/ai-provider.js";
import { generateCaption } from "../src/diary-generator.js";
import { PERSONA_PRESETS, type Persona } from "../src/persona.js";
import type { MoodPlan, StoryFormatPlan } from "../src/story-format-plan.js";
import type { ActivitySummary } from "../src/activity-summary.js";

const captionTestPersona: Persona = PERSONA_PRESETS["시니컬한 관찰자"].persona;
const captionTestMoodPlan: MoodPlan = createStoryFormatPlan({
  captionStyle: "짧고 위트있는 캡션",
  doNotMention: ["raw diffs", "private paths"]
});

describe("caption card gist integration (UNC-236)", () => {
  it("카드 요지가 캡션 입력에 실려 프로바이더에 전달된다 (UNC-236 AC2)", async () => {
    const provider = new MockAiProvider({
      response: {
        caption: "오늘은 조용히 지나갔다.",
        hashtags: ["#Uncommitted", "#개발일기"]
      }
    });

    await generateCaption({
      activitySummary: createActivitySummary(),
      moodPlan: captionTestMoodPlan,
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      storyCardGist: [{ cardType: "modal", lines: ["좋은 UX 팁 ①"] }]
    });

    const captured = provider.requests[0];

    expect(captured?.input.storyCardGist).toEqual([
      { cardType: "modal", lines: ["좋은 UX 팁 ①"] }
    ]);
    expect(captured?.instructions).toContain("1 to 2 short sentences");
  });

  it("카드가 없으면 캡션 입력에 필드를 아예 붙이지 않는다 (UNC-236 AC3)", async () => {
    const provider = new MockAiProvider({
      response: {
        caption: "오늘은 커밋 하나를 조용히 남겼다.",
        hashtags: ["#Uncommitted", "#개발일기"]
      }
    });

    const result = await generateCaption({
      activitySummary: createActivitySummary(),
      moodPlan: captionTestMoodPlan,
      provider,
      persona: captionTestPersona,
      roastLevel: 2
    });

    const captured = provider.requests[0];

    expect(captured).toBeDefined();
    expect(captured?.input).not.toHaveProperty("storyCardGist");
    expect(captured?.instructions).toContain("4 to 8 short lines");
    expect(result.caption.trim().length).toBeGreaterThan(0);
  });

  it("카드가 있어도 조용한 날 정직성 검사가 그대로 작동한다 (UNC-236 AC4)", async () => {
    const quietSummary = createQuietActivitySummary();

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        moodPlan: captionTestMoodPlan,
        provider: new MockAiProvider({
          response: {
            caption:
              "좋은 하루 관리 팁 ①\n\n누구나 겪는 그 오후에\n버그 하나를 조용히 fixed 해두세요.\n\n아무도 모르게요.",
            hashtags: ["#Uncommitted", "#개발일기"]
          }
        }),
        persona: captionTestPersona,
        roastLevel: 2,
        storyCardGist: [{ cardType: "modal", lines: ["좋은 UX 팁 ①"] }]
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      message: "AI provider fabricated quiet-day activity in caption."
    });
  });

  it("카드가 있어도 해시태그가 기존과 동일하게 파싱된다 (UNC-236 AC5)", async () => {
    const provider = new MockAiProvider({
      response: {
        caption: "오늘은 커밋 하나를 조용히 남겼다.",
        hashtags: ["#Uncommitted", "#개발일기"]
      }
    });

    const result = await generateCaption({
      activitySummary: createActivitySummary(),
      moodPlan: captionTestMoodPlan,
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      storyCardGist: [{ cardType: "modal", lines: ["좋은 UX 팁 ①"] }]
    });

    expect(result.hashtags).toEqual(["#Uncommitted", "#개발일기"]);
  });
});

/**
 * 아래 헬퍼들은 tests/diary-generator.test.ts의 동명 헬퍼를 그대로 옮겨온
 * 것이다 (export되어 있지 않아 재사용할 수 없으므로 복제한다). 값을
 * 새로 발명하지 않았다.
 */
function createStoryFormatPlan(
  overrides: Partial<Omit<StoryFormatPlan, "schemaVersion">> = {}
): MoodPlan {
  const plan = {
    formatName: "Bug Court Transcript",
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

  return {
    schemaVersion: 2,
    mood: "grind",
    angle: "The day circled the same flaky provider validation bug.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: plan.suggestedSlideCount
    },
    reason: plan.reason,
    structure: plan.structure,
    captionStyle: plan.captionStyle,
    doNotMention: plan.doNotMention
  };
}

/** 조용한 날 정직성 가드를 켜는 최소 요약 (UNC-251). */
function createQuietActivitySummary(): ActivitySummary {
  return createActivitySummary({
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
  });
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
          path: "src/example.ts",
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
