import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
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
import { storyCardRegistry, type StoryCardSlots } from "../src/story-card-registry.js";
import type { StoryCardPlan } from "../src/story-card-plan.js";

// Real Chromium launches exceed the default 5s timeout when the full suite
// runs in parallel; give the Playwright-backed tests an explicit budget.
const PLAYWRIGHT_TEST_TIMEOUT_MS = 60_000;

describe("carousel renderer smoke coverage", () => {
  it("renders a quiet 3-slide fixture into non-empty 1080x1350 PNGs", { timeout: PLAYWRIGHT_TEST_TIMEOUT_MS }, async () => {
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

  // UNC-235 리뷰 반영: 이전까지 이 파일이 유일하게 실제 Chromium을 띄우는
  // 테스트인데, story-card 케이스는 storyCardPlan을 넘기지 않아 항상 typo
  // 폴백만 렌더했다. 여섯 종류의 레지스트리 카드는
  // tests/carousel-renderer-story-card-registry.test.ts가 HTML 문자열
  // 매칭으로만 배선을 증명했을 뿐, Playwright로 실제 렌더된 적이 없다.
  // validateRenderedCard는 .card-stage가 16px 넘게 넘치면 그 카드를
  // 실패시키고, renderCardWithLayoutFallbacks는 base/tight/compact 세
  // 번만 시도한다 — 여섯 종류 모두 선언된 maxLength/maxLines까지 채운
  // 슬롯이 세 번의 fit 전부에서 넘치면 그날 드래프트 전체가 exit 5로
  // 죽는다. story-card가 기본 모드가 된 지금은 이 경로가 매일 지나가므로,
  // 여섯 종류를 각 슬롯 스키마의 선언된 최대치로 채워 실제로 1080x1350에
  // 들어가는지 확인한다. 이 테스트의 첫 실행이 정확히 그 실패를
  // 잡아냈다 — checkboard/chat/diff는 실측 전 추정치였던 maxLines가
  // 실제로 넘쳤고(diff는 overflow:hidden 때문에 소리 없이 잘리기까지
  // 했다), src/story-card-kind-checkboard.ts / -chat.ts / -diff.ts의
  // 한도를 이 테스트가 통과하는 값으로 재조정했다. 이 테스트는 그
  // 한도가 계속 정직하게 유지되도록 지키는 회귀 테스트다.
  it("renders all six story-card registry kinds filled to their declared slot maxima", { timeout: PLAYWRIGHT_TEST_TIMEOUT_MS }, async () => {
    await assertPlaywrightChromiumAvailable();

    const revision = await createTestRevision("uncommitted-smoke-registry-");
    const slides: DiarySlide[] = storyCardRegistry.map((kind, index) => ({
      index: index + 1,
      title: `Registry slot-max check: ${kind.id}`,
      body: `Slide ${index + 1} carries the ${kind.id} card filled to its declared slot maxima.`,
      visualMood: "story-card-like registry coverage"
    }));
    const story = createStoryDraft({ slides });

    const plan: StoryCardPlan = {
      schemaVersion: 1,
      cards: storyCardRegistry.map((kind) => ({
        type: kind.id,
        slots: maxSlotFixtureFor(kind.id),
        source: "generated" as const
      }))
    };

    const cards = createCarouselHtmlCards(story, {
      visualStyle: "story-card",
      storyCardPlan: plan
    });
    const visualAssets = await writeVisualAssets(revision, cards.length);

    const result = await renderCarouselPngs({
      revision,
      cards,
      visualAssets
    });

    expect(result.files).toHaveLength(storyCardRegistry.length);
    await expectCarouselPngs(revision, result.files);

    for (const [index, kind] of storyCardRegistry.entries()) {
      // 각 카드가 typo 폴백이 아니라 자기 종류의 render()로 실제 그려졌다는
      // 증거 — data-story-card-kind가 fit fallback을 거쳐도 kindId를
      // 그대로 실어 나른다(story-card-chrome.ts).
      expect(cards[index].html).toContain(`data-story-card-kind="${kind.id}"`);
    }
  });

  it("renders a high-activity 8-slide photo-first fixture into expected PNG count", { timeout: PLAYWRIGHT_TEST_TIMEOUT_MS }, async () => {
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
    // photo-first fast-path copies raw AI-generated bytes directly. UNC-267:
    // the raw-copy path now guards on CAROUSEL_WIDTH/HEIGHT (1080x1350), so
    // dimensions are guaranteed here too — this helper still only checks the
    // PNG signature since dimension coverage lives in
    // tests/photo-first-dimensions.test.ts.
    await expectCarouselPngsAreValid(revision, result.files);
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

// UNC-267: raw-copy fixtures must be 1080x1350 — assertCarouselPngDimensions
// now rejects mis-sized assets on the photo-first raw-copy path.
const fixturePng = await sharp({
  create: { width: 1080, height: 1350, channels: 3, background: "#123456" }
})
  .png()
  .toBuffer();

// UNC-235: 슬롯을 각 카드 종류의 선언된 한도까지 채우는 픽스처. 값은
// src/story-card-kind-*.ts의 slots 스키마에서 그대로 읽어왔다 — 임의로
// 지어내지 않는다.
//   typo:       headline maxLength 40, kicker maxLength 24
//   terminal:   prompt maxLength 24, command maxLength 60,
//               output maxLines 6 / maxLength 60
//   modal:      title maxLength 32, body maxLength 120,
//               primaryAction maxLength 16, secondaryAction maxLength 16
//   checkboard: heading maxLength 32,
//               done/todo maxLines 2 / maxLength 40
//               (UNC-235: was maxLines 5 / 5 — that combination overflowed
//               .card-stage by 704px at base fit and still overflowed by
//               94px at the most aggressive compact fallback; this test is
//               what caught it. Re-tuned to maxLines 2 / 2, which leaves
//               248px of real headroom at base fit for the same worst case
//               of both lists maxed simultaneously.)
//   chat:       messages maxLines 4 / maxLength 60
//               (UNC-235: was maxLines 6 — overflowed by 207px at base fit;
//               re-tuned to leave 209px of headroom at base fit.)
//   diff:       filename maxLength 48,
//               added/removed maxLines 3 / maxLength 56
//               (UNC-235: was maxLines 5 / 5 — .diff has its own
//               overflow:hidden, so the overflow didn't surface as a
//               render failure at all; flex-shrink silently clipped 305px
//               of content instead. Re-tuned to leave 160px of headroom.)
const KOREAN_FILLER_UNIT = "카드렌더슬롯최대치검증용문자열입니다";

function koreanFiller(length: number): string {
  let result = "";

  while (result.length < length) {
    result += KOREAN_FILLER_UNIT;
  }

  return result.slice(0, length);
}

function filledLines(count: number, length: number): string[] {
  return Array.from({ length: count }, () => koreanFiller(length));
}

const maxSlotFixtures: Record<string, StoryCardSlots> = {
  typo: {
    headline: koreanFiller(40),
    kicker: koreanFiller(24)
  },
  terminal: {
    prompt: koreanFiller(24),
    command: koreanFiller(60),
    output: filledLines(6, 60)
  },
  modal: {
    title: koreanFiller(32),
    body: koreanFiller(120),
    primaryAction: koreanFiller(16),
    secondaryAction: koreanFiller(16)
  },
  checkboard: {
    heading: koreanFiller(32),
    done: filledLines(2, 40),
    todo: filledLines(2, 40)
  },
  chat: {
    messages: filledLines(4, 60)
  },
  diff: {
    filename: koreanFiller(48),
    added: filledLines(3, 56),
    removed: filledLines(3, 56)
  }
};

function maxSlotFixtureFor(kindId: string): StoryCardSlots {
  const fixture = maxSlotFixtures[kindId];

  if (fixture === undefined) {
    throw new Error(
      `No max-slot fixture defined for story-card kind "${kindId}". Add one to maxSlotFixtures.`
    );
  }

  return fixture;
}

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

// For photo-first fast-path: output is raw AI-generated PNG bytes copied
// verbatim. UNC-267: assertCarouselPngDimensions already guards this path to
// CAROUSEL_WIDTH/HEIGHT (1080x1350); this helper only verifies the PNG
// signature to keep this test focused on file/count coverage.
async function expectCarouselPngsAreValid(
  revision: DraftRevision,
  files: string[]
): Promise<void> {
  for (const file of files) {
    const png = await readFile(join(revision.outputDir, file));

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
    slides: options.slides,
    altText: "Uncommitted renderer smoke carousel.",
    metadata: {
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activityLevel: options.activityLevel ?? "medium",
      mood: "grind",
      angle: "Renderer smoke fixture angle.",
      projectIds: ["uncommitted"],
      entryMode: "daily_global",
      slideCount: options.slides.length
    }
  };
}
