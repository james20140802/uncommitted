import { describe, expect, it } from "vitest";
import { AiGenerationError, MockAiProvider } from "../src/ai-provider.js";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  buildCaptionInstructions,
  deriveCaptionText,
  generateCaption,
  generateDiaryDraft,
  redactArchitectureDisclosureFromCaption,
  redactArchitectureDisclosureFromDraft,
  type DiaryDraft
} from "../src/diary-generator.js";
import { PERSONA_PRESETS, type Persona } from "../src/persona.js";
import type { MoodPlan, StoryFormatPlan } from "../src/story-format-plan.js";

const captionTestPersona: Persona = PERSONA_PRESETS["시니컬한 관찰자"].persona;
const captionTestMoodPlan: MoodPlan = createStoryFormatPlan({
  captionStyle: "짧고 위트있는 캡션",
  doNotMention: ["raw diffs", "private paths"]
});

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
      altText:
        "AI coworker diary carousel about provider validation work in Uncommitted.",
      metadata: {
        targetDate: "2026-05-12",
        generatedAt: "2026-05-12T23:30:00.000Z",
        activityLevel: "medium",
        mood: "grind",
        angle: "The day circled the same flaky provider validation bug.",
        projectIds: ["uncommitted"],
        entryMode: "daily_global",
        slideCount: 4
      }
    });
    expect(deriveCaptionText({
      caption: "오늘은 provider boundary를 세우고 검증까지 붙였다. 내일의 버그도 이제 입장권 검사가 필요하다.",
      hashtags: ["#Uncommitted", "#개발일기", "#AI동료"]
    })).toBe(
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
          mood: "grind",
          suggestedSlideCount: 4
        },
        roastPolicy: {
          roastLevel: 2,
          allowDirectUserRoast: false
        }
      }
    });
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Return structured JSON for story.json");
    expect(instructions).toContain("Do not invent work");
    expect(instructions).toContain(
      "Do not explain the persona to the reader"
    );
    expect(instructions).toContain(
      "Use the Story Format Plan for slide structure and story flow"
    );
    expect(instructions).not.toContain("Bug Court Transcript");
    expect(instructions).not.toContain("tired QA narrator");
    expect(instructions).not.toContain("deadpan, witty, affectionate");
    // Caption instructions moved to generateCaption — must NOT appear in diary draft instructions
    expect(instructions).not.toContain(
      "Caption must be copyable as an Instagram caption"
    );
    expect(instructions).not.toContain(
      "Write like a real Instagram caption"
    );
    expect(instructions).not.toContain(
      "Do not use the Story Format Plan, formatName, voice, tone, or captionStyle to create a concept for the caption"
    );
  });

  it("omits storyFormatVoice and storyFormatTone from draft metadata", async () => {
    const plan = createStoryFormatPlan({ suggestedSlideCount: 4 });
    const provider = new MockAiProvider({
      response: createProviderDraft()
    });

    const draft = await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: plan,
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft.metadata).not.toHaveProperty("storyFormatVoice");
    expect(draft.metadata).not.toHaveProperty("storyFormatTone");
    expect(draft.metadata.mood).toBe(plan.mood);
    expect(draft.metadata.angle).toBe(plan.angle);
  });

  it("does not pass voice or tone into the story instruction payload", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft()
    });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const input = provider.requests[0]?.input as Record<string, unknown>;
    const storyFormatPlan = input.storyFormatPlan as Record<string, unknown>;

    expect(storyFormatPlan).not.toHaveProperty("voice");
    expect(storyFormatPlan).not.toHaveProperty("tone");
    expect(storyFormatPlan.mood).toBeDefined();
  });

  it("does not instruct the provider to use the Story Format Plan's voice or tone", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft()
    });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const instructions = provider.requests[0]?.instructions ?? "";

    // The plan no longer carries voice/tone; asking the provider to "use" them
    // would invite it to invent a rotating narrator costume from nothing.
    expect(instructions).not.toMatch(
      /Story Format Plan[^\n]*\b(voice|tone)\b/i
    );
    expect(instructions).toContain(
      "Use the Story Format Plan for slide structure and story flow"
    );
  });

  it("generates a quiet-day request without fabricating activity", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft({
        title: "Quiet Terminal Watch",
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

  it("forwards pacing openWith/shape into the safe diary input and instructions", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft({ title: "Pacing Variation Day" })
    });
    const basePlan = createStoryFormatPlan({ suggestedSlideCount: 5 });
    const plan: MoodPlan = {
      ...basePlan,
      pacing: {
        openWith: "thought",
        shape: "spiral",
        suggestedSlideCount: 5
      }
    };

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: plan,
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const input = provider.requests[0]?.input.storyFormatPlan as Record<
      string,
      unknown
    >;
    expect(input.openWith).toBe("thought");
    expect(input.shape).toBe("spiral");
    expect(input.suggestedSlideCount).toBe(5);

    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("spiral");
    expect(instructions).toContain("thought");
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
            altText:
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
          suggestedSlideCount: 3
        }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "조용한 시작",
                body: "오늘은 인증 기능을 shipped 하고 버그도 fixed 했다.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "대기",
                body: "없는 작업을 invent하지 않고 조용한 하루를 적었다.",
                visualMood: "waiting cursor"
              },
              {
                index: 3,
                title: "마무리",
                body: "내일의 기록을 기다리는 쪽으로 닫았다.",
                visualMood: "small note"
              }
            ]
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

  it("writes mood (not formatName) into story.json metadata (UNC-215)", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft({ title: "Mood Output Day" })
    });
    const plan = createStoryFormatPlan({ suggestedSlideCount: 4 });

    const draft = await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: plan,
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft.metadata.mood).toBe(plan.mood);
    expect(draft.metadata.angle).toBe(plan.angle);
    expect(JSON.stringify(draft)).not.toContain("formatName");
  });
});

describe("architecture disclosure redaction (UNC-206)", () => {
  it("redacts admin/route-guard/auth-checkpoint/authorization detail from the draft title and every slide field", () => {
    const draft: DiaryDraft = {
      schemaVersion: 1,
      targetDate: "2026-05-12",
      title: "the admin allowlist finally behaved",
      slides: [
        {
          index: 1,
          title: "route guard drama",
          body: "Fixed the auth checkpoint so the server-side authorization check stopped flaking.",
          visualMood: "route guard glowing on a terminal"
        },
        {
          index: 2,
          title: "quiet slide",
          body: "Nothing sensitive here, just a normal beat.",
          visualMood: "calm desk"
        }
      ],
      altText: "diary about the route guard cleanup",
      metadata: {
        targetDate: "2026-05-12",
        generatedAt: "2026-05-12T23:30:00.000Z",
        activityLevel: "medium",
        mood: "grind",
        angle: "The day circled the same flaky provider validation bug.",
        projectIds: ["uncommitted"],
        entryMode: "daily_global",
        slideCount: 2
      }
    };

    const redacted = redactArchitectureDisclosureFromDraft(draft);

    expect(redacted.title).not.toContain("admin allowlist");
    expect(redacted.title).toContain("[redacted-architecture]");
    expect(redacted.slides[0]?.title).not.toContain("route guard");
    expect(redacted.slides[0]?.title).toContain("[redacted-architecture]");
    expect(redacted.slides[0]?.body).not.toContain("auth checkpoint");
    expect(redacted.slides[0]?.body).not.toContain("server-side authorization");
    expect(redacted.slides[0]?.visualMood).not.toContain("route guard");
    expect(redacted.slides[0]?.visualMood).toContain("[redacted-architecture]");
    // Unaffected fields must be left byte-for-byte unchanged.
    expect(redacted.slides[1]).toEqual(draft.slides[1]);
    expect(redacted.altText).not.toContain("route guard");
    expect(redacted.altText).toContain("[redacted-architecture]");
    expect(redacted.metadata).toEqual(draft.metadata);
  });

  it("redacts architecture-disclosure detail from the draft metadata angle", () => {
    const draft: DiaryDraft = {
      schemaVersion: 1,
      targetDate: "2026-05-12",
      title: "a perfectly normal day",
      slides: [
        {
          index: 1,
          title: "signal",
          body: "Shipped a small feature and fixed a typo.",
          visualMood: "quiet terminal"
        }
      ],
      altText: "diary",
      metadata: {
        targetDate: "2026-05-12",
        generatedAt: "2026-05-12T23:30:00.000Z",
        activityLevel: "medium",
        mood: "grind",
        angle: "Framed as the route guard that finally stopped flaking.",
        projectIds: ["uncommitted"],
        entryMode: "daily_global",
        slideCount: 1
      }
    };

    const redacted = redactArchitectureDisclosureFromDraft(draft);

    expect(redacted.metadata.angle).not.toContain("route guard");
    expect(redacted.metadata.angle).toContain("[redacted-architecture]");
    // Non-angle metadata fields stay byte-for-byte unchanged.
    expect(redacted.metadata.mood).toBe(draft.metadata.mood);
    expect(redacted.metadata.slideCount).toBe(draft.metadata.slideCount);
  });

  it("leaves a draft with no disclosure content unchanged", () => {
    const draft: DiaryDraft = {
      schemaVersion: 1,
      targetDate: "2026-05-12",
      title: "a perfectly normal day",
      slides: [
        {
          index: 1,
          title: "signal",
          body: "Shipped a small feature and fixed a typo.",
          visualMood: "quiet terminal"
        }
      ],
      altText: "diary",
      metadata: {
        targetDate: "2026-05-12",
        generatedAt: "2026-05-12T23:30:00.000Z",
        activityLevel: "medium",
        mood: "cleanup",
        angle: "A small feature shipped and a typo got fixed.",
        projectIds: ["uncommitted"],
        entryMode: "daily_global",
        slideCount: 1
      }
    };

    expect(redactArchitectureDisclosureFromDraft(draft)).toEqual(draft);
  });

  it("redacts a disclosure token found only in altText, with title and slides clean", () => {
    const draft: DiaryDraft = {
      schemaVersion: 1,
      targetDate: "2026-05-12",
      title: "a perfectly normal day",
      slides: [
        {
          index: 1,
          title: "signal",
          body: "Shipped a small feature and fixed a typo.",
          visualMood: "quiet terminal"
        }
      ],
      altText:
        "Story card showing a developer relieved after the auth checkpoint stopped flaking.",
      metadata: {
        targetDate: "2026-05-12",
        generatedAt: "2026-05-12T23:30:00.000Z",
        activityLevel: "medium",
        mood: "cleanup",
        angle: "A small feature shipped and a typo got fixed.",
        projectIds: ["uncommitted"],
        entryMode: "daily_global",
        slideCount: 1
      }
    };

    const redacted = redactArchitectureDisclosureFromDraft(draft);

    expect(redacted.altText).not.toContain("auth checkpoint");
    expect(redacted.altText).toContain("[redacted-architecture]");
    expect(redacted.title).toBe(draft.title);
    expect(redacted.slides).toEqual(draft.slides);
  });

  it("redacts architecture-disclosure detail from a caption string", () => {
    const caption =
      "오늘은 route guard 버그를 잡았다. admin allowlist는 여전히 말썽이다.";

    const redacted = redactArchitectureDisclosureFromCaption(caption);

    expect(redacted).not.toContain("route guard");
    expect(redacted).not.toContain("admin allowlist");
    expect(redacted).toContain("[redacted-architecture]");
  });

  it("leaves a caption with no disclosure content unchanged", () => {
    const caption = "오늘은 조용한 날이었다.";

    expect(redactArchitectureDisclosureFromCaption(caption)).toBe(caption);
  });
});

describe("caption generator", () => {
  it("buildCaptionInstructions replaces fixed-voice good examples with a structure-only skeleton and keeps bad examples", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    // Fixed-voice GOOD examples (fossilized observer narrator) removed
    expect(instructions).not.toContain("caption 몇 줄만 손보자고 했는데");
    expect(instructions).not.toContain("preview 만든다길래");
    expect(instructions).not.toContain("=== GOOD EXAMPLES ===");

    // Structure-only skeleton present, explicitly not a voice source
    expect(instructions).toContain("STRUCTURE SKELETON");
    expect(instructions).toContain(
      "come from the persona voice lines above and today's mood guidance"
    );

    // Bad examples (voice-neutral anti-patterns) still present
    expect(instructions).toContain("보이지 않는 가능성이");
    expect(instructions).toContain("오늘도 개발했습니다");

    // Core style rules
    expect(instructions).toContain("AI");
    expect(instructions).toContain("Instagram");

    // captionStyle is now legitimately consumed from the day's mood plan
    expect(instructions).toContain(captionTestMoodPlan.captionStyle);
  });

  it("buildCaptionInstructions quiet-day variant mentions absence of work", () => {
    const instructions = buildCaptionInstructions({
      quiet: true,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain("조용한 날");
  });

  it("buildCaptionInstructions derives identity/voice/humor from the persona and changes across presets", () => {
    const personaA = PERSONA_PRESETS["까칠한 시니어"].persona;
    const personaB = PERSONA_PRESETS["텐션 높은 주니어"].persona;

    const instructionsA = buildCaptionInstructions({
      quiet: false,
      persona: personaA,
      moodPlan: captionTestMoodPlan
    });
    const instructionsB = buildCaptionInstructions({
      quiet: false,
      persona: personaB,
      moodPlan: captionTestMoodPlan
    });

    expect(instructionsA).not.toBe(instructionsB);

    expect(instructionsA).toContain(personaA.identity.name);
    expect(instructionsA).toContain(personaA.identity.relationship);
    expect(instructionsA).toContain(personaA.identity.backstory);
    expect(instructionsA).toContain(personaA.humor.style);

    expect(instructionsB).toContain(personaB.identity.name);
    expect(instructionsB).toContain(personaB.identity.relationship);
    expect(instructionsB).toContain(personaB.identity.backstory);
    expect(instructionsB).toContain(personaB.humor.style);

    // The old hardcoded coworker identity literal must no longer be a
    // constant baked into the instructions regardless of persona.
    expect(instructionsA).not.toContain("You are Uncommitted, an AI 동료");
    expect(instructionsB).not.toContain("You are Uncommitted, an AI 동료");
  });

  it("buildCaptionInstructions appends the register-diversification rule when registerVariety is true", () => {
    expect(captionTestPersona.voice.registerVariety).toBe(true);

    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain("음");
    expect(instructions).toContain("슴");
    expect(instructions).toContain("요체");
    expect(instructions).toContain("질문");
    expect(instructions).toContain("긴 문장");
    expect(instructions).toContain("일변도 금지");
  });

  it("buildCaptionInstructions omits the register-diversification rule when registerVariety is false", () => {
    const uniformPersona: Persona = {
      ...captionTestPersona,
      voice: { ...captionTestPersona.voice, registerVariety: false }
    };

    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: uniformPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).not.toContain("일변도 금지");
  });

  it("buildCaptionInstructions reflects today's mood/captionStyle/angle and differs across moods", () => {
    const moodPlanA = createStoryFormatPlan({
      captionStyle: "말수 적고 건조한 관찰 캡션"
    });
    const moodPlanB: MoodPlan = {
      ...moodPlanA,
      mood: "breakthrough",
      angle: "A stubborn bug finally gave up after a week of circling it.",
      captionStyle: "들뜬 축하 캡션",
      doNotMention: []
    };

    const instructionsA = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: moodPlanA
    });
    const instructionsB = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: moodPlanB
    });

    expect(instructionsA).not.toBe(instructionsB);
    expect(instructionsA).toContain(moodPlanA.mood);
    expect(instructionsA).toContain(moodPlanA.captionStyle);
    expect(instructionsA).toContain(moodPlanA.angle);
    expect(instructionsB).toContain(moodPlanB.mood);
    expect(instructionsB).toContain(moodPlanB.captionStyle);
    expect(instructionsB).toContain(moodPlanB.angle);
  });

  it("buildCaptionInstructions includes a doNotMention line only when the mood plan's doNotMention is non-empty", () => {
    const withDoNotMention = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(withDoNotMention).toContain("Do not mention:");
    expect(withDoNotMention).toContain("raw diffs");

    const withoutDoNotMention = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: { ...captionTestMoodPlan, doNotMention: [] }
    });

    expect(withoutDoNotMention).not.toContain("Do not mention:");
  });

  it("buildCaptionInstructions instructs translating developer jargon into human stakes", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain("archive-context PR");
    expect(instructions).toContain("뒤로가기 버튼을 못 믿는 하루");
    expect(instructions).toContain("human stakes");
    expect(instructions).toContain(
      "Do not leave raw jargon such as PR numbers, version tags, or module/file names"
    );
  });

  it("generateCaption sends commitSubjects as caption anchor in prompt input", async () => {
    const provider = new MockAiProvider({
      response: {
        caption:
          "caption 몇 줄만 손보자고 했는데\n프롬프트 말투 회의가 됐습니다\n\n저는 옆에서 예시들 맞고 있었습니다",
        hashtags: ["#Uncommitted", "#AI동료일지", "#프롬프트개선"]
      }
    });

    await generateCaption({
      activitySummary: createActivitySummary({
        commitSignals: {
          totalCommits: 2,
          filesChanged: 4,
          insertions: 120,
          deletions: 18,
          subjects: ["add caption prompt", "fix rendering bug"],
          themes: ["coding"]
        }
      }),
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan
    });

    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.task).toBe("caption");
    const inputJson = JSON.stringify(request.input);
    expect(inputJson).toContain("add caption prompt");
    expect(inputJson).toContain("fix rendering bug");
  });

  it("generateCaption forwards the day's moodPlan (mood/angle/captionStyle/doNotMention) into the provider input", async () => {
    const provider = new MockAiProvider({
      response: {
        caption: "그 버그를 오늘도 또 만났습니다",
        hashtags: ["#Uncommitted", "#버그"]
      }
    });

    await generateCaption({
      activitySummary: createActivitySummary(),
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan
    });

    const request = provider.requests[0]!;
    expect(request.input.moodPlan).toEqual({
      mood: captionTestMoodPlan.mood,
      angle: captionTestMoodPlan.angle,
      captionStyle: captionTestMoodPlan.captionStyle,
      doNotMention: captionTestMoodPlan.doNotMention
    });
  });

  it("generateCaption forwards the raw narrative projection to the caption prompt input", async () => {
    const provider = new MockAiProvider({
      response: {
        caption: "오늘은 원문에 적힌 그 순간을 가져왔습니다",
        hashtags: ["#Uncommitted", "#AI동료일지"]
      }
    });

    await generateCaption({
      activitySummary: createActivitySummary(),
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan,
      rawNarrativeProjection: {
        turns: [
          {
            source: "claude",
            text: "Untangled the selection policy and landed a clean fix.",
            tokenEstimate: 13
          }
        ],
        totalTokens: 13,
        droppedTurns: 0,
        droppedTokens: 0,
        budget: 4000
      }
    });

    const request = provider.requests[0]!;
    const inputJson = JSON.stringify(request.input);
    expect(inputJson).toContain(
      "Untangled the selection policy and landed a clean fix."
    );
  });

  it("generateCaption returns validated { caption, hashtags[] } from mocked provider", async () => {
    const provider = new MockAiProvider({
      response: {
        caption:
          "preview 만든다길래\n이제 결과물 바로 보는 줄 알았습니다\n\n개발자들은 왜 항상\n자기가 만든 걸 제일 못 믿을까요",
        hashtags: ["#Uncommitted", "#Preview", "#개발일기"]
      }
    });

    const result = await generateCaption({
      activitySummary: createActivitySummary(),
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan
    });

    expect(result.caption).toBe(
      "preview 만든다길래\n이제 결과물 바로 보는 줄 알았습니다\n\n개발자들은 왜 항상\n자기가 만든 걸 제일 못 믿을까요"
    );
    expect(result.hashtags).toEqual([
      "#Uncommitted",
      "#Preview",
      "#개발일기"
    ]);
  });

  it("generateCaption throws AiGenerationError on malformed provider response", async () => {
    const emptyProvider = new MockAiProvider({ response: {} });
    const missingHashtagsProvider = new MockAiProvider({
      response: { caption: "괜찮은 날이었습니다" }
    });
    const badHashtagProvider = new MockAiProvider({
      response: {
        caption: "괜찮은 날이었습니다",
        hashtags: ["noHash"]
      }
    });
    const failingProvider = new MockAiProvider({
      failure: new Error("network error")
    });

    await expect(
      generateCaption({
        activitySummary: createActivitySummary(),
        provider: emptyProvider,
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toMatchObject({ code: "malformed-response" });

    await expect(
      generateCaption({
        activitySummary: createActivitySummary(),
        provider: missingHashtagsProvider,
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toMatchObject({ code: "malformed-response" });

    await expect(
      generateCaption({
        activitySummary: createActivitySummary(),
        provider: badHashtagProvider,
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toMatchObject({ code: "malformed-response" });

    await expect(
      generateCaption({
        activitySummary: createActivitySummary(),
        provider: failingProvider,
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toBeInstanceOf(AiGenerationError);
  });

  it("generateCaption rejects quiet-day caption that fabricates work", async () => {
    const quietSummary = createActivitySummary({
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
      manualContext: { noteCount: 0, notes: [] },
      smallWins: [],
      unfinishedThreads: []
    });

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        provider: new MockAiProvider({
          response: {
            caption: "오늘 인증 기능을 shipped 했습니다",
            hashtags: ["#Uncommitted"]
          }
        }),
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      message: "AI provider fabricated quiet-day activity in caption."
    });

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        provider: new MockAiProvider({
          response: {
            caption: "버그를 fixed 하고 배포도 merged 했습니다",
            hashtags: ["#Uncommitted"]
          }
        }),
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toMatchObject({
      code: "malformed-response"
    });

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        provider: new MockAiProvider({
          response: {
            caption: "오늘은 조용한 하루였습니다. 기다리고 관찰했습니다.",
            hashtags: ["#Uncommitted", "#조용한날"]
          }
        }),
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).resolves.toMatchObject({
      caption: "오늘은 조용한 하루였습니다. 기다리고 관찰했습니다."
    });
  });

  it("generateCaption uses manual note texts as highlights when commit subjects are absent", async () => {
    const noteOnlySummary = createActivitySummary({
      activityLevel: "low",
      dominantTheme: "planning",
      projects: [
        {
          projectId: "uncommitted",
          projectName: "uncommitted",
          repositoryName: "uncommitted",
          commitCount: 0,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          uncommittedChangeCount: 0,
          manualNoteCount: 2,
          themes: ["planning"],
          summary: "2 manual notes, no commits"
        }
      ],
      commitSignals: {
        totalCommits: 0,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        subjects: [],
        themes: []
      },
      manualContext: {
        noteCount: 2,
        notes: [
          {
            projectId: "uncommitted",
            timestamp: "2026-05-12T10:00:00.000Z",
            text: "Reviewed the onboarding docs."
          },
          {
            projectId: "uncommitted",
            timestamp: "2026-05-12T14:00:00.000Z",
            text: "Updated the API reference."
          }
        ]
      },
      smallWins: []
    });

    const provider = new MockAiProvider({
      response: {
        caption: "문서 정리하는 하루였습니다",
        hashtags: ["#Uncommitted"]
      }
    });

    await generateCaption({
      activitySummary: noteOnlySummary,
      provider,
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan
    });

    const inputJson = JSON.stringify(provider.requests[0]?.input);
    expect(inputJson).toContain("Reviewed the onboarding docs.");
    expect(inputJson).toContain("Updated the API reference.");
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

// Fixture overrides keep the flat legacy shape (formatName/suggestedSlideCount)
// so existing call sites stay unchanged; internally mapped onto the MoodPlan
// diary-generator now requires (mood/angle/pacing.suggestedSlideCount).
// `formatName` here is fixture-only shorthand — MoodPlan has no such field
// since UNC-215.
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
