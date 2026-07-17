import { describe, expect, it } from "vitest";
import {
  createPhotoFirstPrompt,
  sanitizeVisualPrompt
} from "../src/visual-assets.js";
import { checkDraftSafety } from "../src/safety-report.js";

describe("composed image prompt passes safety rules (UNC-220)", () => {
  it("sanitizes an unsafe anchor before it reaches the composed prompt", () => {
    // 실제 파이프라인: 원본 visual intent를 sanitize → summary → createPhotoFirstPrompt
    const rawAnchor =
      "leaked key sk-ABC123SECRETKEY and process.env.OPENAI_API_KEY in `const x = 1`";
    const summary = sanitizeVisualPrompt(rawAnchor);

    // sanitize 단계에서 시크릿/코드가 제거된다
    expect(summary).not.toContain("sk-ABC123SECRETKEY");
    expect(summary).not.toContain("process.env.OPENAI_API_KEY");
    expect(summary).not.toContain("`");

    const composed = createPhotoFirstPrompt(summary, {
      tone: "focused",
      anchorKeywords: ["key rotation"]
    });

    // 합성된 최종 프롬프트에도 시크릿/코드가 없다
    expect(composed).not.toContain("sk-ABC123SECRETKEY");
    expect(composed).not.toContain("process.env.OPENAI_API_KEY");
  });

  it("leaves a clean composed prompt unredacted by the safety pipeline", () => {
    const summary = sanitizeVisualPrompt("refactoring the mood pipeline");
    const composed = createPhotoFirstPrompt(summary);

    // checkDraftSafety가 아무것도 redact하지 않는다 = 안전 룰 통과
    const result = checkDraftSafety(composed);
    expect(result.redactedText).toBe(composed);
  });

  it("keeps the static identity layer itself safe", () => {
    const summary = sanitizeVisualPrompt("");
    const composed = createPhotoFirstPrompt(summary);
    const result = checkDraftSafety(composed);
    expect(result.redactedText).toBe(composed);
  });
});
