/**
 * UNC-236: 그날 카드에 이미 찍힌 문구를 캡션 입력용 요지로 옮긴다.
 *
 * 호출 시점 계약: 이 함수가 받는 계획은 `checkStoryCardPlanSafety` →
 * `revalidateStoryCardPlan` → `rescanStoryCardPlanAfterRevalidation`을
 * 통과한 **마스킹된** 계획이어야 한다. 다만 아키텍처 폭로 redaction은
 * 캡션 생성 **뒤에** 초안 전체에 적용되므로, 그 몫은 여기서 직접 진다.
 */
import { redactArchitectureDisclosure } from "./architecture-disclosure.js";
import type { SafeStoryCardGist } from "./ai-provider.js";
import type { StoryCardPlan } from "./story-card-plan.js";
import type { StoryCardSlots } from "./story-card-slots.js";

function collectSlotLines(slots: StoryCardSlots): string[] {
  const lines: string[] = [];

  for (const value of Object.values(slots)) {
    const candidates = Array.isArray(value) ? value : [value];

    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;

      const redacted = redactArchitectureDisclosure(candidate).value.trim();

      if (redacted.length > 0) lines.push(redacted);
    }
  }

  return lines;
}

export function buildCaptionCardGist(
  plan: StoryCardPlan | undefined
): SafeStoryCardGist[] {
  if (plan === undefined) return [];

  const gist: SafeStoryCardGist[] = [];

  for (const card of plan.cards) {
    const lines = collectSlotLines(card.slots);

    if (lines.length === 0) continue;

    gist.push({ cardType: card.type, lines });
  }

  return gist;
}
