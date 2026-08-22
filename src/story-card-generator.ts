import type { ActivitySummary } from "./activity-summary.js";
import {
  AiGenerationError,
  createAiGenerationRequest,
  generateStructuredWithRetry,
  type AiGenerationErrorCode,
  type AiProvider,
  type JsonObject,
  type JsonValue,
  type SafeActivitySummary
} from "./ai-provider.js";
import {
  STORY_CARD_VIOLATIONS,
  validateStoryCardPlanEntries,
  type StoryCardEntryOutcome
} from "./story-card-plan.js";
import { listStoryCardCandidateProjections } from "./story-card-registry.js";
import type { StoryCardCandidate } from "./story-card-slots.js";
import type { MoodPlan } from "./story-format-plan.js";

/**
 * UNC-261 / T3: 슬롯 위반은 사유가 구체적이라 지시문에 되먹이면 대개
 * 한 번의 재시도로 교정된다 (캡션의 CAPTION_MAX_ATTEMPTS와 같은 근거).
 * 더 늘려도 같은 실수를 반복하는 비용만 커지고, 남은 실패는 어차피
 * 종류별 기본값(T4)과 격리(T5)가 받아낸다.
 */
export const STORY_CARD_MAX_ATTEMPTS = 2;

/**
 * UNC-261 T3 리뷰 반영: 재시도 도중 프로바이더 호출 자체가 죽어 생성이
 * 끝난 경우, 그 사실이 사라지지 않게 남긴다 (부모 AC6, 사후 원인 추적).
 * 직렬화 가능해야 T6(진단 아티팩트)·T7(전달)이 그대로 옮겨 쓸 수 있다.
 */
export type StoryCardProviderFailure = {
  readonly message: string;
  readonly code: AiGenerationErrorCode;
};

export type StoryCardGenerationResult = {
  readonly outcomes: StoryCardEntryOutcome[];
  readonly attempts: number;
  readonly rawResponseJson?: string;
  /**
   * 재시도가 소진돼서가 아니라 재시도 호출 자체(네트워크·타임아웃 등)가
   * 실패해서 루프가 끝났을 때만 채운다. 그래도 이미 확보한 outcomes는
   * 그대로 반환한다 — 아래 generateStoryCardPlan의 catch 블록 주석 참고.
   */
  readonly providerFailure?: StoryCardProviderFailure;
};

export type GenerateStoryCardPlanOptions = {
  activitySummary: ActivitySummary;
  moodPlan: MoodPlan;
  provider: AiProvider;
  candidates?: readonly StoryCardCandidate[];
  /**
   * UNC-235 리뷰 반영 (PR #138 Codex): 만들 카드 장수. 렌더는 카드를
   * **실제 슬라이드**에 순서대로 맞추므로(carousel-renderer.ts의
   * planCards[index]), 호출부가 이미 일기를 만들었다면 그 슬라이드 장수를
   * 넘겨야 한다. moodPlan.pacing.suggestedSlideCount는 일기 생성에서도
   * 제안일 뿐이라(3-8장 안이면 다른 수도 유효하다) 두 수가 어긋날 수 있고,
   * 어긋나면 남는 카드가 조용히 버려지거나 뒤쪽 슬라이드가 계획 없이
   * 기본 카드로 떨어진다. 생략하면 종전대로 suggestedSlideCount를 쓴다.
   */
  cardCount?: number;
};

type StoryCardProviderData = JsonObject & { cards?: JsonValue };

function describeCandidate(candidate: StoryCardCandidate): string {
  const slots = Object.entries(candidate.slots).map(([name, spec]) => {
    const parts = [
      `type=${spec.type}`,
      spec.required ? "required" : "optional"
    ];

    if (spec.maxLines !== undefined) parts.push(`maxLines=${spec.maxLines}`);
    if (spec.maxLength !== undefined) parts.push(`maxLength=${spec.maxLength}`);

    return `    - ${name}: ${parts.join(", ")}`;
  });

  return [`  * ${candidate.id}`, ...slots].join("\n");
}

export function buildStoryCardInstructions(options: {
  quiet: boolean;
  cardCount: number;
  candidates: readonly StoryCardCandidate[];
}): string {
  const lines = [
    `Choose exactly ${options.cardCount} cards for today's carousel and fill in their slots.`,
    "",
    "Allowed card types (choose only from this list — any other value is rejected):",
    options.candidates.map(describeCandidate).join("\n"),
    "",
    "Output contract:",
    '- Return {"cards": [{"type": "<one of the ids above>", "slots": [{"name": "<slot name>", "lines": ["..."]}]}]}.',
    "- A slot whose type is `text` takes exactly one line. A slot whose type is `lines` takes up to maxLines lines.",
    "- Every line must stay within that slot's maxLength in characters.",
    "- Fill every required slot. Omit optional slots you have nothing honest to say for.",
    "- Do NOT emit HTML or any markup. Slot values are plain text.",
    "- Do NOT invent a card label, heading number, or caption — labels are added by the code, not by you.",
    "- Do NOT invent commits, bugs, features, or activity that is not in the input summary.",
    "- The same card type may be used more than once if it genuinely fits.",
    options.quiet
      ? "Today is a quiet day. Say so honestly — a quiet day is valid content. Do not manufacture activity to fill the cards."
      : "Anchor each card in the actual activity given in the input summary."
  ];

  return lines.join("\n");
}

export function buildStoryCardRetryInstructions(
  previousInstructions: string,
  error: AiGenerationError
): string {
  const violations = error.details?.violations ?? [];

  return [
    previousInstructions,
    "",
    `The previous response was rejected. Violated conditions: ${violations.join(", ")}.`,
    "Return corrected JSON that satisfies every condition above. Keep the same content intent; fix only the format."
  ].join("\n");
}

const knownViolationCodes = new Set<string>(
  Object.values(STORY_CARD_VIOLATIONS)
);

function isRetryableStoryCardFailure(error: unknown): boolean {
  // 캡션 쪽(isRetryableCaptionFailure)과 같은 판단: 알려진 형식 위반만
  // 재시도한다. 다른 이유로 details를 싣게 될 미래의 에러가 우연히
  // 재시도 대상이 되는 일을 막기 위해 코드 집합으로 구조적으로 본다.
  if (
    !(error instanceof AiGenerationError) ||
    error.code !== "malformed-response"
  ) {
    return false;
  }

  const violations = error.details?.violations;

  if (violations === undefined || violations.length === 0) return false;

  return violations.every((violation) => knownViolationCodes.has(violation));
}

function readRawCards(data: StoryCardProviderData): unknown[] {
  return Array.isArray(data.cards) ? [...data.cards] : [];
}

/**
 * 카드가 한 장도 없는 응답을 나타내는 합성 거부 결과. 실제 카드 엔트리가
 * 없으니 rawType은 null이고, 그래서 조립 단계(T5)는 이걸 degrade 대상으로
 * 찾지 못해 그대로 버린다 — 결과는 기존과 같은 typo 안전망 한 장이다.
 * 달라지는 건 진단이다: 호출부가 이 거부 결과를 보고 실패 진단을 남긴다.
 */
/**
 * 요구한 장수와 응답 장수가 다른 계획을 나타내는 합성 거부 결과.
 * rawType이 null이라 조립 단계(T5)는 degrade 대상으로 잡지 않는다 —
 * 유효하게 검증된 카드는 그대로 살아남고, 이 거부는 호출부의 진단
 * 게이트만 연다. cardIndex는 실제 카드 인덱스와 겹치지 않게 응답
 * 장수(마지막 카드 다음 자리)를 쓴다.
 */
function cardCountMismatchOutcome(
  actual: number,
  expected: number
): StoryCardEntryOutcome {
  return {
    status: "rejected",
    cardIndex: actual,
    rawType: null,
    violations: [
      {
        cardIndex: actual,
        cardType: null,
        slot: null,
        code: STORY_CARD_VIOLATIONS.cardCountMismatch,
        message: `expected ${expected} cards but the response contained ${actual}`
      }
    ]
  };
}

function emptyCardListOutcome(): StoryCardEntryOutcome {
  return {
    status: "rejected",
    cardIndex: 0,
    rawType: null,
    violations: [
      {
        cardIndex: 0,
        cardType: null,
        slot: null,
        code: STORY_CARD_VIOLATIONS.emptyCardList,
        message: "the response contained no cards"
      }
    ]
  };
}

/**
 * buildSafeDiaryInput / buildSafeCaptionInput(diary-generator.ts)과 같은
 * 관례: 카드가 실제로 쓰는 파생 필드만 담는다. SafeActivitySummary가 요구하는
 * 필수 필드(quiet/overview/highlights/projectSummaries)는 채우되, 원시
 * diff·코드·경로·토큰은 절대 넣지 않는다. projectSummaries는 카드 종류의
 * requires()가 참조하지 않지만 타입이 요구하는 필수 필드라 기존 두 함수와
 * 같은 매핑을 그대로 재사용한다.
 */
function buildSafeStoryCardInput(summary: ActivitySummary): SafeActivitySummary {
  const quiet = summary.activityLevel === "none";

  return {
    schemaVersion: 1,
    targetDate: summary.targetDate,
    quiet,
    overview: `${summary.activityLevel} ${summary.dominantTheme} day.`,
    highlights: quiet
      ? ["No recorded Git activity or manual notes today."]
      : [...summary.smallWins, ...summary.unfinishedThreads, ...summary.possibleJokes],
    projectSummaries: summary.projects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      summary: project.summary,
      stats: {
        commits: project.commitCount,
        filesChanged: project.filesChanged,
        insertions: project.insertions,
        deletions: project.deletions,
        dirtyFiles: project.uncommittedChangeCount
      }
    })),
    commitSignals: {
      totalCommits: summary.commitSignals.totalCommits,
      filesChanged: summary.commitSignals.filesChanged,
      subjects: summary.commitSignals.subjects
    },
    smallWins: summary.smallWins,
    blockersOrConfusion: summary.blockersOrConfusion,
    unfinishedThreads: summary.unfinishedThreads,
    possibleJokes: summary.possibleJokes
  };
}

/**
 * 프로바이더를 한 번 부르고, 카드 하나라도 검증에 걸리면 사유를 지시문에
 * 되먹여 다시 부른다. 재시도를 다 써도 남은 위반은 **실패가 아니다** —
 * 부분 결과를 그대로 돌려주고 degrade(T5)와 진단(T6)이 받는다. 카드 실패가
 * 그날 전체 실패로 승격되지 않게 하는 것이 이 이슈의 핵심이다.
 * 프로바이더 호출 자체가 실패한 경우(검증까지 간 응답이 없는 경우)만
 * 위로 던진다 — 그건 카드 실패가 아니라 생성 실패다.
 */
export async function generateStoryCardPlan(
  options: GenerateStoryCardPlanOptions
): Promise<StoryCardGenerationResult> {
  const candidates =
    options.candidates ??
    listStoryCardCandidateProjections(options.activitySummary);
  const cardCount = options.cardCount ?? options.moodPlan.pacing.suggestedSlideCount;
  const request = createAiGenerationRequest({
    task: "story-card",
    instructions: buildStoryCardInstructions({
      quiet: options.activitySummary.activityLevel === "none",
      cardCount,
      candidates
    }),
    summary: buildSafeStoryCardInput(options.activitySummary)
  });

  let lastOutcomes: StoryCardEntryOutcome[] | undefined;
  let lastRawResponseJson: string | undefined;
  let attempts = 0;

  try {
    return await generateStructuredWithRetry<
      StoryCardProviderData,
      StoryCardGenerationResult
    >(options.provider, request, {
      maxAttempts: STORY_CARD_MAX_ATTEMPTS,
      isRetryable: isRetryableStoryCardFailure,
      buildRetryInstructions: buildStoryCardRetryInstructions,
      validate: (data, rawResponseJson) => {
        attempts += 1;

        const rawCards = readRawCards(data);

        // 최종 통합 리뷰 반영: 카드가 한 장도 없는 응답은 위반이 0건이라
        // 그냥 통과해버린다 — 재시도도 안 걸리고 진단도 안 남은 채 조용히
        // typo 한 장으로 떨어진다. 운영자에게는 "바쁜 하루가 생성 카드 한
        // 장으로 끝났는데 이유를 적어둔 파일이 없는" 상태만 남는다(부모
        // AC6가 막으려는 사후 추적 불능). 모델에게 N장을 요구해놓고 0장을
        // 정상으로 취급할 이유도 없으므로, 형식 위반으로 다뤄 재시도를 태운다.
        if (rawCards.length === 0) {
          // 재시도까지 소진되면 catch가 lastOutcomes를 그대로 돌려주므로,
          // 여기서 합성 거부 결과를 남겨야 호출부의 진단 게이트가 열린다.
          lastOutcomes = [emptyCardListOutcome()];
          lastRawResponseJson = rawResponseJson;

          throw new AiGenerationError(
            "Story card plan contained no cards.",
            "malformed-response",
            {
              violations: [STORY_CARD_VIOLATIONS.emptyCardList],
              rawResponseJson
            }
          );
        }

        const outcomes = validateStoryCardPlanEntries(rawCards, candidates);

        // PR #137 리뷰 반영: 지시문은 "exactly N장"을 요구하는데 검증이
        // 장수를 보지 않아, 6장을 요구해도 1장짜리 응답이 재시도·진단 없이
        // 조용히 통과했다. 0장 처리와 같은 근거로 형식 위반으로 다룬다.
        // 재시도가 소진되면 검증을 통과한 카드는 그대로 살아남고(부모 AC4),
        // 장수 위반은 합성 거부 결과로 남아 진단 게이트를 연다(부모 AC6).
        const countMismatch = rawCards.length !== cardCount;

        lastOutcomes = countMismatch
          ? [...outcomes, cardCountMismatchOutcome(rawCards.length, cardCount)]
          : outcomes;
        lastRawResponseJson = rawResponseJson;

        const rejected = outcomes.filter(
          (outcome) => outcome.status === "rejected"
        );

        if (rejected.length > 0 || countMismatch) {
          throw new AiGenerationError(
            "Story card plan violated its output contract.",
            "malformed-response",
            {
              violations: [
                ...rejected.flatMap((outcome) =>
                  outcome.status === "rejected"
                    ? outcome.violations.map((violation) => violation.code)
                    : []
                ),
                ...(countMismatch
                  ? [STORY_CARD_VIOLATIONS.cardCountMismatch]
                  : [])
              ],
              rawResponseJson
            }
          );
        }

        return { outcomes, attempts, rawResponseJson };
      }
    });
  } catch (error) {
    if (lastOutcomes === undefined) throw error;

    // UNC-261 T3 리뷰 반영: "validate가 한 번이라도 돌았는가"는 종료 원인의
    // 대리 지표일 뿐이다. attempt 1이 위반으로 재시도에 들어간 뒤 attempt 2의
    // provider.generateStructured() 자체가 죽어도(네트워크·타임아웃) 여기로
    // 떨어지는데, 그 경우와 "재시도를 다 써서 위반이 남은" 경우를 구분해야
    // 한다. withPriorDiagnostics(ai-provider.ts)가 종료 에러의 message/code는
    // 항상 실제로 끝난 원인의 것으로 유지하므로("provider-failed" 등), 우리
    // validate()가 던진 위반 소진 에러만 "malformed-response" 코드를 갖는다는
    // 사실로 둘을 가른다.
    //
    // 컨트롤러 결정: 어느 쪽이든 이미 확보한 outcomes는 그대로 돌려준다.
    // 재시도 호출이 죽었다고 attempt 1이 만든 정상 카드까지 버리면 하루 전체가
    // fallback으로 넘어가버려, "카드 실패가 하루 실패로 승격되지 않는다"는 이
    // 이슈의 목적과 정반대가 된다. 대신 providerFailure에 종료 원인을 남겨
    // 사후 추적(부모 AC6)이 가능하게 한다.
    const isValidationExhaustion =
      error instanceof AiGenerationError && error.code === "malformed-response";

    return {
      outcomes: lastOutcomes,
      attempts,
      rawResponseJson: lastRawResponseJson,
      ...(!isValidationExhaustion && error instanceof AiGenerationError
        ? { providerFailure: { message: error.message, code: error.code } }
        : {})
    };
  }
}
