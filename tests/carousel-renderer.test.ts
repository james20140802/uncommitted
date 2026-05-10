import { describe, expect, it } from "vitest";
import {
  CarouselRenderInputError,
  createCarouselHtmlCards,
  parseCarouselRenderInput
} from "../src/carousel-renderer.js";
import type { DiaryDraft } from "../src/diary-generator.js";

describe("carousel renderer", () => {
  it("creates one deterministic HTML card per slide in story order", () => {
    const cards = createCarouselHtmlCards(createStoryDraft());

    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.fileName)).toEqual([
      "01.html",
      "02.html",
      "03.html"
    ]);
    expect(cards.map((card) => card.slideIndex)).toEqual([1, 2, 3]);
    expect(cards[0]?.html).toContain("width: 1080px;");
    expect(cards[0]?.html).toContain("height: 1350px;");
    expect(cards[0]?.html).toContain("Opening Statement");
    expect(cards[0]?.html).toContain("2026-05-18");
    expect(cards[0]?.html).toContain("uncommitted");
    expect(cards[0]?.html).toContain("1 / 3");
    expect(cards[0]?.html).toContain("Uncommitted");
  });

  it("escapes slide content before writing HTML", () => {
    const cards = createCarouselHtmlCards(
      createStoryDraft({
        slides: [
          {
            index: 1,
            title: "Fix <script>",
            body: "Rendered & safe.",
            visualMood: "plain"
          },
          {
            index: 2,
            title: "Quote",
            body: "\"Ship\" without surprise.",
            visualMood: "plain"
          },
          {
            index: 3,
            title: "Done",
            body: "Card renderer stays local.",
            visualMood: "plain"
          }
        ]
      })
    );

    expect(cards[0]?.html).toContain("Fix &lt;script&gt;");
    expect(cards[0]?.html).toContain("Rendered &amp; safe.");
    expect(cards[0]?.html).not.toContain("Fix <script>");
  });

  it("parses the existing story.json slide contract for rendering", () => {
    const input = parseCarouselRenderInput(createStoryDraft());

    expect(input).toEqual({
      targetDate: "2026-05-18",
      projectMarker: "uncommitted",
      slides: [
        {
          index: 1,
          title: "Opening Statement",
          body: "The renderer now has a contract before it gets a camera.",
          visualMood: "clean card"
        },
        {
          index: 2,
          title: "Evidence",
          body: "Slide order survived the trip from story.json.",
          visualMood: "ordered stack"
        },
        {
          index: 3,
          title: "Verdict",
          body: "PNG work can arrive later without guessing HTML shape.",
          visualMood: "quiet stamp"
        }
      ]
    });
  });

  it("fails invalid slide data with a short render-input error", () => {
    const invalidDraft = {
      ...createStoryDraft(),
      slides: [
        {
          index: 2,
          title: "",
          body: "Missing useful title.",
          visualMood: "broken"
        }
      ]
    };

    expect(() => createCarouselHtmlCards(invalidDraft)).toThrow(
      new CarouselRenderInputError(
        "story.json must include ordered slides with title and body.",
        "invalid-story"
      )
    );
  });
});

function createStoryDraft(overrides: Partial<DiaryDraft> = {}): DiaryDraft {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-18",
    title: "Renderer Foundation Day",
    caption: "HTML cards first, camera later.",
    slides: [
      {
        index: 1,
        title: "Opening Statement",
        body: "The renderer now has a contract before it gets a camera.",
        visualMood: "clean card"
      },
      {
        index: 2,
        title: "Evidence",
        body: "Slide order survived the trip from story.json.",
        visualMood: "ordered stack"
      },
      {
        index: 3,
        title: "Verdict",
        body: "PNG work can arrive later without guessing HTML shape.",
        visualMood: "quiet stamp"
      }
    ],
    hashtags: ["#Uncommitted"],
    altText: "Uncommitted carousel draft.",
    metadata: {
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activityLevel: "medium",
      formatName: "Bug Court Transcript",
      storyFormatVoice: "tired QA narrator",
      storyFormatTone: "deadpan",
      projectIds: ["uncommitted"],
      entryMode: "daily_global",
      slideCount: 3
    },
    ...overrides
  };
}
