import { describe, expect, it } from "vitest";
import { checkboardStoryCard } from "../src/story-card-kind-checkboard.js";
import { storyCardRegistry } from "../src/story-card-registry.js";

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 4,
  pageCount: 6
};

describe("checkboard story card", () => {
  it("is registered in the shared registry", () => {
    expect(storyCardRegistry.map((kind) => kind.id)).toContain("checkboard");
  });

  it("declares the full registry contract", () => {
    expect(checkboardStoryCard.id).toBe("checkboard");
    expect(typeof checkboardStoryCard.requires).toBe("function");
    expect(typeof checkboardStoryCard.render).toBe("function");
    expect(Object.keys(checkboardStoryCard.slots)).toContain("done");
  });

  it("renders checked and unchecked items with escaped slot values", () => {
    const html = checkboardStoryCard.render(
      {
        heading: "오늘의 <할 일>",
        done: ["레지스트리 계약 확정 & 커밋"],
        todo: ["필터 로직"]
      },
      chrome
    );

    expect(html).toContain("오늘의 &lt;할 일&gt;");
    expect(html).toContain("레지스트리 계약 확정 &amp; 커밋");
    expect(html).toContain("필터 로직");
    expect(html).toContain(`data-checked="true"`);
    expect(html).toContain(`data-checked="false"`);
    expect(html).toContain(`data-story-card-kind="checkboard"`);
  });

  it("renders with only done items", () => {
    const html = checkboardStoryCard.render(
      { heading: "완료", done: ["하나"] },
      chrome
    );

    expect(html).toContain("하나");
  });
});
