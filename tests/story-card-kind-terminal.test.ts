import { describe, expect, it } from "vitest";
import { terminalStoryCard } from "../src/story-card-kind-terminal.js";
import { storyCardRegistry } from "../src/story-card-registry.js";

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 1,
  pageCount: 6
};

describe("terminal story card", () => {
  it("is registered in the shared registry", () => {
    expect(storyCardRegistry.map((kind) => kind.id)).toContain("terminal");
  });

  it("declares the full registry contract", () => {
    expect(terminalStoryCard.id).toBe("terminal");
    expect(typeof terminalStoryCard.requires).toBe("function");
    expect(typeof terminalStoryCard.render).toBe("function");
    expect(Object.keys(terminalStoryCard.slots)).toContain("command");
  });

  it("renders representative slot values escaped into the output", () => {
    const html = terminalStoryCard.render(
      {
        prompt: "~/dev/uncommitted $",
        command: "pnpm test --filter <all>",
        output: ["24 passed & 0 failed", "done in 3.1s"]
      },
      chrome
    );

    expect(html).toContain("~/dev/uncommitted $");
    expect(html).toContain("pnpm test --filter &lt;all&gt;");
    expect(html).toContain("24 passed &amp; 0 failed");
    expect(html).toContain("done in 3.1s");
    expect(html).toContain(`data-story-card-kind="terminal"`);
    expect(html).toMatch(/<article\b[^>]*\sdata-layout-fit="base"/);
  });

  it("renders without optional output lines", () => {
    const html = terminalStoryCard.render(
      { prompt: "$", command: "git status" },
      chrome
    );

    expect(html).toContain("git status");
  });
});
