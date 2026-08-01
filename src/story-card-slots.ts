import type { ActivitySummary } from "./activity-summary.js";
import type { StoryCardChrome } from "./story-card-chrome.js";

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
