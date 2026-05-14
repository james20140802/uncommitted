import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  createCarouselHtmlCards,
  renderCarouselPngs,
  type CarouselPngVisualAsset
} from "../src/carousel-renderer.js";
import { runRenderCommand, RenderCommandError } from "../src/render-command.js";
import {
  createDraftRevision,
  writeDraftArtifactJson,
  writeLatestDraftPointer,
  type DraftRevision
} from "../src/draft-storage.js";
import type { DiaryDraft, DiarySlide } from "../src/diary-generator.js";

describe("carousel renderer smoke coverage", () => {
  it("renders a quiet 3-slide fixture into non-empty 1080x1350 PNGs", async () => {
    await assertPlaywrightChromiumAvailable();

    const revision = await createTestRevision("uncommitted-smoke-quiet-");
    const story = createStoryDraft({
      activityLevel: "low",
      slides: [
        {
          index: 1,
          title: "Quiet Day",
          body: "No commits landed today, so the honest update is a small local draft instead of invented momentum.",
          visualMood: "text-card-like quiet terminal with one waiting cursor"
        },
        {
          index: 2,
          title: "긴 한국어 레이아웃 확인",
          body: "오늘은 큰 변경이 없었지만 렌더러는 긴 한국어 문장을 빈 화면이나 깨진 카드로 통과시키면 안 된다. 조용한 날도 기록은 솔직하고 읽기 쉬워야 한다.",
          visualMood: "illustration-like notebook with Korean layout notes"
        },
        {
          index: 3,
          title: "Still Valid",
          body: "The carousel keeps the visual slot filled and the output inspectable.",
          visualMood: "story-card-like calm checklist"
        }
      ]
    });
    const cards = createCarouselHtmlCards(story, { visualStyle: "story-card" });
    const visualAssets = await writeVisualAssets(revision, cards.length);

    const result = await renderCarouselPngs({
      revision,
      cards,
      visualAssets
    });

    expect(result.files).toEqual([
      "carousel/01.png",
      "carousel/02.png",
      "carousel/03.png"
    ]);
    await expectCarouselPngs(revision, result.files);
    expect(result.images).toMatchObject([
      { slideIndex: 1, assetSlotId: "slide-01-visual" },
      { slideIndex: 2, assetSlotId: "slide-02-visual" },
      { slideIndex: 3, assetSlotId: "slide-03-visual" }
    ]);
  });

  it("renders a high-activity 8-slide photo-first fixture into expected PNG count", async () => {
    await assertPlaywrightChromiumAvailable();

    const revision = await createTestRevision("uncommitted-smoke-high-");
    const story = createStoryDraft({
      activityLevel: "high",
      slides: Array.from({ length: 8 }, (_, index) => ({
        index: index + 1,
        title: `Render checkpoint ${index + 1}`,
        body: `The renderer keeps high-activity slide ${index + 1} framed without relying on preview or export behavior.`,
        visualMood:
          index % 2 === 0
            ? "activity-scene-like terminal and diff panels"
            : "illustration-like generated visual card"
      }))
    });
    const cards = createCarouselHtmlCards(story, { visualStyle: "photo-first" });
    const visualAssets = await writeVisualAssets(revision, cards.length);

    const result = await renderCarouselPngs({
      revision,
      cards,
      visualAssets
    });

    expect(result.files).toEqual([
      "carousel/01.png",
      "carousel/02.png",
      "carousel/03.png",
      "carousel/04.png",
      "carousel/05.png",
      "carousel/06.png",
      "carousel/07.png",
      "carousel/08.png"
    ]);
    await expectCarouselPngs(revision, result.files);
  });

  it("rejects latest drafts that are missing required visual-slot metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-smoke-missing-"));
    const homeDir = join(directory, "home");
    const draftRoot = join(directory, "drafts");
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-05-18"
    });
    const story = createStoryDraft({
      slides: [
        {
          index: 1,
          title: "Missing visual metadata",
          body: "The render command should reject this before any blank visual stage can be accepted.",
          visualMood: "illustration-like missing slot"
        }
      ]
    });

    await writeRenderConfig(homeDir, draftRoot);
    await writeDraftArtifactJson(revision, "activity-summary.json", {
      schemaVersion: 1
    });
    await writeDraftArtifactJson(revision, "story.json", story);
    await writeFile(join(revision.outputDir, "caption.txt"), "Missing slot\n", "utf8");
    await writeDraftArtifactJson(revision, "safety-report.json", {
      schemaVersion: 1,
      status: "safe"
    });
    await writeDraftArtifactJson(revision, "metadata.json", {
      schemaVersion: 1,
      targetDate: "2026-05-18",
      files: [
        "activity-summary.json",
        "story.json",
        "caption.txt",
        "metadata.json",
        "safety-report.json"
      ],
      carouselVisualStyle: "story-card"
    });
    await writeLatestDraftPointer(revision, "2026-05-18T23:30:00.000Z");

    await expect(runRenderCommand(["latest"], { homeDir })).rejects.toEqual(
      new RenderCommandError(
        "Draft visual assets are missing. Regenerate the draft.",
        "render-failed"
      )
    );
  });
});

const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

let chromiumAvailability: Promise<void> | undefined;

async function assertPlaywrightChromiumAvailable(): Promise<void> {
  chromiumAvailability ??= chromium
    .launch({ headless: true })
    .then(async (browser) => {
      await browser.close();
    })
    .catch((error: unknown) => {
      throw new Error(
        [
          "Renderer smoke tests require Playwright Chromium.",
          "Run `pnpm exec playwright install chromium` before running this test file.",
          error instanceof Error ? error.message : String(error)
        ].join("\n")
      );
    });

  await chromiumAvailability;
}

async function createTestRevision(prefix: string): Promise<DraftRevision> {
  const draftRoot = await mkdtemp(join(tmpdir(), prefix));

  return await createDraftRevision({
    draftRoot,
    targetDate: "2026-05-18"
  });
}

async function writeVisualAssets(
  revision: DraftRevision,
  slideCount: number
): Promise<CarouselPngVisualAsset[]> {
  await mkdir(join(revision.outputDir, "visuals"), { recursive: true });

  const visualAssets: CarouselPngVisualAsset[] = [];

  for (let index = 1; index <= slideCount; index += 1) {
    const filePath = `visuals/${String(index).padStart(2, "0")}.png`;

    await writeFile(join(revision.outputDir, filePath), fixturePng);
    visualAssets.push({
      slideIndex: index,
      assetSlotId: `slide-${String(index).padStart(2, "0")}-visual`,
      filePath
    });
  }

  return visualAssets;
}

async function expectCarouselPngs(
  revision: DraftRevision,
  files: string[]
): Promise<void> {
  for (const file of files) {
    const png = await readFile(join(revision.outputDir, file));

    expect(png.length).toBeGreaterThan(100);
    expect([...png.subarray(0, 8)]).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a
    ]);
    expect(readPngDimensions(png)).toEqual({ width: 1080, height: 1350 });
  }
}

function readPngDimensions(png: Buffer): { width: number; height: number } {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}

async function writeRenderConfig(homeDir: string, draftRoot: string): Promise<void> {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        draftRoot,
        scheduleTime: "23:30",
        aiProvider: "none",
        persona: "test persona",
        roastLevel: 2
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function createStoryDraft(options: {
  activityLevel?: "low" | "medium" | "high";
  slides: DiarySlide[];
}): DiaryDraft {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-18",
    title: "Renderer Smoke Day",
    caption: "Renderer smoke coverage keeps carousel output honest.",
    slides: options.slides,
    hashtags: ["#Uncommitted"],
    altText: "Uncommitted renderer smoke carousel.",
    metadata: {
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activityLevel: options.activityLevel ?? "medium",
      formatName: "Renderer Smoke Fixture",
      storyFormatVoice: "deadpan QA narrator",
      storyFormatTone: "practical",
      projectIds: ["uncommitted"],
      entryMode: "daily_global",
      slideCount: options.slides.length
    }
  };
}
