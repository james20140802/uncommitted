import type { ActivitySummary } from "./activity-summary.js";
import type { StoryCardChrome } from "./story-card-chrome.js";
import { typoStoryCard } from "./story-card-kind-typo.js";

export type StoryCardSlotType = "text" | "lines";

export type StoryCardSlotSpec = {
  readonly type: StoryCardSlotType;
  readonly required: boolean;
};

export type StoryCardSlotSchema = Readonly<Record<string, StoryCardSlotSpec>>;

export type StoryCardSlots = Readonly<Record<string, string | string[]>>;

export type StoryCardDefinition = {
  readonly id: string;
  readonly requires: (summary: ActivitySummary) => boolean;
  readonly slots: StoryCardSlotSchema;
  readonly render: (slots: StoryCardSlots, chrome: StoryCardChrome) => string;
};

// 등록 지점은 여기 하나뿐이다. 새 카드 종류는 이 배열에 한 줄 추가하면
// 아래의 파생 뷰(열거형 / 슬롯 스키마 / 후보 목록)에 자동으로 반영된다.
export const storyCardRegistry: readonly StoryCardDefinition[] = [typoStoryCard];

export function listStoryCardKindIds(
  registry: readonly StoryCardDefinition[] = storyCardRegistry
): string[] {
  return registry.map((kind) => kind.id);
}

export function getStoryCardSlotSchemas(
  registry: readonly StoryCardDefinition[] = storyCardRegistry
): Record<string, StoryCardSlotSchema> {
  return Object.fromEntries(registry.map((kind) => [kind.id, kind.slots]));
}

export function listStoryCardCandidates(
  summary: ActivitySummary,
  registry: readonly StoryCardDefinition[] = storyCardRegistry
): StoryCardDefinition[] {
  return registry.filter((kind) => kind.requires(summary));
}

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
