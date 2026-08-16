import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import type {
  AiProvider,
  AiProviderRawResponse,
  AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import type { MoodPlan } from "../src/story-format-plan.js";
import { listStoryCardCandidateProjections } from "../src/story-card-registry.js";
import { STORY_CARD_VIOLATIONS } from "../src/story-card-plan.js";
import {
  STORY_CARD_MAX_ATTEMPTS,
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
      moodPlan: createMoodPlan(),
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
      moodPlan: createMoodPlan(),
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
      moodPlan: createMoodPlan(),
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
      moodPlan: createMoodPlan(),
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
      moodPlan: createMoodPlan(),
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
      moodPlan: createMoodPlan(),
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
      moodPlan: createMoodPlan(),
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
