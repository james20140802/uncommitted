import { describe, expect, it } from "vitest";
import {
  KOREAN_SURFACE_RULES,
  buildKoreanEnglishMixLine,
  buildKoreanSurfaceLines
} from "../src/korean-surface-instructions.js";

describe("korean surface instructions (UNC-286)", () => {
  it("keeps the story/caption surface lines byte-identical to the pre-UNC-286 prompt", () => {
    const expected = [
      "Write the reader-facing surface — story title, slide titles, slide bodies, altText, and caption — in Korean. Any English noun phrase that has a natural Korean equivalent must be written in Korean instead — for example \"working tree\", \"fire-and-forget\", \"boundary tape\", \"release-shaped moment\" should be expressed as Korean, not printed in English.",
      "Exceptions: hashtag tokens (anything starting with #) may stay in English, and widely used abbreviations may stay as-is: CI, PR, API, UI, AI, JSON, URL — the abbreviation only, never a specific number or key attached to it. Public tool, language, and platform names such as Git, TypeScript, or Instagram are also allowed. The persona's Korean-English mix setting governs how freely these allowed English tokens appear; it never licenses untranslated internal or translatable noun phrases.",
      "Internal identifiers must never appear: ticket keys such as UNC-123, internal screen, module, class, or file names such as FeedbackModal or diary-generator.ts, and proper nouns that appear only in internal branch names or PR titles. Reframe them as the universal situation they describe instead of masking them with placeholder text."
    ];

    expect(buildKoreanSurfaceLines("story")).toEqual(expected);
    expect(buildKoreanSurfaceLines("caption")).toEqual(expected);
  });

  it("gives the card prompt the same shared rule sentences with a card-slot target", () => {
    const card = buildKoreanSurfaceLines("card").join("\n");

    expect(card).toContain(KOREAN_SURFACE_RULES.translatableNounPhrases);
    expect(card).toContain(KOREAN_SURFACE_RULES.exceptions);
    expect(card).toContain(KOREAN_SURFACE_RULES.internalIdentifiers);
    for (const slot of ["headline", "kicker", "heading", "done", "todo", "title", "body", "primaryAction", "secondaryAction", "messages"]) {
      expect(card).toContain(slot);
    }
    expect(card).not.toContain("story title, slide titles");
  });

  it("names terminal and diff slots only as technical-surface exceptions", () => {
    const lines = buildKoreanSurfaceLines("card");
    const exceptionLine = lines.find((line) => line.includes("terminal"));

    expect(exceptionLine).toBeDefined();
    for (const slot of ["prompt", "command", "output", "filename", "added", "removed"]) {
      expect(exceptionLine).toContain(slot);
    }
    // 서술형 대상 문장(첫 줄)에는 기술 표면 슬롯이 끼지 않는다
    expect(lines[0]).not.toContain("terminal");
    expect(lines[0]).not.toContain("diff");
  });

  it("builds the mix line exactly as the story prompt used to", () => {
    expect(buildKoreanEnglishMixLine("high")).toBe(
      'The persona\'s Korean-English mix setting is "high"; let it govern how freely the allowed English tokens above appear, within the limits stated there.'
    );
  });
});
