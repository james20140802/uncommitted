import { describe, expect, it } from "vitest";
import { chatStoryCard } from "../src/story-card-kind-chat.js";
import { storyCardRegistry } from "../src/story-card-registry.js";

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 5,
  pageCount: 6
};

describe("chat story card", () => {
  it("is registered in the shared registry", () => {
    expect(storyCardRegistry.map((kind) => kind.id)).toContain("chat");
  });

  it("declares the full registry contract", () => {
    expect(chatStoryCard.id).toBe("chat");
    expect(typeof chatStoryCard.requires).toBe("function");
    expect(typeof chatStoryCard.render).toBe("function");
    expect(Object.keys(chatStoryCard.slots)).toContain("messages");
  });

  it("renders speaker and message escaped, alternating sides", () => {
    const html = chatStoryCard.render(
      {
        messages: [
          "나: 이거 왜 <안 되지> & 뭐지",
          "리뷰어: 그 브랜치 아직 push 안 했어요"
        ]
      },
      chrome
    );

    expect(html).toContain("나");
    expect(html).toContain("이거 왜 &lt;안 되지&gt; &amp; 뭐지");
    expect(html).toContain("리뷰어");
    expect(html).toContain("그 브랜치 아직 push 안 했어요");
    expect(html).toContain(`data-side="left"`);
    expect(html).toContain(`data-side="right"`);
    expect(html).toContain(`data-story-card-kind="chat"`);
  });

  it("treats a line without a colon as a speakerless message", () => {
    const html = chatStoryCard.render({ messages: ["그냥 한 줄"] }, chrome);

    expect(html).toContain("그냥 한 줄");
  });
});
