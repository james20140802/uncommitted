import { describe, expect, it } from "vitest";
import { modalStoryCard } from "../src/story-card-kind-modal.js";
import { storyCardRegistry } from "../src/story-card-registry.js";

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 3,
  pageCount: 6
};

describe("modal story card", () => {
  it("is registered in the shared registry", () => {
    expect(storyCardRegistry.map((kind) => kind.id)).toContain("modal");
  });

  it("declares the full registry contract", () => {
    expect(modalStoryCard.id).toBe("modal");
    expect(typeof modalStoryCard.requires).toBe("function");
    expect(typeof modalStoryCard.render).toBe("function");
    expect(Object.keys(modalStoryCard.slots)).toContain("primaryAction");
  });

  it("renders representative slot values escaped into the output", () => {
    const html = modalStoryCard.render(
      {
        title: "변경사항을 버릴까요?",
        body: "커밋 안 한 파일 <3개>가 사라집니다 & 되돌릴 수 없습니다",
        primaryAction: "버리기",
        secondaryAction: "취소"
      },
      chrome
    );

    expect(html).toContain("변경사항을 버릴까요?");
    expect(html).toContain("커밋 안 한 파일 &lt;3개&gt;가 사라집니다 &amp;");
    expect(html).toContain("버리기");
    expect(html).toContain("취소");
    expect(html).toContain(`data-story-card-kind="modal"`);
    expect(html).toMatch(/<article\b[^>]*\sdata-layout-fit="base"/);
  });

  it("renders without the optional secondary action", () => {
    const html = modalStoryCard.render(
      { title: "확인", body: "본문", primaryAction: "확인" },
      chrome
    );

    expect(html).toContain("확인");
  });
});
