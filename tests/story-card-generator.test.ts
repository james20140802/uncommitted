import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  createAiGenerationRequest,
  type AiProvider,
  type AiProviderRawResponse,
  type AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import type { MoodPlan } from "../src/story-format-plan.js";
import { listStoryCardCandidateProjections } from "../src/story-card-registry.js";
import { STORY_CARD_VIOLATIONS } from "../src/story-card-plan.js";
import { RECURRING_THREAD_INSTRUCTIONS } from "../src/recurring-thread-instructions.js";
import { buildCaptionInstructions } from "../src/diary-generator.js";
import { PERSONA_PRESETS } from "../src/persona.js";
import {
  KOREAN_SURFACE_RULES,
  buildKoreanEnglishMixLine
} from "../src/korean-surface-instructions.js";
import { ARCHITECTURE_DISCLOSURE_REPLACEMENT } from "../src/architecture-disclosure.js";
import {
  STORY_CARD_MAX_ATTEMPTS,
  STORY_MANUSCRIPT_CARD_RULES,
  buildSafeStoryManuscript,
  buildStoryCardInstructions,
  generateStoryCardPlan
} from "../src/story-card-generator.js";

function createSummary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-08-17",
    generatedAt: "2026-08-17T00:00:00.000Z",
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
    manualContext: { noteCount: 0, notes: [] },
    smallWins: [],
    blockersOrConfusion: [],
    unfinishedThreads: [],
    possibleJokes: [],
    publicSafetyNotes: [],
    privateItemsToAvoid: [],
    uncertaintyNotes: [],
    ...overrides
  };
}

function createMoodPlan(suggestedSlideCount = 3): MoodPlan {
  return {
    schemaVersion: 2,
    mood: "quiet",
    angle: "조용한 하루",
    reason: "활동이 적다",
    structure: [{ part: "open", purpose: "조용히 연다" }],
    pacing: { openWith: "scene", shape: "single-beat", suggestedSlideCount },
    captionStyle: "담담하게",
    doNotMention: []
  };
}

/**
 * 응답을 순서대로 되돌려주는 스텁 프로바이더. 실제 AiProvider 인터페이스는
 * generateStructured를 요구한다 (tests/generate-command.test.ts의
 * TaskAwareProvider와 같은 관례) — 브리프의 예시 스텁이 쓴 generate()는
 * 실제 인터페이스와 어긋나서 그대로 베끼지 않았다.
 */
function createStubProvider(responses: string[]): AiProvider & { calls: number } {
  let index = 0;

  return {
    name: "mock",
    model: "stub",
    calls: 0,
    async generateStructured(): Promise<AiProviderRawResponse> {
      const body = responses[Math.min(index, responses.length - 1)];
      index += 1;
      (this as { calls: number }).calls = index;

      return { responseJson: body };
    }
  } as AiProvider & { calls: number };
}

function cardResponse(
  cards: { type: string; slots: { name: string; lines: string[] }[] }[]
): string {
  return JSON.stringify({ cards });
}

describe("buildStoryCardInstructions", () => {
  it("enumerates today's candidate ids and their slot limits", () => {
    const candidates = listStoryCardCandidateProjections(createSummary());
    const instructions = buildStoryCardInstructions({
      quiet: true,
      cardCount: 3,
      candidates
    });

    for (const candidate of candidates) {
      expect(instructions).toContain(candidate.id);
    }
    expect(instructions).toContain("3");
    expect(instructions.toLowerCase()).toContain("maxlength");
  });

  it("forbids markup and card labels in the output contract", () => {
    const instructions = buildStoryCardInstructions({
      quiet: false,
      cardCount: 4,
      candidates: listStoryCardCandidateProjections(createSummary())
    });

    expect(instructions.toLowerCase()).toContain("html");
    expect(instructions.toLowerCase()).toContain("label");
  });
});

describe("generateStoryCardPlan", () => {
  it("returns accepted outcomes when the first response is valid", async () => {
    const provider = createStubProvider([
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["조용한 하루"] }] }
      ])
    ]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider
    });

    expect(result.attempts).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("accepted");
  });

  it("retries once when a card violates its slot constraints, then succeeds", async () => {
    const provider = createStubProvider([
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["가".repeat(80)] }] }
      ]),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["짧은 제목"] }] }
      ])
    ]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider
    });

    expect(provider.calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.outcomes[0].status).toBe("accepted");
  });

  it("feeds the violation reason back into the retry instructions", async () => {
    const seenInstructions: string[] = [];
    const responses = [
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["가".repeat(80)] }] }
      ]),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["짧은 제목"] }] }
      ])
    ];
    let index = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(
        request: AiStructuredGenerationRequest
      ): Promise<AiProviderRawResponse> {
        seenInstructions.push(request.instructions);
        const body = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return { responseJson: body };
      }
    };

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider
    });

    expect(seenInstructions).toHaveLength(2);
    expect(seenInstructions[1]).toContain("card-text-too-long");
    expect(seenInstructions[1].length).toBeGreaterThan(
      seenInstructions[0].length
    );
  });

  it("returns the partial outcomes instead of throwing when retries are exhausted", async () => {
    const provider = createStubProvider([
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["좋은 카드"] }] },
        { type: "nope", slots: [{ name: "headline", lines: ["없는 종류"] }] }
      ])
    ]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(2),
      provider
    });

    expect(result.attempts).toBe(STORY_CARD_MAX_ATTEMPTS);
    expect(result.outcomes[0].status).toBe("accepted");
    expect(result.outcomes[1].status).toBe("rejected");
    expect(result.rawResponseJson).toBeTypeOf("string");
    expect(result.providerFailure).toBeUndefined();
  });

  it("retries a response that contains no cards at all", async () => {
    // 최종 통합 리뷰 지적: 카드 0장 응답은 위반이 0건이라 그대로 통과해
    // 재시도도 진단도 없이 조용히 typo 한 장으로 떨어졌다.
    const provider = createStubProvider([
      JSON.stringify({ cards: [] }),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["복구된 카드"] }] }
      ])
    ]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider
    });

    expect(provider.calls).toBe(2);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("accepted");
  });

  it("feeds the empty-plan violation back into the retry instructions", async () => {
    const seenInstructions: string[] = [];
    const responses = [
      JSON.stringify({ cards: [] }),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["복구된 카드"] }] }
      ])
    ];
    let index = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(
        request: AiStructuredGenerationRequest
      ): Promise<AiProviderRawResponse> {
        seenInstructions.push(request.instructions);
        const body = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return { responseJson: body };
      }
    };

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider
    });

    expect(seenInstructions).toHaveLength(2);
    expect(seenInstructions[1]).toContain(STORY_CARD_VIOLATIONS.emptyCardList);
  });

  it("records a rejected outcome when every attempt returns no cards", async () => {
    // 진단 게이트(generate-command)가 열리려면 거부 결과가 하나는 있어야
    // 한다. 없으면 "이유가 적히지 않은 fallback 하루"가 다시 생긴다.
    const provider = createStubProvider([JSON.stringify({ cards: [] })]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(),
      provider
    });

    expect(result.attempts).toBe(STORY_CARD_MAX_ATTEMPTS);
    expect(result.outcomes).toHaveLength(1);

    const outcome = result.outcomes[0];

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.violations[0].code).toBe(STORY_CARD_VIOLATIONS.emptyCardList);
  });

  it("treats a response with no cards key the same as an empty card list", async () => {
    const provider = createStubProvider([JSON.stringify({})]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(),
      provider
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("rejected");
  });

  it("retries a response whose card count differs from the requested count", async () => {
    // PR #137 리뷰 지적: 지시문은 "exactly N장"인데 검증은 장수를 보지
    // 않아, 6장을 요구해도 1장짜리 응답이 재시도·진단 없이 통과했다.
    const provider = createStubProvider([
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["한 장뿐"] }] }
      ]),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["첫 장"] }] },
        { type: "typo", slots: [{ name: "headline", lines: ["둘째 장"] }] }
      ])
    ]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(2),
      provider
    });

    expect(provider.calls).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    expect(
      result.outcomes.every((outcome) => outcome.status === "accepted")
    ).toBe(true);
  });

  it("feeds the count-mismatch violation back into the retry instructions", async () => {
    const seenInstructions: string[] = [];
    const responses = [
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["한 장뿐"] }] }
      ]),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["첫 장"] }] },
        { type: "typo", slots: [{ name: "headline", lines: ["둘째 장"] }] }
      ])
    ];
    let index = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(
        request: AiStructuredGenerationRequest
      ): Promise<AiProviderRawResponse> {
        seenInstructions.push(request.instructions);
        const body = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return { responseJson: body };
      }
    };

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(2),
      provider
    });

    expect(seenInstructions).toHaveLength(2);
    expect(seenInstructions[1]).toContain(
      STORY_CARD_VIOLATIONS.cardCountMismatch
    );
  });

  it("keeps validated cards and records a count-mismatch rejection when retries run out", async () => {
    // 재시도가 소진돼도 유효한 카드는 살아남아야 하고(부모 AC4), 장수가
    // 어긋났다는 사실은 거부 결과로 남아 진단 게이트를 열어야 한다(부모 AC6).
    const provider = createStubProvider([
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["한 장뿐"] }] }
      ])
    ]);
    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(3),
      provider
    });

    expect(result.attempts).toBe(STORY_CARD_MAX_ATTEMPTS);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0].status).toBe("accepted");

    const rejected = result.outcomes[1];

    expect(rejected.status).toBe("rejected");
    if (rejected.status !== "rejected") return;
    expect(rejected.rawType).toBeNull();
    expect(rejected.violations[0].code).toBe(
      STORY_CARD_VIOLATIONS.cardCountMismatch
    );
  });

  it("propagates a provider-level failure — that is not a card failure", async () => {
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(): Promise<AiProviderRawResponse> {
        throw new Error("network down");
      }
    };

    await expect(
      generateStoryCardPlan({
        activitySummary: createSummary(),
        moodPlan: createMoodPlan(),
        provider
      })
    ).rejects.toThrow();
  });

  it("keeps attempt 1's partial outcomes and records the provider failure when the retry call itself dies", async () => {
    // 리뷰 지적 재현: attempt 1은 위반이 있는 응답을 받아 재시도로 들어가고,
    // attempt 2에서 provider.generateStructured() 자체가 죽는다(네트워크
    // 등). "validate가 한 번이라도 돌았는가"만 보면 이 경우도 마치 재시도가
    // 소진돼 위반이 남은 것처럼 보이지만, 실제로는 프로바이더 호출이 죽은
    // 것이다 — providerFailure로 그 차이를 남겨야 한다.
    let callCount = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(): Promise<AiProviderRawResponse> {
        callCount += 1;

        if (callCount === 1) {
          return {
            responseJson: cardResponse([
              { type: "typo", slots: [{ name: "headline", lines: ["가".repeat(80)] }] }
            ])
          };
        }

        throw new Error("network down");
      }
    };

    const result = await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider
    });

    expect(callCount).toBe(2);
    expect(result.attempts).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("rejected");
    expect(result.providerFailure).toBeDefined();
    expect(result.providerFailure?.code).toBe("provider-failed");
    expect(result.providerFailure?.message.length).toBeGreaterThan(0);
  });

  it("asks for as many cards as the mood plan's suggestedSlideCount", async () => {
    let seen = "";
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(
        request: AiStructuredGenerationRequest
      ): Promise<AiProviderRawResponse> {
        seen = request.instructions;

        return {
          responseJson: cardResponse([
            { type: "typo", slots: [{ name: "headline", lines: ["ok"] }] }
          ])
        };
      }
    };

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(6),
      provider
    });

    expect(seen).toContain("6");
  });
});

describe("카드 슬롯 누적 대비 지시문 (UNC-278 / T6)", () => {
  const recurring = [
    { note: "flaky timeout again", occurrenceCount: 3, lastSeenDate: "2026-08-29" }
  ];

  it("adds nothing when there are no recurring threads (AC2)", () => {
    const without = buildStoryCardInstructions({
      quiet: false,
      cardCount: 4,
      candidates: listStoryCardCandidateProjections(createSummary())
    });
    const withEmpty = buildStoryCardInstructions({
      quiet: false,
      cardCount: 4,
      candidates: listStoryCardCandidateProjections(createSummary()),
      recurringThreads: []
    });

    expect(withEmpty).toBe(without);
    expect(without).not.toContain(RECURRING_THREAD_INSTRUCTIONS.useCumulative);
    expect(without).not.toContain(RECURRING_THREAD_INSTRUCTIONS.noInventedCount);
    expect(without).not.toContain(RECURRING_THREAD_INSTRUCTIONS.noStreak);
    expect(without).not.toContain(RECURRING_THREAD_INSTRUCTIONS.notNewMaterial);
  });

  it("adds the same four constraint sentences the caption uses (AC4)", () => {
    const instructions = buildStoryCardInstructions({
      quiet: false,
      cardCount: 4,
      candidates: listStoryCardCandidateProjections(createSummary()),
      recurringThreads: recurring
    });

    expect(instructions).toContain(RECURRING_THREAD_INSTRUCTIONS.useCumulative);
    expect(instructions).toContain(RECURRING_THREAD_INSTRUCTIONS.noInventedCount);
    expect(instructions).toContain(RECURRING_THREAD_INSTRUCTIONS.noStreak);
    expect(instructions).toContain(RECURRING_THREAD_INSTRUCTIONS.notNewMaterial);
  });

  it("keeps the quiet-day constraint intact when recurring threads exist (AC5)", () => {
    const instructions = buildStoryCardInstructions({
      quiet: true,
      cardCount: 4,
      candidates: listStoryCardCandidateProjections(createSummary()),
      recurringThreads: recurring
    });

    expect(instructions).toContain(
      "Do not manufacture activity to fill the cards."
    );
    expect(instructions).toContain(RECURRING_THREAD_INSTRUCTIONS.noInventedCount);
  });
});

describe("story card instructions follow the Korean surface rules (UNC-286)", () => {
  const base = () => ({
    quiet: false,
    cardCount: 3,
    candidates: listStoryCardCandidateProjections(createSummary())
  });

  it("carries the same shared Korean rule sentences as the story and caption prompts (parent AC1)", () => {
    const card = buildStoryCardInstructions(base());
    const caption = buildCaptionInstructions({
      quiet: false,
      persona: PERSONA_PRESETS["시니컬한 관찰자"].persona,
      moodPlan: createMoodPlan()
    });

    for (const rule of Object.values(KOREAN_SURFACE_RULES)) {
      expect(card).toContain(rule);
      // 캡션 프롬프트도 같은 문장을 가진다 — 출처가 하나임을 교차 확인
      expect(caption).toContain(rule);
    }
  });

  it("names the persona's Korean-English mix value (parent AC2)", () => {
    const high = buildStoryCardInstructions({ ...base(), koreanEnglishMix: "high" });
    const medium = buildStoryCardInstructions({ ...base(), koreanEnglishMix: "medium" });

    expect(high).toContain(buildKoreanEnglishMixLine("high"));
    expect(medium).toContain(buildKoreanEnglishMixLine("medium"));
    expect(high).not.toBe(medium);
  });

  it("defaults the mix to low when the option is omitted", () => {
    expect(buildStoryCardInstructions(base())).toContain(
      buildKoreanEnglishMixLine("low")
    );
  });

  it("passes the mix through generateStoryCardPlan into the provider request and keeps it on retry", async () => {
    const seenInstructions: string[] = [];
    const responses = [
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["가".repeat(80)] }] }
      ]),
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["짧은 제목"] }] }
      ])
    ];
    let index = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(
        request: AiStructuredGenerationRequest
      ): Promise<AiProviderRawResponse> {
        seenInstructions.push(request.instructions);
        const body = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return { responseJson: body };
      }
    };

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider,
      koreanEnglishMix: "high"
    });

    expect(seenInstructions).toHaveLength(2);
    for (const instructions of seenInstructions) {
      expect(instructions).toContain(buildKoreanEnglishMixLine("high"));
      expect(instructions).toContain(KOREAN_SURFACE_RULES.exceptions);
    }
  });
});

describe("story manuscript feeds card slots (UNC-307)", () => {
  const manuscript = [
    { title: "소수점", body: "소수점은 작지만, 행정력은 충분하다." },
    { title: "마감", body: "회의실 예약 시스템처럼 평화롭고 단호했다." }
  ];
  const validResponse = cardResponse([
    { type: "typo", slots: [{ name: "headline", lines: ["짧은 제목"] }] }
  ]);

  /** 요청을 전부 캡처하는 프로바이더. responses는 순서대로 소비한다. */
  function createCapturingProvider(responses: string[]): {
    provider: AiProvider;
    requests: AiStructuredGenerationRequest[];
  } {
    const requests: AiStructuredGenerationRequest[] = [];
    const provider: AiProvider = {
      name: "mock",
      model: "stub",
      async generateStructured(
        request: AiStructuredGenerationRequest
      ): Promise<AiProviderRawResponse> {
        requests.push(request);

        return {
          responseJson: responses[Math.min(requests.length - 1, responses.length - 1)]
        };
      }
    };

    return { provider, requests };
  }

  it("puts today's slide titles and bodies into the card prompt input (AC1)", async () => {
    const { provider, requests } = createCapturingProvider([validResponse]);

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider,
      storyManuscript: manuscript
    });

    expect(requests[0].input.storyManuscript).toEqual(manuscript);
  });

  it("adds the compress-the-manuscript and no-new-facts rules to the instructions (AC2)", async () => {
    const { provider, requests } = createCapturingProvider([validResponse]);

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider,
      storyManuscript: manuscript
    });

    for (const rule of STORY_MANUSCRIPT_CARD_RULES) {
      expect(requests[0].instructions).toContain(rule);
    }

    const candidates = listStoryCardCandidateProjections(createSummary());
    const withRules = buildStoryCardInstructions({
      quiet: true,
      cardCount: 1,
      candidates,
      hasStoryManuscript: true
    });
    const without = buildStoryCardInstructions({
      quiet: true,
      cardCount: 1,
      candidates
    });

    for (const rule of STORY_MANUSCRIPT_CARD_RULES) {
      expect(withRules).toContain(rule);
      expect(without).not.toContain(rule);
    }
  });

  it.each([
    ["omitted", undefined],
    ["empty", []]
  ])(
    "falls back to the summary-only input when the manuscript is %s (AC3)",
    async (_label, storyManuscript) => {
      const { provider, requests } = createCapturingProvider([validResponse]);

      const result = await generateStoryCardPlan({
        activitySummary: createSummary(),
        moodPlan: createMoodPlan(1),
        provider,
        storyManuscript
      });

      expect(result.outcomes[0].status).toBe("accepted");
      expect(requests[0].input).not.toHaveProperty("storyManuscript");

      for (const rule of STORY_MANUSCRIPT_CARD_RULES) {
        expect(requests[0].instructions).not.toContain(rule);
      }

      // 요청 생성이 지시문도 한 번 마스킹하므로, 같은 경로를 거친 기대값과 비교한다.
      expect(requests[0].instructions).toBe(
        createAiGenerationRequest({
          task: "story-card",
          instructions: buildStoryCardInstructions({
            quiet: true,
            cardCount: 1,
            candidates: listStoryCardCandidateProjections(createSummary())
          }),
          summary: requests[0].input
        }).instructions
      );
    }
  );

  it("passes only masked manuscript text — emails, absolute paths and architecture disclosure are redacted (AC4)", async () => {
    const disclosure =
      "Hardened the route guard so only allowlisted admins hit the server-side authorization check.";
    const raw = [
      {
        title: "민감",
        body: `dev@example.com 이 /Users/me/secret/app.ts 를 고쳤다. ${disclosure}`
      }
    ];
    const { provider, requests } = createCapturingProvider([validResponse]);

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider,
      storyManuscript: raw
    });

    const sent = requests[0].input.storyManuscript as {
      title: string;
      body: string;
    }[];

    expect(sent).toHaveLength(1);
    expect(sent[0].body).not.toContain("dev@example.com");
    expect(sent[0].body).not.toContain("/Users/me/secret");
    expect(sent[0].body).not.toContain("route guard");
    expect(sent[0].body).toContain("[redacted-email]");
    expect(sent[0].body).toContain("[redacted-path]");
    expect(sent[0].body).toContain(ARCHITECTURE_DISCLOSURE_REPLACEMENT);
    expect(buildSafeStoryManuscript(raw)).toEqual(sent);
  });

  it("drops slides that are blank after masking, and treats an all-blank manuscript as absent", async () => {
    expect(
      buildSafeStoryManuscript([
        { title: "  ", body: "\n" },
        { title: "정상", body: "본문" }
      ])
    ).toEqual([{ title: "정상", body: "본문" }]);

    const { provider, requests } = createCapturingProvider([validResponse]);

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider,
      storyManuscript: [{ title: " ", body: " " }]
    });

    expect(requests[0].input).not.toHaveProperty("storyManuscript");
    expect(requests[0].instructions).not.toContain(
      STORY_MANUSCRIPT_CARD_RULES[0]
    );
  });

  it("keeps the manuscript and its rules on the retry request", async () => {
    const { provider, requests } = createCapturingProvider([
      cardResponse([
        { type: "typo", slots: [{ name: "headline", lines: ["가".repeat(80)] }] }
      ]),
      validResponse
    ]);

    await generateStoryCardPlan({
      activitySummary: createSummary(),
      moodPlan: createMoodPlan(1),
      provider,
      storyManuscript: manuscript
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].input.storyManuscript).toEqual(manuscript);
    expect(requests[1].input.storyManuscript).toEqual(manuscript);

    for (const rule of STORY_MANUSCRIPT_CARD_RULES) {
      expect(requests[1].instructions).toContain(rule);
    }
  });
});
