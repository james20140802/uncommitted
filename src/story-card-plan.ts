import type { ActivitySummary } from "./activity-summary.js";
import { TYPO_FALLBACK_HEADLINE } from "./story-card-kind-typo.js";
import { storyCardRegistry } from "./story-card-registry.js";
import type {
  StoryCardCandidate,
  StoryCardDefinition,
  StoryCardSlotSpec,
  StoryCardSlots
} from "./story-card-slots.js";

/**
 * UNC-260 / T2: 카드 계획 검증. 캡션 쪽 CAPTION_FORMAT_VIOLATIONS와 같은
 * 방식으로 위반을 **문자열 코드**로 표현한다 — 재시도 지시문(T3)과 실패
 * 진단(T6)이 같은 어휘를 그대로 실어 나르게 하기 위해서다.
 *
 * 이 모듈은 프로바이더도 파일시스템도 건드리지 않는 순수 함수만 담는다.
 * 덕분에 AC1/AC2 단위 테스트가 AI provider를 스텁하지 않고 돈다.
 */
export const STORY_CARD_VIOLATIONS = {
  emptyCardList: "card-empty-plan",
  cardCountMismatch: "card-count-mismatch",
  malformedEntry: "card-malformed-entry",
  unknownCardType: "card-unknown-type",
  unknownSlotKey: "card-unknown-slot-key",
  missingRequiredSlot: "card-missing-required-slot",
  emptySlot: "card-empty-slot",
  slotTypeMismatch: "card-slot-type-mismatch",
  tooManyLines: "card-too-many-lines",
  lineTooLong: "card-line-too-long",
  textTooLong: "card-text-too-long"
} as const;

export type StoryCardViolationCode =
  (typeof STORY_CARD_VIOLATIONS)[keyof typeof STORY_CARD_VIOLATIONS];

export type StoryCardViolation = {
  readonly cardIndex: number;
  readonly cardType: string | null;
  readonly slot: string | null;
  readonly code: StoryCardViolationCode;
  readonly message: string;
};

export type StoryCardPlanEntry = {
  readonly type: string;
  readonly slots: StoryCardSlots;
};

export type StoryCardEntryOutcome =
  | {
      readonly status: "accepted";
      readonly cardIndex: number;
      readonly entry: StoryCardPlanEntry;
    }
  | {
      readonly status: "rejected";
      readonly cardIndex: number;
      readonly rawType: string | null;
      readonly violations: readonly StoryCardViolation[];
    };

type RawSlotEntry = { name: string; lines: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRawSlots(value: unknown): RawSlotEntry[] | null {
  if (!Array.isArray(value)) return null;

  const parsed: RawSlotEntry[] = [];

  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.name !== "string") return null;
    if (!Array.isArray(item.lines)) return null;
    if (!item.lines.every((line): line is string => typeof line === "string")) {
      return null;
    }

    parsed.push({ name: item.name, lines: [...item.lines] });
  }

  return parsed;
}

function violation(
  cardIndex: number,
  cardType: string | null,
  slot: string | null,
  code: StoryCardViolationCode,
  message: string
): StoryCardViolation {
  return { cardIndex, cardType, slot, code, message };
}

function validateSlot(
  cardIndex: number,
  cardType: string,
  slotName: string,
  spec: StoryCardSlotSpec,
  lines: string[]
): { violations: StoryCardViolation[]; value?: string | string[] } {
  const violations: StoryCardViolation[] = [];
  const meaningful = lines.filter((line) => line.trim().length > 0);

  if (meaningful.length === 0) {
    if (spec.required) {
      violations.push(
        violation(
          cardIndex,
          cardType,
          slotName,
          STORY_CARD_VIOLATIONS.emptySlot,
          `card ${cardIndex} slot "${slotName}" of kind "${cardType}" is required but empty`
        )
      );
    }

    return { violations };
  }

  if (spec.type === "text") {
    if (meaningful.length > 1) {
      violations.push(
        violation(
          cardIndex,
          cardType,
          slotName,
          STORY_CARD_VIOLATIONS.slotTypeMismatch,
          `card ${cardIndex} slot "${slotName}" of kind "${cardType}" is a single-line text slot but got ${meaningful.length} lines`
        )
      );

      return { violations };
    }

    const text = meaningful[0].trim();

    if (spec.maxLength !== undefined && text.length > spec.maxLength) {
      violations.push(
        violation(
          cardIndex,
          cardType,
          slotName,
          STORY_CARD_VIOLATIONS.textTooLong,
          `card ${cardIndex} slot "${slotName}" of kind "${cardType}" is ${text.length} characters but the limit is ${spec.maxLength}`
        )
      );

      return { violations };
    }

    return { violations, value: text };
  }

  const trimmed = meaningful.map((line) => line.trim());

  if (spec.maxLines !== undefined && trimmed.length > spec.maxLines) {
    violations.push(
      violation(
        cardIndex,
        cardType,
        slotName,
        STORY_CARD_VIOLATIONS.tooManyLines,
        `card ${cardIndex} slot "${slotName}" of kind "${cardType}" has ${trimmed.length} lines but the limit is ${spec.maxLines}`
      )
    );
  }

  if (spec.maxLength !== undefined) {
    for (const line of trimmed) {
      if (line.length > spec.maxLength) {
        violations.push(
          violation(
            cardIndex,
            cardType,
            slotName,
            STORY_CARD_VIOLATIONS.lineTooLong,
            `card ${cardIndex} slot "${slotName}" of kind "${cardType}" has a ${line.length}-character line but the per-line limit is ${spec.maxLength}`
          )
        );
        break;
      }
    }
  }

  if (violations.length > 0) return { violations };

  return { violations, value: trimmed };
}

function validateEntry(
  raw: unknown,
  cardIndex: number,
  candidates: readonly StoryCardCandidate[]
): StoryCardEntryOutcome {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return {
      status: "rejected",
      cardIndex,
      rawType: null,
      violations: [
        violation(
          cardIndex,
          null,
          null,
          STORY_CARD_VIOLATIONS.malformedEntry,
          `card ${cardIndex} is not an object with a string "type"`
        )
      ]
    };
  }

  const cardType = raw.type;
  const candidate = candidates.find((entry) => entry.id === cardType);

  if (candidate === undefined) {
    // 소속 검사는 레지스트리 전체가 아니라 **그날의 필터링된 후보** 기준이다.
    // 그날 requires()가 false인 종류는 존재하지 않는 id와 똑같이 거부된다.
    return {
      status: "rejected",
      cardIndex,
      rawType: cardType,
      violations: [
        violation(
          cardIndex,
          cardType,
          null,
          STORY_CARD_VIOLATIONS.unknownCardType,
          `card ${cardIndex} uses type "${cardType}" which is not among today's candidates (${candidates
            .map((entry) => entry.id)
            .join(", ")})`
        )
      ]
    };
  }

  const rawSlots = readRawSlots(raw.slots);

  if (rawSlots === null) {
    return {
      status: "rejected",
      cardIndex,
      rawType: cardType,
      violations: [
        violation(
          cardIndex,
          cardType,
          null,
          STORY_CARD_VIOLATIONS.malformedEntry,
          `card ${cardIndex} slots must be an array of { name, lines[] } entries`
        )
      ]
    };
  }

  const violations: StoryCardViolation[] = [];
  const slots: Record<string, string | string[]> = {};

  for (const rawSlot of rawSlots) {
    const spec = candidate.slots[rawSlot.name];

    if (spec === undefined) {
      violations.push(
        violation(
          cardIndex,
          cardType,
          rawSlot.name,
          STORY_CARD_VIOLATIONS.unknownSlotKey,
          `card ${cardIndex} uses slot "${rawSlot.name}" which kind "${cardType}" does not declare`
        )
      );
      continue;
    }

    const result = validateSlot(
      cardIndex,
      cardType,
      rawSlot.name,
      spec,
      rawSlot.lines
    );

    violations.push(...result.violations);

    if (result.value !== undefined) {
      slots[rawSlot.name] = result.value;
    }
  }

  for (const [slotName, spec] of Object.entries(candidate.slots)) {
    if (!spec.required) continue;
    if (slots[slotName] !== undefined) continue;
    if (violations.some((entry) => entry.slot === slotName)) continue;

    violations.push(
      violation(
        cardIndex,
        cardType,
        slotName,
        STORY_CARD_VIOLATIONS.missingRequiredSlot,
        `card ${cardIndex} of kind "${cardType}" is missing required slot "${slotName}"`
      )
    );
  }

  if (violations.length > 0) {
    return { status: "rejected", cardIndex, rawType: cardType, violations };
  }

  return { status: "accepted", cardIndex, entry: { type: cardType, slots } };
}

/**
 * 각 카드를 **독립적으로** 판정한다. 한 장이 거부돼도 형제 카드의 판정에
 * 영향을 주지 않는다 — 장 단위 격리(T5)가 이 per-entry 결과 위에서 돈다.
 */
export function validateStoryCardPlanEntries(
  rawEntries: readonly unknown[],
  candidates: readonly StoryCardCandidate[]
): StoryCardEntryOutcome[] {
  return rawEntries.map((raw, index) => validateEntry(raw, index, candidates));
}

export type StoryCardPlanCardSource = "generated" | "degraded" | "fallback";

export type StoryCardPlanCard = {
  readonly type: string;
  readonly slots: StoryCardSlots;
  readonly source: StoryCardPlanCardSource;
};

export type StoryCardPlan = {
  readonly schemaVersion: 1;
  readonly cards: readonly StoryCardPlanCard[];
};

const FALLBACK_CARD_TYPE = "typo";

function toWireSlots(slots: StoryCardSlots): unknown[] {
  return Object.entries(slots).map(([name, value]) => ({
    name,
    lines: Array.isArray(value) ? value : [value]
  }));
}

/**
 * 기본값도 자기 종류의 제약을 만족하는지 **같은 검증기로** 다시 본다.
 * 기본값을 신뢰해서 그냥 통과시키면, 제약을 어기는 기본값이 조용히
 * 카드로 나가 degrade 경로가 있으나 마나 해진다.
 *
 * UNC-263 T5 리뷰 반영 (finding 2): buildDefaultSlots는 오늘의 요약
 * 데이터로 계산하는 코드다 — 통상 순수 문자열 조작이라 던지지 않지만,
 * "카드 하나의 실패가 계획 전체를 죽여서는 안 된다"는 이 태스크의 목적을
 * 코드로도 지키려면 이 호출 자체를 무방비로 두면 안 된다. 던지면 그 카드만
 * 버린다 — 재검증에 실패했을 때와 같은 취급이다.
 */
function degradeToDefaults(
  definition: StoryCardDefinition,
  summary: ActivitySummary
): StoryCardSlots | null {
  try {
    const slots = definition.buildDefaultSlots({ summary });
    const outcomes = validateStoryCardPlanEntries(
      [{ type: definition.id, slots: toWireSlots(slots) }],
      [{ id: definition.id, slots: definition.slots }]
    );
    const outcome = outcomes[0];

    return outcome?.status === "accepted" ? outcome.entry.slots : null;
  } catch {
    return null;
  }
}

/**
 * UNC-263 / T5: 카드마다 독립적으로 처리한다. 한 장이 끝내 실패해도
 * 형제 카드로 번지지 않고, 그 카드만 자기 종류의 결정론적 기본값으로
 * 대체되거나 계획에서 빠진다. 전부 빠져도 typo 1장으로 계획을 완성한다 —
 * typo의 requires()가 무조건 참이라 어떤 날에도 유효한 최종 fallback이다.
 *
 * 카드 실패가 그날 전체 실패로 승격되어서는 안 된다. 2026-07-26 exit 4
 * (그날 드래프트가 activity-summary.json만 남은 채 끝남)에 대한 구조적 답이다.
 */
export function assembleStoryCardPlan(options: {
  outcomes: readonly StoryCardEntryOutcome[];
  summary: ActivitySummary;
  registry?: readonly StoryCardDefinition[];
}): StoryCardPlan {
  const registry = options.registry ?? storyCardRegistry;
  const cards: StoryCardPlanCard[] = [];

  for (const outcome of options.outcomes) {
    if (outcome.status === "accepted") {
      cards.push({
        type: outcome.entry.type,
        slots: outcome.entry.slots,
        source: "generated"
      });
      continue;
    }

    // UNC-263 T5 리뷰 반영 (finding 4): 레지스트리 전체가 아니라 오늘의
    // 후보(requires(summary) === true)에서만 degrade 대상을 찾는다. T2가
    // "오늘의 후보가 아니다"라는 이유로 이미 거부한 카드를, 그 이유를
    // 무시하고 되살리면 안 된다 — 없는 활동을 지어내지 않는다는 원칙과도
    // 맞닿아 있다.
    const definition = registry.find(
      (kind) => kind.id === outcome.rawType && kind.requires(options.summary)
    );

    if (definition === undefined) continue;

    const slots = degradeToDefaults(definition, options.summary);

    if (slots === null) continue;

    cards.push({ type: definition.id, slots, source: "degraded" });
  }

  if (cards.length > 0) return { schemaVersion: 1, cards };

  const fallbackDefinition = registry.find((kind) => kind.id === FALLBACK_CARD_TYPE);

  if (fallbackDefinition === undefined) return { schemaVersion: 1, cards: [] };

  // UNC-263 T5 리뷰 반영 (finding 1b): 최후의 한 장도 다른 degrade 카드와
  // 똑같이 재검증을 거친다 — fallback이라고 봐주지 않는다.
  const fallbackSlots = degradeToDefaults(fallbackDefinition, options.summary);

  if (fallbackSlots !== null) {
    return {
      schemaVersion: 1,
      cards: [{ type: fallbackDefinition.id, slots: fallbackSlots, source: "fallback" }]
    };
  }

  // UNC-263 T5 리뷰 반영 (finding 1c): typo의 기본값 생성마저 재검증에
  // 실패하면, 승인된 고정 문구로 카드를 직접 만든다. buildDefaultSlots를
  // 다시 부르지 않는다 — 실패할 수 있는 코드에 기대지 않는 게 이 바닥의
  // 조건이다. 부모 AC5가 요구하는 "그날의 최후의 한 장"은 여기서 끝난다.
  return {
    schemaVersion: 1,
    cards: [
      {
        type: FALLBACK_CARD_TYPE,
        slots: { headline: TYPO_FALLBACK_HEADLINE },
        source: "fallback"
      }
    ]
  };
}
