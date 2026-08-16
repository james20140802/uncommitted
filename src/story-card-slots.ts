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

/**
 * UNC-263 T5 리뷰 반영: `a ?? b ?? fixed` 형태의 선택은 공백뿐인 문자열을
 * "값 있음"으로 오판해 승인된 고정 문구를 밀어낸다 — `??`는 빈 문자열이
 * nullish가 아니라서 그냥 통과시키기 때문이다. trim해서 실제 내용이 남는
 * 첫 후보를 고른다. 아무것도 없으면 undefined를 돌려주므로 호출부가
 * 자기 `?? 고정문구`로 마저 떨어진다.
 */
export function firstMeaningfulText(
  ...candidates: readonly (string | undefined)[]
): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) return candidate;
  }

  return undefined;
}

/**
 * `list.length > 0 ? list : fixed` 형태의 lines 선택판. 원소가 전부
 * 공백뿐인 배열도 length > 0이라 "내용 있음"으로 오판된다 — 그 결과가
 * fitSlotLines를 통과하며 빈 배열로 졸아들면 required lines 슬롯이
 * 조용히 비어버린다(chat.messages가 실제로 겪은 사례). trim해서 내용이
 * 남는 줄이 하나라도 있는 첫 목록을 고르고, 선택된 목록은 그대로
 * 돌려준다 — 공백 줄 제거 자체는 fitSlotLines의 몫이다.
 */
export function firstMeaningfulLines(
  ...candidateLists: readonly (readonly string[])[]
): string[] {
  for (const candidate of candidateLists) {
    if (candidate.some((line) => line.trim().length > 0)) return [...candidate];
  }

  return [];
}
