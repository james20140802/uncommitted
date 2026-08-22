import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { runRenderCommand } from "../src/render-command.js";
import {
  createDraftRevision,
  writeDraftArtifactJson,
  writeLatestDraftPointer
} from "../src/draft-storage.js";
import type { DiaryDraft, DiarySlide } from "../src/diary-generator.js";

// UNC-270 / parent AC4: photo-first render-time asset failures must degrade
// the whole draft to story-card and still complete (exit 0, no dropped
// carousel) rather than dying with render-failed.

// Stub renderer: returns a valid 1080x1350 PNG without launching Playwright,
// so tests that exercise the story-card degrade fallback stay fast. Mirrors
// RecordingPngRenderer in tests/carousel-renderer.test.ts.
const fixturePng = await sharp({
  create: { width: 1080, height: 1350, channels: 3, background: "#123456" }
})
  .png()
  .toBuffer();

const stubRenderer = {
  async renderHtmlToPng(): Promise<Uint8Array> {
    return fixturePng;
  }
};

describe("photo-first render-time degrade (UNC-270 / parent AC4)", () => {
  it("degrades the whole draft to story-card when a photo asset file is missing", async () => {
    const { homeDir, revisionDir } = await writePhotoFirstDraft({
      missingAssetIndex: 1
    });

    const result = await runRenderCommand(["latest"], {
      homeDir,
      renderer: stubRenderer
    });

    // exit 5로 죽지 않고 완주한다
    expect(result.renderResult.status).toBe("rendered");
    // 모든 장이 렌더된다
    expect(result.renderResult.files).toHaveLength(2);
    // 드래프트 전체가 story-card로 전환되었음이 기록된다
    expect(result.renderResult.degraded).toMatchObject({
      from: "photo-first",
      to: "story-card"
    });

    const metadata = JSON.parse(
      await readFile(join(revisionDir, "metadata.json"), "utf8")
    );

    expect(metadata.carouselVisualStyle).toBe("story-card");
    expect(metadata.requestedCarouselVisualStyle).toBe("photo-first");
    expect(metadata.carousel.degraded.reason).toBeTruthy();

    // AC: "exit 5로 죽지 않고 완주" 만으로는 사용자가 degrade를 알아챌 수
    // 없다 — CLI가 띄울 경고 문구가 실제로 채워지는지 검증한다.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("story-card");
    expect(result.warnings?.[0]).toContain(
      result.renderResult.degraded?.reason ?? ""
    );
  });

  it("degrades when a photo asset is present but not a valid PNG", async () => {
    const { homeDir } = await writePhotoFirstDraft({ corruptAssetIndex: 0 });

    const result = await runRenderCommand(["latest"], {
      homeDir,
      renderer: stubRenderer
    });

    expect(result.renderResult.status).toBe("rendered");
    expect(result.renderResult.degraded?.to).toBe("story-card");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("story-card");
  });

  it("degrades when a photo asset has the wrong dimensions", async () => {
    const { homeDir } = await writePhotoFirstDraft({ wrongSizeAssetIndex: 0 });

    const result = await runRenderCommand(["latest"], {
      homeDir,
      renderer: stubRenderer
    });

    expect(result.renderResult.status).toBe("rendered");
    expect(result.renderResult.degraded?.to).toBe("story-card");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("story-card");
  });

  // PR #138 리뷰(Codex): degrade는 metadata.carouselVisualStyle만 story-card로
  // 내려놓고 visualAssets는 그대로 둔다. 그래서 다음 `render latest`는
  // story-card 카드에 여전히 못 쓰는 사진 자산을 붙이려 하고, composeCardHtml이
  // 같은 파일을 다시 열다 죽는다 — 카드가 이미 story-card라 degrade 경로도
  // 걸리지 않아 exit 5로 떨어진다. degrade가 살려낸 드래프트는 다시 렌더해도
  // 살아 있어야 한다.
  it("re-renders a degraded draft without reopening the unusable photo asset", async () => {
    const { homeDir, revisionDir } = await writePhotoFirstDraft({
      missingAssetIndex: 1
    });

    const first = await runRenderCommand(["latest"], {
      homeDir,
      renderer: stubRenderer
    });

    expect(first.renderResult.degraded?.to).toBe("story-card");

    const second = await runRenderCommand(["latest"], {
      homeDir,
      renderer: stubRenderer
    });

    expect(second.renderResult.status).toBe("rendered");
    expect(second.renderResult.files).toHaveLength(2);
    // 이미 story-card로 내려앉은 드래프트라 degrade는 다시 일어나지 않는다.
    expect(second.renderResult.degraded).toBeUndefined();
    expect(second.warnings).toBeUndefined();

    const metadata = JSON.parse(
      await readFile(join(revisionDir, "metadata.json"), "utf8")
    );

    expect(metadata.carouselVisualStyle).toBe("story-card");
  });

  it("does not degrade when every photo asset is valid", async () => {
    const { homeDir } = await writePhotoFirstDraft({});

    const result = await runRenderCommand(["latest"], {
      homeDir,
      renderer: stubRenderer
    });

    expect(result.renderResult.status).toBe("rendered");
    expect(result.renderResult.degraded).toBeUndefined();
    // 정상 경로에서는 경고 문구가 전혀 없어야 한다.
    expect(result.warnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture helper — reuses the draft-fixture patterns already established in
// tests/render-command.test.ts (home dir + config.json + latest pointer) and
// tests/carousel-renderer-smoke.test.ts (visual asset PNGs on disk).
// ---------------------------------------------------------------------------

async function writePhotoFirstDraft(options: {
  missingAssetIndex?: number;
  corruptAssetIndex?: number;
  wrongSizeAssetIndex?: number;
}): Promise<{ homeDir: string; revisionDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-render-degrade-"));
  const homeDir = join(directory, "home");
  const draftRoot = join(directory, "drafts");

  const revision = await createDraftRevision({
    draftRoot,
    targetDate: "2026-05-18"
  });

  await writeRenderConfig(homeDir, draftRoot);

  const slides: DiarySlide[] = [
    {
      index: 1,
      title: "First checkpoint",
      body: "Photo-first slide one body text for the degrade fixture.",
      visualMood: "activity-scene-like terminal and diff panels"
    },
    {
      index: 2,
      title: "Second checkpoint",
      body: "Photo-first slide two body text for the degrade fixture.",
      visualMood: "illustration-like generated visual card"
    }
  ];
  const story = createStoryDraft(slides);

  await mkdir(join(revision.outputDir, "visuals"), { recursive: true });

  const wrongSizePng = await sharp({
    create: { width: 800, height: 1000, channels: 3, background: "#654321" }
  })
    .png()
    .toBuffer();

  const visualAssets: Array<{
    slideIndex: number;
    assetSlotId: string;
    filePath: string;
  }> = [];

  for (const [index, slide] of slides.entries()) {
    const filePath = `visuals/${String(index + 1).padStart(2, "0")}.png`;

    if (index !== options.missingAssetIndex) {
      if (index === options.corruptAssetIndex) {
        await writeFile(join(revision.outputDir, filePath), "not a png");
      } else if (index === options.wrongSizeAssetIndex) {
        await writeFile(join(revision.outputDir, filePath), wrongSizePng);
      } else {
        await writeFile(join(revision.outputDir, filePath), fixturePng);
      }
    }
    // metadata still records the asset slot even when the file itself is
    // absent — assertVisualAssetsCoverCards only checks metadata shape, not
    // file existence, so the degrade path (not that guard) must catch this.

    visualAssets.push({
      slideIndex: slide.index,
      assetSlotId: `slide-${String(index + 1).padStart(2, "0")}-visual`,
      filePath
    });
  }

  await writeDraftArtifactJson(revision, "story.json", story);
  await writeFile(join(revision.outputDir, "caption.txt"), "Caption\n", "utf8");
  await writeDraftArtifactJson(revision, "activity-summary.json", {
    schemaVersion: 1
  });
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
    carouselVisualStyle: "photo-first",
    requestedCarouselVisualStyle: "photo-first",
    visualAssets
  });
  await writeLatestDraftPointer(revision, "2026-05-18T23:30:00.000Z");

  return { homeDir, revisionDir: revision.outputDir };
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

function createStoryDraft(slides: DiarySlide[]): DiaryDraft {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-18",
    title: "Degrade Fixture Day",
    slides,
    altText: "Uncommitted photo-first degrade fixture carousel.",
    metadata: {
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activityLevel: "high",
      mood: "grind",
      angle: "Photo-first degrade fixture angle.",
      projectIds: ["uncommitted"],
      entryMode: "daily_global",
      slideCount: slides.length
    }
  };
}
