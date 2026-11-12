/**
 * UNC-229 / T5·T6: 캡션(diary-generator)과 `chat` 카드 슬롯(story-card-generator)이
 * **똑같이** 쓰는 누적 대비(러닝 개그) 지시문. 두 프롬프트가 어긋나지 않도록
 * 문장을 한 곳에서만 소유한다.
 *
 * 표현 계약은 "누적 N번 + 최근 등장일"뿐이다. "연속 N일"·streak은 계약에서
 * 영구 제외이며, 모델이 둘을 섞으면 사실이 틀어지므로 명시적으로 금지한다.
 *
 * UNC-309: 카드 슬롯에서는 모델이 누적 횟수·날짜를 "4번째 기록, 마지막 확인
 * 2026-10-24" 같은 데이터 라벨로 그대로 베껴 쓰는 문제가 있어, 카드 전용 문장
 * (`RECURRING_THREAD_CARD_INSTRUCTIONS`)을 따로 둔다. 캡션 프롬프트에는 붙이지 않는다.
 */
import type { SafeRecurringThread } from "./ai-provider.js";

export const RECURRING_THREAD_INSTRUCTIONS = {
  header: "Recurring threads (from recurringThreads in the input):",
  useCumulative:
    "- Work the cumulative count into the writing: say which time around this is and when it was last seen, using only the occurrenceCount and lastSeenDate values given in recurringThreads.",
  noInventedCount:
    "- Do not estimate, round up, or invent the count. Use only the occurrenceCount value given. If you are unsure, do not mention a number at all.",
  noStreak:
    "- Do not claim consecutive days or an unbroken streak. The input carries a cumulative count and a last-seen date only — never phrase it as 'N days in a row'.",
  notNewMaterial:
    "- Items in recurringThreads describe work you may already be covering under a different anchor — treat them as a pointer to old material, not a new topic. Do not treat a recurring item as an additional topic, and do not cover the same item twice."
} as const;

/**
 * 반복 스레드가 있는 날에만 지시문 줄을 만든다. 없으면 **빈 배열** —
 * 호출부가 그대로 이어붙여도 프롬프트가 한 글자도 달라지지 않는다 (AC2).
 */
export function buildRecurringThreadInstructionLines(
  recurringThreads: SafeRecurringThread[] | undefined
): string[] {
  if (recurringThreads === undefined || recurringThreads.length === 0) {
    return [];
  }

  return [
    "",
    RECURRING_THREAD_INSTRUCTIONS.header,
    RECURRING_THREAD_INSTRUCTIONS.useCumulative,
    RECURRING_THREAD_INSTRUCTIONS.noInventedCount,
    RECURRING_THREAD_INSTRUCTIONS.noStreak,
    RECURRING_THREAD_INSTRUCTIONS.notNewMaterial
  ];
}

/** UNC-309: 카드 프롬프트에만 붙는 문장. 캡션 프롬프트는 이 문장을 쓰지 않는다. */
export const RECURRING_THREAD_CARD_INSTRUCTIONS = {
  noDataFormat:
    "- On cards, this overrides the instruction above about when it was last seen: never write the count or date as a data label — no '4번째 기록', no '마지막 확인 2026-10-24', no 'N번째 기록 · 마지막 확인 YYYY-MM-DD' tails, and never write a YYYY-MM-DD date. If the repetition matters, fold it into the sentence as natural Korean without a number or time phrase you were not given (e.g. '또 이 정리를 했다', '이번에도')."
} as const;

/** 카드용: 공통 지시문 뒤에 데이터 형식 금지 한 줄을 덧붙인다. 스레드가 없으면 `[]`. */
export function buildRecurringThreadCardInstructionLines(
  recurringThreads: SafeRecurringThread[] | undefined
): string[] {
  const shared = buildRecurringThreadInstructionLines(recurringThreads);

  if (shared.length === 0) {
    return [];
  }

  return [...shared, RECURRING_THREAD_CARD_INSTRUCTIONS.noDataFormat];
}
