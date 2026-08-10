import type { ActivitySummary } from "./activity-summary.js";
import { chatStoryCard } from "./story-card-kind-chat.js";
import { checkboardStoryCard } from "./story-card-kind-checkboard.js";
import { diffStoryCard } from "./story-card-kind-diff.js";
import { modalStoryCard } from "./story-card-kind-modal.js";
import { terminalStoryCard } from "./story-card-kind-terminal.js";
import { typoStoryCard } from "./story-card-kind-typo.js";
import type {
  StoryCardCandidate,
  StoryCardDefinition,
  StoryCardSlotSchema
} from "./story-card-slots.js";

export type {
  StoryCardSlotType,
  StoryCardSlotSpec,
  StoryCardSlotSchema,
  StoryCardSlots,
  StoryCardDefinition,
  StoryCardCandidate
} from "./story-card-slots.js";
export { readSlotText, readSlotLines } from "./story-card-slots.js";

// 등록 지점은 여기 하나뿐이다. 새 카드 종류는 이 배열에 한 줄 추가하면
// 아래의 파생 뷰(열거형 / 슬롯 스키마 / 후보 목록)에 자동으로 반영된다.
export const storyCardRegistry: readonly StoryCardDefinition[] = [
  typoStoryCard,
  terminalStoryCard,
  modalStoryCard,
  checkboardStoryCard,
  chatStoryCard,
  diffStoryCard
];

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

// 후보를 LLM 프롬프트·검증으로 넘기기 위한 직렬화 가능한 투영.
// listStoryCardCandidates가 반환하는 정의에는 render 클로저가 붙어 있어
// JSON.stringify가 조용히 지워버린다. 여기서 id와 슬롯 스키마만 남긴다.
export function listStoryCardCandidateProjections(
  summary: ActivitySummary,
  registry: readonly StoryCardDefinition[] = storyCardRegistry
): StoryCardCandidate[] {
  return listStoryCardCandidates(summary, registry).map((kind) => ({
    id: kind.id,
    slots: kind.slots
  }));
}
