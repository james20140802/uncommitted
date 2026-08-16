import type { ActivitySummary } from "./activity-summary.js";
import {
  AiGenerationError,
  createAiGenerationRequest,
  generateStructuredWithRetry,
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

export type StoryCardGenerationResult = {
  readonly outcomes: StoryCardEntryOutcome[];
  readonly attempts: number;
  readonly rawResponseJson?: string;
};

export type GenerateStoryCardPlanOptions = {
  activitySummary: ActivitySummary;
  moodPlan: MoodPlan;
  provider: AiProvider;
  candidates?: readonly StoryCardCandidate[];
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
  const cardCount = options.moodPlan.pacing.suggestedSlideCount;
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

        const outcomes = validateStoryCardPlanEntries(
          readRawCards(data),
          candidates
        );

        lastOutcomes = outcomes;
        lastRawResponseJson = rawResponseJson;

        const rejected = outcomes.filter(
          (outcome) => outcome.status === "rejected"
        );

        if (rejected.length > 0) {
          throw new AiGenerationError(
            "Story card plan violated slot constraints.",
            "malformed-response",
            {
              violations: rejected.flatMap((outcome) =>
                outcome.status === "rejected"
                  ? outcome.violations.map((violation) => violation.code)
                  : []
              ),
              rawResponseJson
            }
          );
        }

        return { outcomes, attempts, rawResponseJson };
      }
    });
  } catch (error) {
    if (lastOutcomes === undefined) throw error;

    return {
      outcomes: lastOutcomes,
      attempts,
      rawResponseJson: lastRawResponseJson
    };
  }
}
