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

  it("diary instructions carry the altitude rule with its no-fabrication boundary (UNC-248)", async () => {
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
    expect(instructions).toContain("Altitude rule: raise the framing, never the facts");
    expect(instructions).toContain(
      "instead of naming the specific ticket, screen, module, or file"
    );
    expect(instructions).toContain("Raising altitude means rewording the same event");
    expect(instructions).toContain(
      "do not invent work, drama, stakes, or consequences the activity summary does not support"
    );
  });

  it("diary instructions carry the deadpan frame without weakening the human boundary (UNC-249)", async () => {
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
    expect(instructions).toContain(
      "When the humor lands as irony, deliver it straight-faced, as if stating sincere advice or an obvious truth"
    );
    expect(instructions).toContain("Never signal that you are joking");
    expect(instructions).toContain(
      "It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life"
    );
    // 기존 로스트 경계가 그대로 남아 있어야 한다
    expect(instructions).toContain(
      "Never attack the user's identity, ability, appearance, mental health, personal value, or real life"
    );
  });

  it("diary instructions gain the Korean-surface rule and the internal-identifier policy (UNC-250)", async () => {
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
    expect(instructions).toContain(
      "Write the reader-facing surface — story title, slide titles, slide bodies, altText, and caption — in Korean"
    );
    expect(instructions).toContain("hashtag tokens (anything starting with #) may stay in English");
    expect(instructions).toContain("CI, PR, API, UI, AI, JSON, URL");
    expect(instructions).toContain("Internal identifiers must never appear");
    expect(instructions).toContain("ticket keys such as UNC-123");
  });

  it("story instructions name the persona's Korean-English mix so the knob is not a dead claim (UNC-250)", async () => {
    const highMix = new MockAiProvider({ response: createProviderDraft() });
    const lowMix = new MockAiProvider({ response: createProviderDraft() });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider: highMix,
      persona: "wry coworker",
      roastLevel: 2,
      koreanEnglishMix: "high"
    });
    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider: lowMix,
      persona: "wry coworker",
      roastLevel: 2,
      koreanEnglishMix: "low"
    });

    const highInstructions = highMix.requests[0]?.instructions ?? "";
    const lowInstructions = lowMix.requests[0]?.instructions ?? "";

    expect(highInstructions).toContain('Korean-English mix setting is "high"');
    expect(lowInstructions).toContain('Korean-English mix setting is "low"');
    expect(highInstructions).not.toBe(lowInstructions);
  });

  it("still rejects quiet-day fabrication dressed up as universal framing (UNC-251)", async () => {
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
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 협업 팁 ①",
                body: "누구나 아는 그 순간이 왔습니다. 오늘도 조용히 3 commits 를 밀어 넣는 하루.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "보편적인 오후",
                body: "모두가 겪는 일입니다. 아무 말 없이 버그가 fixed 되어 있는 오후 말입니다.",
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

  it("accepts a quiet day framed universally when no work is claimed (UNC-251)", async () => {
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
        smallWins: [],
        unfinishedThreads: []
      }),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
      provider: new MockAiProvider({
        response: createProviderDraft({
          slides: [
            {
              index: 1,
              title: "좋은 생산성 팁 ①",
              body: "아무것도 기록되지 않은 날을 가지세요. 기록할 게 없다는 것도 하루의 모양입니다.",
              visualMood: "still terminal"
            },
            {
              index: 2,
              title: "기다림",
              body: "누구에게나 있는 그 하루. 커서만 깜빡이고 아무 일도 일어나지 않았습니다.",
              visualMood: "waiting cursor"
            },
            {
              index: 3,
              title: "마무리",
              body: "내일의 기록을 기다리는 쪽으로 닫았습니다.",
              visualMood: "small note"
            }
          ]
        })
      }),
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft.metadata.activityLevel).toBe("none");
    expect(draft.slides).toHaveLength(3);
  });

  it("rejects quiet-day fabrication written entirely in Korean (UNC-251)", async () => {
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
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 협업 팁 ①",
                body: "누구나 아는 그 순간이 왔습니다. 오늘도 조용히 커밋 세 개를 올렸습니다.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "보편적인 오후",
                body: "모두가 겪는 일입니다. 아무 말 없이 버그를 고쳤습니다.",
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

  it("rejects ordinary Korean work claims beyond the fixed-verb examples (UNC-251)", async () => {
    const claims = [
      "누구나 아는 그 순간입니다. 오늘도 조용히 기능을 추가했습니다.",
      "모두가 겪는 오후입니다. 테스트를 작성했습니다.",
      "그리고 아무 말 없이 PR을 올렸습니다."
    ];

    for (const claim of claims) {
      await expect(
        generateDiaryDraft({
          activitySummary: createQuietActivitySummary(),
          storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
          provider: new MockAiProvider({
            response: createProviderDraft({
              slides: [
                {
                  index: 1,
                  title: "좋은 협업 팁 ①",
                  body: claim,
                  visualMood: "still terminal"
                },
                {
                  index: 2,
                  title: "기다림",
                  body: "커서만 깜빡이는 오후였습니다.",
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
    }
  });

  it("accepts a quiet day that denies work using Korean completion stems (UNC-251)", async () => {
    const draft = await generateDiaryDraft({
      activitySummary: createQuietActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
      provider: new MockAiProvider({
        response: createProviderDraft({
          slides: [
            {
              index: 1,
              title: "좋은 생산성 팁 ①",
              body: "고쳤다고 할 것도 없었습니다. 그런 하루도 하루의 모양입니다.",
              visualMood: "still terminal"
            },
            {
              index: 2,
              title: "기다림",
              body: "아무것도 해결했다고 말할 수 없습니다.",
              visualMood: "waiting cursor"
            },
            {
              index: 3,
              title: "마무리",
              body: "무언가를 추가했다고 우길 생각은 없습니다.",
              visualMood: "small note"
            }
          ]
        })
      }),
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft.slides).toHaveLength(3);
  });

  it("rejects a claimed completion even when a later clause denies other work (UNC-251)", async () => {
    await expect(
      generateDiaryDraft({
        activitySummary: createQuietActivitySummary(),
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 협업 팁 ①",
                body: "기능을 추가했지만 테스트는 완료하지 못했습니다.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "기다림",
                body: "커서만 깜빡이는 오후였습니다.",
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

  it("separates finishing the day from finishing work (UNC-251)", async () => {
    const closeTheDay = await generateDiaryDraft({
      activitySummary: createQuietActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
      provider: new MockAiProvider({
        response: createProviderDraft({
          slides: [
            {
              index: 1,
              title: "좋은 생산성 팁 ①",
              body: "오늘은 조용히 하루를 마쳤습니다.",
              visualMood: "still terminal"
            },
            {
              index: 2,
              title: "기다림",
              body: "커서만 깜빡이는 오후였습니다.",
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
    });

    expect(closeTheDay.slides).toHaveLength(3);

    await expect(
      generateDiaryDraft({
        activitySummary: createQuietActivitySummary(),
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 생산성 팁 ①",
                body: "오늘은 조용히 작업을 마쳤습니다.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "기다림",
                body: "커서만 깜빡이는 오후였습니다.",
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

  it("does not scan past 으며 into an unrelated denial (UNC-251)", async () => {
    await expect(
      generateDiaryDraft({
        activitySummary: createQuietActivitySummary(),
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 협업 팁 ①",
                body: "기능을 추가했으며 테스트는 완료하지 못했습니다.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "기다림",
                body: "커서만 깜빡이는 오후였습니다.",
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

  it("accepts pre-verbal negation such as 안/못 before a completion stem (UNC-251)", async () => {
    const draft = await generateDiaryDraft({
      activitySummary: createQuietActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
      provider: new MockAiProvider({
        response: createProviderDraft({
          slides: [
            {
              index: 1,
              title: "좋은 생산성 팁 ①",
              body: "오늘은 코드를 안 만들었습니다.",
              visualMood: "still terminal"
            },
            {
              index: 2,
              title: "기다림",
              body: "버그는 못 고쳤습니다. 볼 버그가 없었으니까요.",
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
    });

    expect(draft.slides).toHaveLength(3);
  });

  it("keeps a claim when a later clause denies different work, whatever the connective (UNC-251)", async () => {
    for (const claim of [
      "기능을 추가했기에 테스트까지는 못했습니다.",
      "기능을 추가했으므로 테스트는 하지 못했습니다.",
      "기능을 추가했는데 테스트는 못 했습니다."
    ]) {
      await expect(
        generateDiaryDraft({
          activitySummary: createQuietActivitySummary(),
          storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
          provider: new MockAiProvider({
            response: createProviderDraft({
              slides: [
                {
                  index: 1,
                  title: "좋은 협업 팁 ①",
                  body: claim,
                  visualMood: "still terminal"
                },
                {
                  index: 2,
                  title: "기다림",
                  body: "커서만 깜빡이는 오후였습니다.",
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
    }
  });

  it("exempts negation only when it governs the completion stem itself (UNC-251)", async () => {
    // `안`이 앞 동사(보고)를 부정할 뿐 `짰`을 부정하지 않으므로 주장 그대로다.
    await expect(
      generateDiaryDraft({
        activitySummary: createQuietActivitySummary(),
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 협업 팁 ①",
                body: "코드 안 보고 짰습니다.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "기다림",
                body: "커서만 깜빡이는 오후였습니다.",
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

    const denied = await generateDiaryDraft({
      activitySummary: createQuietActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
      provider: new MockAiProvider({
        response: createProviderDraft({
          slides: [
            {
              index: 1,
              title: "좋은 생산성 팁 ①",
              body: "커밋 세 개도 안 올렸습니다.",
              visualMood: "still terminal"
            },
            {
              index: 2,
              title: "기다림",
              body: "고쳤을 리가 없습니다. 볼 버그가 없었으니까요.",
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
    });

    expect(denied.slides).toHaveLength(3);
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

  it("buildCaptionInstructions carries the altitude rule with its no-fabrication boundary (UNC-248)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain("Altitude rule: raise the framing, never the facts");
    expect(instructions).toContain(
      "instead of naming the specific ticket, screen, module, or file"
    );
    // 보편화가 지어내기로 번지지 않도록 같은 자리에 경계를 명시한다
    expect(instructions).toContain("Raising altitude means rewording the same event");
    expect(instructions).toContain(
      "do not invent work, drama, stakes, or consequences the activity summary does not support"
    );
  });

  it("buildCaptionInstructions carries the deadpan frame without weakening the human boundary (UNC-249)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain(
      "When the humor lands as irony, deliver it straight-faced, as if stating sincere advice or an obvious truth"
    );
    expect(instructions).toContain("Never signal that you are joking");
    expect(instructions).toContain(
      "It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life"
    );
    // 기존 로스트 경계가 그대로 남아 있어야 한다
    expect(instructions).toContain(
      "Never insult ability, worth, personality, identity, mental health, or real life"
    );
  });

  it("buildCaptionInstructions widens English suppression and carries the internal-identifier policy (UNC-250)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    // 일반 영어 명사구 억제로 확대
    expect(instructions).toContain(
      "Write the reader-facing surface — story title, slide titles, slide bodies, altText, and caption — in Korean"
    );
    expect(instructions).toContain("English noun phrase that has a natural Korean equivalent");
    expect(instructions).toContain("working tree");
    expect(instructions).toContain("fire-and-forget");

    // 해시태그·통용 약어 예외 명시
    expect(instructions).toContain("hashtag tokens (anything starting with #) may stay in English");
    expect(instructions).toContain("CI, PR, API, UI, AI, JSON, URL");

    // 내부 식별자 전면 마스킹 정책 (UNC-247 결정)
    expect(instructions).toContain("Internal identifiers must never appear");
    expect(instructions).toContain("ticket keys such as UNC-123");
    expect(instructions).toContain("FeedbackModal");

    // 기존 좁은 규칙이 넓혀진 형태로 남아 있다
    expect(instructions).toContain(
      "Translate developer jargon and any project-internal English noun phrase"
    );
    expect(instructions).toContain(
      "Do not leave raw jargon or untranslated English noun phrases"
    );
  });

  it("keeps the altitude, deadpan, and Korean-surface rule blocks in sync across both prompts (UNC-234)", async () => {
    const captionInstructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

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

    const diaryInstructions = provider.requests[0]?.instructions ?? "";

    const sharedRuleLines = [
      // ALTITUDE_RULE_LINES
      "Altitude rule: raise the framing, never the facts. Describe the work you were given as a situation any developer would recognize, instead of naming the specific ticket, screen, module, or file it happened in.",
      "Raising altitude means rewording the same event. It never means adding one: do not invent work, drama, stakes, or consequences the activity summary does not support. Universal does not mean vague: the framing must still be specific enough that only today's work fits it. If the line could be published unchanged on any other day, it is too high.",
      // DEADPAN_FRAME_LINES
      "When the humor lands as irony, deliver it straight-faced, as if stating sincere advice or an obvious truth. The humor comes from the gap between the calm delivery and the actual situation.",
      "Never signal that you are joking: no winking and no explaining the bit.",
      "The deadpan frame targets situations, tools, and workflows only. It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life.",
      // KOREAN_SURFACE_LINES
      "Write the reader-facing surface — story title, slide titles, slide bodies, altText, and caption — in Korean. Any English noun phrase that has a natural Korean equivalent must be written in Korean instead — for example \"working tree\", \"fire-and-forget\", \"boundary tape\", \"release-shaped moment\" should be expressed as Korean, not printed in English.",
      "Exceptions: hashtag tokens (anything starting with #) may stay in English, and widely used abbreviations may stay as-is: CI, PR, API, UI, AI, JSON, URL — the abbreviation only, never a specific number or key attached to it. Public tool, language, and platform names such as Git, TypeScript, or Instagram are also allowed. The persona's Korean-English mix setting governs how freely these allowed English tokens appear; it never licenses untranslated internal or translatable noun phrases.",
      "Internal identifiers must never appear: ticket keys such as UNC-123, internal screen, module, class, or file names such as FeedbackModal or diary-generator.ts, and proper nouns that appear only in internal branch names or PR titles. Reframe them as the universal situation they describe instead of masking them with placeholder text."
    ];

    for (const line of sharedRuleLines) {
      expect(captionInstructions).toContain(line);
      expect(diaryInstructions).toContain(line);
    }
  });

  it("still rejects a quiet-day caption that hides fabrication behind universal framing (UNC-251)", async () => {
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
      smallWins: [],
      unfinishedThreads: []
    });

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        provider: new MockAiProvider({
          response: {
            caption:
              "좋은 하루 관리 팁 ①\n\n누구나 겪는 그 오후에\n버그 하나를 조용히 fixed 해두세요.\n\n아무도 모르게요.",
            hashtags: ["#Uncommitted", "#개발일기"]
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
  });

  it("accepts a quiet-day caption that stays universal without claiming work (UNC-251)", async () => {
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
      smallWins: [],
      unfinishedThreads: []
    });

    const result = await generateCaption({
      activitySummary: quietSummary,
      provider: new MockAiProvider({
        response: {
          caption:
            "좋은 생산성 팁 ①\n\n오늘은 아무것도 남기지 마세요.\n기록이 없는 날도 하루의 모양입니다.\n\n저는 옆에서 커서만 봤습니다.",
          hashtags: ["#Uncommitted", "#개발일기"]
        }
      }),
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan
    });

    expect(result.caption).toContain("기록이 없는 날");
    expect(result.hashtags).toHaveLength(2);
  });

  it("rejects a quiet-day caption whose fabrication is written entirely in Korean (UNC-251)", async () => {
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
      smallWins: [],
      unfinishedThreads: []
    });

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        provider: new MockAiProvider({
          response: {
            caption:
              "좋은 하루 관리 팁 ①\n\n누구나 겪는 그 오후에\n버그 하나를 조용히 고쳤습니다.\n\n아무도 모르게요.",
            hashtags: ["#Uncommitted", "#개발일기"]
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
      "Do not leave raw jargon or untranslated English noun phrases such as PR numbers, version tags, module/file names, or internal screen names"
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
