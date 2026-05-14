import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CarouselRenderInputError,
  CarouselPngRenderError,
  createCarouselHtmlCards,
  parseCarouselRenderInput,
  renderCarouselPngs
} from "../src/carousel-renderer.js";
import { createDraftRevision } from "../src/draft-storage.js";
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
    expect(cards[0]?.visualTreatment).toEqual({
      kind: "story-card",
      assetSlotId: "slide-01-visual",
      prompt: "clean card",
      altText: "Story-card visual concept: clean card"
    });
    expect(cards[0]?.visualStyle).toBe("story-card");
    expect(cards[0]?.html).toContain("class=\"visual-stage\"");
    expect(cards[0]?.html).toContain("data-carousel-visual-style=\"story-card\"");
    expect(cards[0]?.html).toContain("data-visual-kind=\"story-card\"");
    expect(cards[0]?.html).toContain("data-asset-slot-id=\"slide-01-visual\"");
  });

  it("creates photo-first cards with image-forward markup and no large body copy", () => {
    const cards = createCarouselHtmlCards(createStoryDraft(), {
      visualStyle: "photo-first"
    });

    expect(cards[0]?.visualStyle).toBe("photo-first");
    expect(cards[0]?.visualTreatment).toMatchObject({
      kind: "photo",
      assetSlotId: "slide-01-visual",
      altText: "Photo-first visual concept: clean card"
    });
    expect(cards[0]?.html).toContain("data-carousel-visual-style=\"photo-first\"");
    expect(cards[0]?.html).toContain("data-visual-kind=\"photo\"");
    expect(cards[0]?.html).not.toContain(
      "The renderer now has a contract before it gets a camera."
    );
    expect(cards[0]?.html).not.toContain("<p class=\"body\"");
  });

  it("escapes slide and visual treatment content before writing HTML", () => {
    const cards = createCarouselHtmlCards(
      createStoryDraft({
        slides: [
          {
            index: 1,
            title: "Fix <script>",
            body: "Rendered & safe.",
            visualMood: "terminal <alert> & sparks"
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
    expect(cards[0]?.html).toContain("terminal &lt;alert&gt; &amp; sparks");
    expect(cards[0]?.html).not.toContain("Fix <script>");
    expect(cards[0]?.html).not.toContain("terminal <alert>");
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

  it("renders ordered carousel PNG files under the draft revision", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft());
    const renderer = new RecordingPngRenderer();

    await writeDraftTextFixtures(revision.outputDir);
    await mkdir(join(revision.outputDir, "visuals"), { recursive: true });
    await writeFile(
      join(revision.outputDir, "visuals", "01.png"),
      fixturePng,
      "binary"
    );

    const result = await renderCarouselPngs({
      revision,
      cards,
      visualAssets: [
        {
          slideIndex: 1,
          assetSlotId: "slide-01-visual",
          filePath: "visuals/01.png"
        }
      ],
      renderer
    });

    expect(result.files).toEqual([
      "carousel/01.png",
      "carousel/02.png",
      "carousel/03.png"
    ]);
    expect(result.images).toMatchObject([
      {
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        filePath: "carousel/01.png",
        visualAssetPath: "visuals/01.png"
      },
      {
        slideIndex: 2,
        assetSlotId: "slide-02-visual",
        filePath: "carousel/02.png"
      },
      {
        slideIndex: 3,
        assetSlotId: "slide-03-visual",
        filePath: "carousel/03.png"
      }
    ]);
    expect(renderer.calls).toHaveLength(3);
    expect(renderer.calls[0]?.html).toContain("data-asset-slot-id=\"slide-01-visual\"");
    expect(renderer.calls[0]?.html).toContain("data:image/png;base64,");
    expect(renderer.calls[0]?.html).toContain("class=\"visual-asset\"");

    const firstPng = await readFile(join(revision.outputDir, "carousel", "01.png"));
    expect([...firstPng.subarray(0, 8)]).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a
    ]);
    await expect(readFile(join(revision.outputDir, "story.json"), "utf8")).resolves.toBe(
      "{\"schemaVersion\":1}\n"
    );
  });

  it("renders photo-first PNGs with visual assets as the primary surface", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft(), {
      visualStyle: "photo-first"
    });
    const renderer = new RecordingPngRenderer();

    await mkdir(join(revision.outputDir, "visuals"), { recursive: true });
    await writeFile(join(revision.outputDir, "visuals", "01.png"), fixturePng);

    await renderCarouselPngs({
      revision,
      cards: [cards[0]],
      visualAssets: [
        {
          slideIndex: 1,
          assetSlotId: "slide-01-visual",
          filePath: "visuals/01.png"
        }
      ],
      renderer
    });

    expect(renderer.calls[0]?.html).toContain("class=\"visual-asset\"");
    expect(renderer.calls[0]?.html).toContain(
      "class=\"photo-stage has-visual-asset visual-stage\""
    );
    expect(renderer.calls[0]?.html).not.toContain("<p class=\"body\"");
    expect(renderer.calls[0]?.html).not.toContain(
      "The renderer now has a contract before it gets a camera."
    );
  });

  it("fits long but reasonable slide text with deterministic layout fallbacks", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(
      createStoryDraft({
        slides: [
          {
            index: 1,
            title: "Long But Reasonable Render Update",
            body: [
              "The renderer keeps a busy workday readable without asking AI to rewrite the slide.",
              "It tightens line-height first, reduces type next, and only accepts the card when the screenshot pass says the layout still fits."
            ].join(" "),
            visualMood: "compact terminal summary"
          }
        ],
        metadata: {
          targetDate: "2026-05-18",
          generatedAt: "2026-05-18T23:30:00.000Z",
          activityLevel: "medium",
          formatName: "Bug Court Transcript",
          storyFormatVoice: "tired QA narrator",
          storyFormatTone: "deadpan",
          projectIds: ["uncommitted"],
          entryMode: "daily_global",
          slideCount: 1
        }
      })
    );
    const renderer = new LayoutFittingRenderer("compact");

    const result = await renderCarouselPngs({
      revision,
      cards,
      renderer
    });

    expect(result.status).toBe("rendered");
    expect(result.files).toEqual(["carousel/01.png"]);
    expect(renderer.calls.map((call) => extractLayoutFit(call.html))).toEqual([
      "base",
      "tight",
      "compact"
    ]);
  });

  it("rejects invalid declared visual assets before screenshot rendering", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft());
    const renderer = new RecordingPngRenderer();

    await mkdir(join(revision.outputDir, "visuals"), { recursive: true });
    await writeFile(join(revision.outputDir, "visuals", "01.png"), "not a png");

    await expect(
      renderCarouselPngs({
        revision,
        cards: [cards[0]],
        visualAssets: [
          {
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            filePath: "visuals/01.png"
          }
        ],
        renderer
      })
    ).rejects.toMatchObject({
      message: "Could not render carousel PNGs.",
      code: "render-failed",
      partialResult: {
        status: "failed",
        files: [],
        images: [],
        failures: [
          {
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            sourceHtmlFileName: "01.html",
            filePath: "carousel/01.png",
            code: "render-failed",
            message: "Could not render carousel PNGs."
          }
        ]
      }
    });
    expect(renderer.calls).toHaveLength(0);
  });

  it("surfaces screenshot failures as carousel PNG render errors", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft());

    await expect(
      renderCarouselPngs({
        revision,
        cards,
        renderer: new FailingPngRenderer()
      })
    ).rejects.toMatchObject({
      message: "Could not render carousel PNGs.",
      code: "render-failed",
      partialResult: {
        schemaVersion: 1,
        status: "failed",
        files: [],
        images: [],
        failures: [
          {
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            sourceHtmlFileName: "01.html",
            filePath: "carousel/01.png",
            code: "render-failed",
            message: "Could not render carousel PNGs."
          }
        ]
      }
    });
  });

  it("fails severely overflowing slides with partial output details", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(
      createStoryDraft({
        slides: [
          {
            index: 1,
            title: "First",
            body: "This card renders before the later overflow failure.",
            visualMood: "small card"
          },
          {
            index: 2,
            title: "Overflow",
            body: "This body is intentionally too large to fit. ".repeat(80),
            visualMood: "crowded wall"
          }
        ],
        metadata: {
          targetDate: "2026-05-18",
          generatedAt: "2026-05-18T23:30:00.000Z",
          activityLevel: "medium",
          formatName: "Bug Court Transcript",
          storyFormatVoice: "tired QA narrator",
          storyFormatTone: "deadpan",
          projectIds: ["uncommitted"],
          entryMode: "daily_global",
          slideCount: 2
        }
      })
    );
    const renderer = new SecondCardOverflowRenderer();

    await writeDraftTextFixtures(revision.outputDir);

    await expect(
      renderCarouselPngs({
        revision,
        cards,
        renderer
      })
    ).rejects.toMatchObject({
      message: "Could not render carousel PNGs.",
      code: "render-failed",
      partialResult: {
        schemaVersion: 1,
        status: "failed",
        files: ["carousel/01.png"],
        images: [
          {
            schemaVersion: 1,
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            sourceHtmlFileName: "01.html",
            filePath: "carousel/01.png"
          }
        ],
        failures: [
          {
            schemaVersion: 1,
            slideIndex: 2,
            assetSlotId: "slide-02-visual",
            sourceHtmlFileName: "02.html",
            filePath: "carousel/02.png",
            code: "render-failed",
            message: "Could not render carousel PNGs."
          }
        ]
      }
    });
    await expect(readFile(join(revision.outputDir, "carousel", "01.png"))).resolves.toBeDefined();
    await expect(readFile(join(revision.outputDir, "story.json"), "utf8")).resolves.toBe(
      "{\"schemaVersion\":1}\n"
    );
    await expect(readFile(join(revision.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "Caption\n"
    );
  });

  it("rejects backslash traversal in visual asset paths", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft());
    const renderer = new RecordingPngRenderer();

    await writeFile(join(revision.outputDir, "..\\secret.png"), fixturePng);

    await expect(
      renderCarouselPngs({
        revision,
        cards: [cards[0]],
        visualAssets: [
          {
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            filePath: "..\\secret.png"
          }
        ],
        renderer
      })
    ).rejects.toMatchObject({
      message: "Could not render carousel PNGs.",
      code: "render-failed",
      partialResult: {
        status: "failed",
        files: [],
        images: [],
        failures: [
          {
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            sourceHtmlFileName: "01.html",
            filePath: "carousel/01.png",
            code: "render-failed",
            message: "Could not render carousel PNGs."
          }
        ]
      }
    });
    expect(renderer.calls).toHaveLength(0);
  });
});

const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

class RecordingPngRenderer {
  readonly calls: Array<{ html: string; width: number; height: number }> = [];

  async renderHtmlToPng(options: {
    html: string;
    width: number;
    height: number;
  }): Promise<Uint8Array> {
    this.calls.push(options);

    return fixturePng;
  }
}

class LayoutFittingRenderer {
  readonly calls: Array<{ html: string; width: number; height: number }> = [];

  constructor(private readonly acceptedFit: string) {}

  async renderHtmlToPng(options: {
    html: string;
    width: number;
    height: number;
  }): Promise<Uint8Array> {
    this.calls.push(options);

    if (extractLayoutFit(options.html) !== this.acceptedFit) {
      throw new CarouselPngRenderError(
        "Could not render carousel PNGs.",
        "render-failed"
      );
    }

    return fixturePng;
  }
}

class SecondCardOverflowRenderer {
  async renderHtmlToPng(options: { html: string }): Promise<Uint8Array> {
    if (options.html.includes("aria-label=\"Uncommitted carousel card 2 / 2\"")) {
      throw new CarouselPngRenderError(
        "Could not render carousel PNGs.",
        "render-failed"
      );
    }

    return fixturePng;
  }
}

class FailingPngRenderer {
  async renderHtmlToPng(): Promise<never> {
    throw new Error("browser failed with internal detail");
  }
}

function extractLayoutFit(html: string): string | undefined {
  return /<article\b[^>]*\sdata-layout-fit="([^"]+)"/.exec(html)?.[1];
}

async function createTestRevision() {
  const draftRoot = join(tmpdir(), `uncommitted-carousel-render-${randomUUID()}`);

  await mkdir(draftRoot, { recursive: true });

  return await createDraftRevision({
    draftRoot,
    targetDate: "2026-05-18"
  });
}

async function writeDraftTextFixtures(outputDir: string): Promise<void> {
  await writeFile(join(outputDir, "story.json"), "{\"schemaVersion\":1}\n", "utf8");
  await writeFile(join(outputDir, "caption.txt"), "Caption\n", "utf8");
  await writeFile(
    join(outputDir, "activity-summary.json"),
    "{\"schemaVersion\":1}\n",
    "utf8"
  );
  await writeFile(join(outputDir, "metadata.json"), "{\"schemaVersion\":1}\n", "utf8");
  await writeFile(
    join(outputDir, "safety-report.json"),
    "{\"schemaVersion\":1}\n",
    "utf8"
  );
}

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
