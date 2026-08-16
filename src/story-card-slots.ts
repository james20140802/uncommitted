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

export type StoryCardDefinition = {
  readonly id: string;
  readonly requires: (summary: ActivitySummary) => boolean;
  readonly slots: StoryCardSlotSchema;
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
