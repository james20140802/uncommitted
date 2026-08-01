import { describe, expect, it } from "vitest";
import { diffStoryCard } from "../src/story-card-kind-diff.js";
import { storyCardRegistry } from "../src/story-card-registry.js";

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 6,
  pageCount: 6
};

describe("diff story card", () => {
  it("is registered in the shared registry", () => {
    expect(storyCardRegistry.map((kind) => kind.id)).toContain("diff");
  });

  it("declares the full registry contract", () => {
    expect(diffStoryCard.id).toBe("diff");
    expect(typeof diffStoryCard.requires).toBe("function");
    expect(typeof diffStoryCard.render).toBe("function");
    expect(Object.keys(diffStoryCard.slots)).toContain("added");
  });

  it("renders +/- lines with escaped slot values", () => {
    const html = diffStoryCard.render(
      {
        filename: "story-card-registry.ts",
        added: ["레지스트리 파생 뷰 <추가> & 정리"],
        removed: ["하드코딩된 열거형"]
      },
      chrome
    );

    expect(html).toContain("story-card-registry.ts");
    expect(html).toContain("레지스트리 파생 뷰 &lt;추가&gt; &amp; 정리");
    expect(html).toContain("하드코딩된 열거형");
    expect(html).toContain(`data-diff="added"`);
    expect(html).toContain(`data-diff="removed"`);
    expect(html).toContain(`data-story-card-kind="diff"`);
  });

  it("renders with only added lines", () => {
    const html = diffStoryCard.render(
      { filename: "a.ts", added: ["한 줄"] },
      chrome
    );

    expect(html).toContain("한 줄");
  });
});
