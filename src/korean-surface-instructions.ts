/**
 * UNC-286: 스토리·캡션·카드 프롬프트가 **똑같이** 쓰는 한국어 표면 규칙
 * (UNC-250에서 diary-generator에 있던 KOREAN_SURFACE_LINES를 옮겼다).
 * 표면과 무관한 규칙 문장은 한 곳에서만 소유하고, 프롬프트마다 다른 것은
 * "어느 표면을 한국어로 쓰는가"를 지정하는 첫 문장뿐이다.
 * story/caption은 옮기기 전과 바이트 단위로 같은 문장을 낸다.
 *
 * 내부 식별자 처리는
 * docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md
 * 에서 결정한 (a) 전면 마스킹을 따른다 — 마스킹 placeholder를 찍는 게 아니라
 * 보편 상황 서술로 바꾸는 것이다.
 */
import type { PersonaLangMix } from "./persona.js";

export type KoreanSurfaceTarget = "story" | "caption" | "card";

export const KOREAN_SURFACE_RULES = {
  translatableNounPhrases:
    "Any English noun phrase that has a natural Korean equivalent must be written in Korean instead — for example \"working tree\", \"fire-and-forget\", \"boundary tape\", \"release-shaped moment\" should be expressed as Korean, not printed in English.",
  exceptions:
    "Exceptions: hashtag tokens (anything starting with #) may stay in English, and widely used abbreviations may stay as-is: CI, PR, API, UI, AI, JSON, URL — the abbreviation only, never a specific number or key attached to it. Public tool, language, and platform names such as Git, TypeScript, or Instagram are also allowed. The persona's Korean-English mix setting governs how freely these allowed English tokens appear; it never licenses untranslated internal or translatable noun phrases.",
  internalIdentifiers:
    "Internal identifiers must never appear: ticket keys such as UNC-123, internal screen, module, class, or file names such as FeedbackModal or diary-generator.ts, and proper nouns that appear only in internal branch names or PR titles. Reframe them as the universal situation they describe instead of masking them with placeholder text."
} as const;

const STORY_SURFACE_TARGET =
  "Write the reader-facing surface — story title, slide titles, slide bodies, altText, and caption — in Korean.";

const SURFACE_TARGETS: Record<KoreanSurfaceTarget, string> = {
  story: STORY_SURFACE_TARGET,
  caption: STORY_SURFACE_TARGET,
  card: "Write the reader-facing card slots — typo headline and kicker, checkboard heading, done, and todo, modal title, body, primaryAction, and secondaryAction, and chat messages — in Korean."
};

const CARD_TECHNICAL_SURFACE_EXCEPTION =
  "Technical-surface slots that imitate a real tool screen — terminal prompt, command, and output, and diff filename, added, and removed — are exempt from the Korean-language and noun-phrase translation rules above; keep writing them the way a real terminal or diff would show them. The internal-identifier rule still applies to them.";

export function buildKoreanSurfaceLines(target: KoreanSurfaceTarget): string[] {
  const lines = [
    `${SURFACE_TARGETS[target]} ${KOREAN_SURFACE_RULES.translatableNounPhrases}`,
    KOREAN_SURFACE_RULES.exceptions,
    KOREAN_SURFACE_RULES.internalIdentifiers
  ];

  return target === "card" ? [...lines, CARD_TECHNICAL_SURFACE_EXCEPTION] : lines;
}

export function buildKoreanEnglishMixLine(mix: PersonaLangMix): string {
  return `The persona's Korean-English mix setting is "${mix}"; let it govern how freely the allowed English tokens above appear, within the limits stated there.`;
}
