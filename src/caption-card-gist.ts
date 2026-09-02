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
 * `source: "fallback"` 카드 중 **고정 문구**(`TYPO_FALLBACK_HEADLINE`)를
 * 실은 장만 요지에서 제외한다 — 실제 활동에서 나온 문구가 아니라
 * "카드가 하나도 없을 때"의 대체 문구이므로, 캡션이 지지 않아도 될 농담을
 * 지고 있다고 착각하게 만들면 안 된다.
 *
 * PR #140 리뷰 반영: 최후의 한 장도 `buildDefaultSlots`를 거치므로 그날의
 * `possibleJokes[0]` / `smallWins[0]`을 헤드라인으로 실을 수 있다. 그런
 * 장까지 싸잡아 버리면 카드엔 그날의 농담이 찍혔는데 캡션은 요지를 못 받아
 * 같은 농담을 되풀이한다 — 이 파일이 없애려던 중복이 그대로 살아난다.
 */
import { redactArchitectureDisclosure } from "./architecture-disclosure.js";
import type { SafeStoryCardGist } from "./ai-provider.js";
import { TYPO_FALLBACK_HEADLINE } from "./story-card-kind-typo.js";
import type { StoryCardPlan, StoryCardPlanCard } from "./story-card-plan.js";
import { readSlotText, type StoryCardSlots } from "./story-card-slots.js";

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

/**
 * 그날의 활동이 아니라 승인된 고정 문구만 실은 최후의 한 장인지 본다.
 * 이런 장은 요지에 실리면 안 된다 — 캡션이 "카드가 이미 농담을 했다"고
 * 믿고 짧은 부연으로 물러서지만, 실제로 카드는 아무 말도 하지 않았다.
 */
function carriesOnlyFixedFallbackText(card: StoryCardPlanCard): boolean {
  return readSlotText(card.slots, "headline").trim() === TYPO_FALLBACK_HEADLINE;
}

export function buildCaptionCardGist(
  plan: StoryCardPlan | undefined
): SafeStoryCardGist[] {
  if (plan === undefined) return [];

  const gist: SafeStoryCardGist[] = [];

  for (const card of plan.cards) {
    if (card.source === "fallback" && carriesOnlyFixedFallbackText(card)) continue;

    const lines = collectSlotLines(card.slots);

    if (lines.length === 0) continue;

    gist.push({ cardType: card.type, lines });
  }

  return gist;
}
