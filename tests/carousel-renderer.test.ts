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
      kind: "illustration",
      assetSlotId: "slide-01-visual",
      prompt: "clean card",
      altText: "Illustration concept: clean card"
    });
    expect(cards[0]?.html).toContain("class=\"visual-stage\"");
    expect(cards[0]?.html).toContain("data-visual-kind=\"illustration\"");
    expect(cards[0]?.html).toContain("data-asset-slot-id=\"slide-01-visual\"");
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

  it("surfaces screenshot failures as carousel PNG render errors", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft());

    await expect(
      renderCarouselPngs({
        revision,
        cards,
        renderer: new FailingPngRenderer()
      })
    ).rejects.toEqual(
      new CarouselPngRenderError(
        "Could not render carousel PNGs.",
        "render-failed"
      )
    );
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

class FailingPngRenderer {
  async renderHtmlToPng(): Promise<never> {
    throw new Error("browser failed with internal detail");
  }
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
