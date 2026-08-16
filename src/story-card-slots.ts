import type { ActivitySummary } from "./activity-summary.js";
import type { StoryCardChrome } from "./story-card-chrome.js";

export type StoryCardSlotType = "text" | "lines";

export type StoryCardSlotSpec = {
  readonly type: StoryCardSlotType;
  readonly required: boolean;
  /**
   * `lines` 슬롯이 허용하는 최대 줄 수. `text` 슬롯에는 의미가 없다.
   * 선언하지 않으면 줄 수를 제한하지 않는다 — 기존 슬롯 정의가 그대로
   * 살아 있도록 optional로 둔다.
   */
  readonly maxLines?: number;
  /**
   * `text` 슬롯은 전체 길이, `lines` 슬롯은 **줄 하나의** 길이 상한.
   * 선언하지 않으면 길이를 제한하지 않는다.
   */
  readonly maxLength?: number;
};

export type StoryCardSlotSchema = Readonly<Record<string, StoryCardSlotSpec>>;

export type StoryCardSlots = Readonly<Record<string, string | string[]>>;

/**
 * UNC-262 / T4: 규칙 기반 기본 슬롯 생성기가 받는 컨텍스트.
 * 재료는 **이미 파생된** 요약 필드뿐이다 — 이 경로는 새 활동 파생을
 * 도입하지 않으며, 없는 활동을 지어내지도 않는다.
 */
export type StoryCardDefaultContext = {
  readonly summary: ActivitySummary;
};

export type StoryCardDefinition = {
  readonly id: string;
  readonly requires: (summary: ActivitySummary) => boolean;
  readonly slots: StoryCardSlotSchema;
  /**
   * LLM 슬롯이 끝내 검증을 통과하지 못했을 때 이 종류를 살려내는
   * 결정론적 기본값. 반드시 자기 종류의 slots 제약을 만족해야 한다 —
   * 그렇지 않으면 degrade 경로 자체가 무력해진다.
   */
  readonly buildDefaultSlots: (context: StoryCardDefaultContext) => StoryCardSlots;
  readonly render: (slots: StoryCardSlots, chrome: StoryCardChrome) => string;
};

// 후보 목록을 LLM 프롬프트·검증에 넘기기 위한 직렬화 가능한 투영.
// render / requires 함수를 빼고 id와 슬롯 스키마만 남긴다.
export type StoryCardCandidate = {
  readonly id: string;
  readonly slots: StoryCardSlotSchema;
};

export function readSlotText(slots: StoryCardSlots, name: string): string {
  const value = slots[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(" ");
  return "";
}

export function readSlotLines(slots: StoryCardSlots, name: string): string[] {
  const value = slots[name];
  if (Array.isArray(value)) return value.filter((line) => line.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return [];
}

/**
 * 기본값이 제 종류의 제약을 넘지 않도록 자르는 공용 헬퍼.
 * 자를 때는 말줄임표를 붙이지 않는다 — 붙이면 그 자체가 길이에 포함돼
 * 다시 한계를 넘길 수 있고, 카드 문구는 짧게 잘려도 정직하다.
 */
export function fitSlotText(value: string, spec: StoryCardSlotSpec): string {
  const trimmed = value.trim().replace(/\s+/g, " ");

  if (spec.maxLength === undefined) return trimmed;

  return trimmed.slice(0, spec.maxLength);
}

export function fitSlotLines(
  values: readonly string[],
  spec: StoryCardSlotSpec
): string[] {
  const cleaned = values
    .map((value) => fitSlotText(value, spec))
    .filter((value) => value.length > 0);

  if (spec.maxLines === undefined) return cleaned;

  return cleaned.slice(0, spec.maxLines);
}
