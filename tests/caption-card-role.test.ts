import { describe, expect, it } from "vitest";

import {
  CAPTION_LENGTH_WITHOUT_CARDS,
  CAPTION_LENGTH_WITH_CARDS,
  buildCaptionCardRoleLines,
  buildCaptionLengthLine,
  buildCaptionSkeletonLines
} from "../src/caption-card-role.js";
import type { SafeStoryCardGist } from "../src/ai-provider.js";

const gist: SafeStoryCardGist[] = [
  { cardType: "modal", lines: ["좋은 UX 팁 ①", "모달을 띄우세요"] }
];

describe("caption card role lines (UNC-236)", () => {
  it("카드가 있으면 짧은 부연을 요구한다", () => {
    expect(buildCaptionLengthLine(gist)).toBe(CAPTION_LENGTH_WITH_CARDS);
    expect(CAPTION_LENGTH_WITH_CARDS).toMatch(/1 to 2 short sentences/);
  });

  it("카드가 없으면 기존 4~8줄 요구를 그대로 쓴다", () => {
    expect(buildCaptionLengthLine(undefined)).toBe(CAPTION_LENGTH_WITHOUT_CARDS);
    expect(buildCaptionLengthLine([])).toBe(CAPTION_LENGTH_WITHOUT_CARDS);
    expect(CAPTION_LENGTH_WITHOUT_CARDS).toBe(
      "4 to 8 short lines. Blank lines are allowed. Add 2 to 5 hashtags (each starting with #)."
    );
  });

  it("해시태그 요구는 두 분기 모두에 남는다", () => {
    expect(CAPTION_LENGTH_WITH_CARDS).toContain("2 to 5 hashtags");
    expect(CAPTION_LENGTH_WITHOUT_CARDS).toContain("2 to 5 hashtags");
    expect(buildCaptionSkeletonLines(gist).join("\n")).toContain("2 to 5 hashtags");
    expect(buildCaptionSkeletonLines(undefined).join("\n")).toContain("2 to 5 hashtags");
  });

  it("카드가 있으면 역할 분담과 중복 회피를 지시한다", () => {
    const lines = buildCaptionCardRoleLines(gist).join("\n");

    expect(lines).toContain("storyCardGist");
    expect(lines).toMatch(/do not repeat|already said|말한 것/i);
  });

  it("카드가 없으면 역할 분담 줄을 한 줄도 붙이지 않는다", () => {
    expect(buildCaptionCardRoleLines(undefined)).toEqual([]);
    expect(buildCaptionCardRoleLines([])).toEqual([]);
  });

  it("카드가 있을 때 스켈레톤이 4~8줄 리듬을 남겨 두지 않는다", () => {
    const withCards = buildCaptionSkeletonLines(gist).join("\n");

    expect(withCards).not.toContain("Opening beat");
    expect(withCards).not.toContain("Landing line");
  });
});
