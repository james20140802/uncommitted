/**
 * UNC-229 / T5·T6: 캡션(diary-generator)과 `chat` 카드 슬롯(story-card-generator)이
 * **똑같이** 쓰는 누적 대비(러닝 개그) 지시문. 두 프롬프트가 어긋나지 않도록
 * 문장을 한 곳에서만 소유한다.
 *
 * 표현 계약은 "누적 N번 + 최근 등장일"뿐이다. "연속 N일"·streak은 계약에서
 * 영구 제외이며, 모델이 둘을 섞으면 사실이 틀어지므로 명시적으로 금지한다.
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
