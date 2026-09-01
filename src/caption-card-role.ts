/**
 * UNC-236: 카드가 농담을 지는 날에는 캡션이 물러난다.
 *
 * 카드가 하나도 없는 날에는 세 helper 모두 **기존과 문자 단위로 같은**
 * 값을 돌려준다 — 프롬프트가 한 글자도 달라지지 않아야 산출물이 비지
 * 않는다 (AC3). UNC-229의 `buildRecurringThreadInstructionLines`와 같은
 * 규약이다.
 *
 * 카드 문구 자체는 이 파일에 오지 않는다. 문구는 safe payload의
 * `storyCardGist`로 가고, 지시문은 그 필드를 보라고만 말한다.
 */
import type { SafeStoryCardGist } from "./ai-provider.js";

export const CAPTION_LENGTH_WITHOUT_CARDS =
  "4 to 8 short lines. Blank lines are allowed. Add 2 to 5 hashtags (each starting with #).";

export const CAPTION_LENGTH_WITH_CARDS =
  "1 to 2 short sentences. The cards carry the joke today, so the caption stays short. Add 2 to 5 hashtags (each starting with #).";

const SKELETON_WITHOUT_CARDS = [
  "",
  "=== STRUCTURE SKELETON (illustrates rhythm and anchor count only, NOT voice) ===",
  "",
  "Opening beat: one concrete anchor stated plainly (1-2 lines).",
  "(blank line)",
  "Turn: a reaction, consequence, or observation building on that anchor (1-3 lines).",
  "(optional blank line, optional second beat)",
  "Landing line: a short closing thought (1 line).",
  "",
  "2 to 5 hashtags at the end.",
  "",
  "This skeleton shows line rhythm and anchor count ONLY. The actual voice, tone, humor, and emotional register must come from the persona voice lines above and today's mood guidance — never from any fixed example wording.",
];

const SKELETON_WITH_CARDS = [
  "",
  "=== STRUCTURE SKELETON (illustrates length and stance only, NOT voice) ===",
  "",
  "One or two sentences of aside from the coworker who watched it happen.",
  "",
  "2 to 5 hashtags at the end.",
  "",
  "This skeleton shows length and stance ONLY. The actual voice, tone, humor, and emotional register must come from the persona voice lines above and today's mood guidance — never from any fixed example wording."
];

const CARD_ROLE_LINES = [
  "",
  "Story cards are running today (see storyCardGist in the input):",
  "- The cards carry the joke. The caption is the coworker's aside — the thing the cards did not say.",
  "- Do not repeat, rephrase, or explain any line that already appears in storyCardGist. If the caption would say what a card already said, say something else instead.",
  "- Do not describe the cards, refer to them as cards or images, or narrate what the reader is looking at.",
  "- storyCardGist is a record of what has already been said, not a list of new topics. Do not treat it as extra work to cover."
];

function hasCards(gist: SafeStoryCardGist[] | undefined): boolean {
  return gist !== undefined && gist.length > 0;
}

export function buildCaptionLengthLine(
  gist: SafeStoryCardGist[] | undefined
): string {
  return hasCards(gist) ? CAPTION_LENGTH_WITH_CARDS : CAPTION_LENGTH_WITHOUT_CARDS;
}

export function buildCaptionSkeletonLines(
  gist: SafeStoryCardGist[] | undefined
): string[] {
  return hasCards(gist) ? [...SKELETON_WITH_CARDS] : [...SKELETON_WITHOUT_CARDS];
}

export function buildCaptionCardRoleLines(
  gist: SafeStoryCardGist[] | undefined
): string[] {
  return hasCards(gist) ? [...CARD_ROLE_LINES] : [];
}
