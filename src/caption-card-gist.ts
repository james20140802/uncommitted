/**
 * UNC-236: 그날 카드에 이미 찍힌 문구를 캡션 입력용 요지로 옮긴다.
 *
 * 호출 시점 계약: 이 함수가 받는 계획은 `checkStoryCardPlanSafety` →
 * `revalidateStoryCardPlan` → `rescanStoryCardPlanAfterRevalidation`을
 * 통과한 **마스킹된** 계획이어야 한다. 아키텍처 폭로 redaction은 이미
 * `checkStoryCardPlanSafety` → `checkDraftSafety` 경로에서 모든 슬롯에
 * 적용된다 — 여기서 다시 거는 것은 그 위에 얹는 defense in depth이자
 * 중복 패스다 (idempotent하므로 다시 걸어도 무해하다).
 *
 * `source: "fallback"` 카드(예: 고정 헤드라인 typo 카드)는 요지에서
 * 제외한다 — 실제 활동에서 나온 문구가 아니라 "카드가 하나도 없을 때"의
 * 대체 문구이므로, 캡션이 지지 않아도 될 농담을 지고 있다고 착각하게
 * 만들면 안 된다.
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
    if (card.source === "fallback") continue;

    const lines = collectSlotLines(card.slots);

    if (lines.length === 0) continue;

    gist.push({ cardType: card.type, lines });
  }

  return gist;
}
