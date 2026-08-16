import type {
  StoryCardCandidate,
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
