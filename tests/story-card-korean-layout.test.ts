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
import { createDraftRevision, type DraftRevision } from "../src/draft-storage.js";
import type { DiaryDraft, DiarySlide } from "../src/diary-generator.js";
import type { StoryCardSlots } from "../src/story-card-registry.js";
import type { StoryCardPlan } from "../src/story-card-plan.js";

const PLAYWRIGHT_TEST_TIMEOUT_MS = 60_000;

type NarrativeKind = "typo" | "checkboard" | "modal" | "chat";

// UNC-287: 스모크 테스트는 띄어쓰기 없는 한글 필러로만 슬롯 최대치를 검증한다.
// 실제 카드 문구는 띄어쓰기가 있는 한국어 문장에 허용 영어 토큰(PR, CI,
// TypeScript)이 섞이므로 단어 단위 줄바꿈으로 더 많은 줄을 차지할 수 있다.
// 그 실제 형태를 한도 근처까지 채워 렌더 레이아웃 검증을 통과하는지 종류별로 본다.
// 한도는 src/story-card-kind-{typo,checkboard,modal,chat}.ts slots 스키마 값.
const limits = {
  typo: { headline: 40, kicker: 24 },
  checkboard: { heading: 32, lines: 40, maxLines: 2 },
  modal: { title: 32, body: 120, primaryAction: 16, secondaryAction: 16 },
  chat: { lines: 60, maxLines: 4 }
};

const koreanFixtures: Record<NarrativeKind, StoryCardSlots> = {
  typo: {
    headline: "커밋은 없고 바뀐 파일만 열일곱 개 쌓인 하루였음",
    kicker: "작업 트리가 조용히 부풀었다"
  },
  checkboard: {
    heading: "오늘 끝낸 일과 아직 남은 일을 정리함",
    done: [
      "복구 경로의 버그 두 개를 고치고 테스트까지 붙임",
      "CI가 다시 초록색으로 돌아온 것을 확인함"
    ],
    todo: [
      "TypeScript 타입 경고 남은 것들을 하나씩 정리하기",
      "리뷰에서 나온 PR 코멘트에 답장 달고 마무리하기"
    ]
  },
  modal: {
    title: "정말 테스트를 지우고 커밋할까요?",
    body: "지금 지우면 어제 고친 복구 버그가 다시 살아날 수 있습니다. 테스트는 남겨 두고 나머지 정리만 먼저 끝내는 쪽을 권합니다. 계속할까요?",
    primaryAction: "테스트 남기고 계속",
    secondaryAction: "다시 검토하기"
  },
  chat: {
    messages: [
      "개발자: 오늘 커밋은 몇 개였어? 아까부터 파일만 계속 바뀌던데",
      "나: 커밋은 없고 바뀐 파일만 열일곱 개야. 다들 정리 중이래",
      "개발자: 그럼 내일 한꺼번에 올라오겠네. CI가 놀라지 않았으면",
      "나: 테스트부터 돌려 보고 PR은 그다음에 열기로 했어"
    ]
  }
};

function stringsOf(slots: StoryCardSlots): string[] {
  return Object.values(slots).flatMap((value) => (Array.isArray(value) ? value : [value as string]));
}

describe("narrative story-card kinds render realistic Korean sentences", () => {
  it("keeps every fixture within the declared slot limits", () => {
    const { typo, checkboard, modal, chat } = koreanFixtures;

    expect((typo.headline as string).length).toBeLessThanOrEqual(limits.typo.headline);
    expect((typo.kicker as string).length).toBeLessThanOrEqual(limits.typo.kicker);
    expect((checkboard.heading as string).length).toBeLessThanOrEqual(limits.checkboard.heading);
    for (const key of ["done", "todo"]) {
      const lines = checkboard[key] as string[];
      expect(lines.length).toBeLessThanOrEqual(limits.checkboard.maxLines);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(limits.checkboard.lines);
      }
    }
    expect((modal.title as string).length).toBeLessThanOrEqual(limits.modal.title);
    expect((modal.body as string).length).toBeLessThanOrEqual(limits.modal.body);
    expect((modal.primaryAction as string).length).toBeLessThanOrEqual(limits.modal.primaryAction);
    expect((modal.secondaryAction as string).length).toBeLessThanOrEqual(limits.modal.secondaryAction);
    const messages = chat.messages as string[];
    expect(messages.length).toBeLessThanOrEqual(limits.chat.maxLines);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(limits.chat.lines);
    }
  });

  it.each(["typo", "checkboard", "modal", "chat"] as const)(
    "renders a spaced Korean %s card into a 1080x1350 PNG without layout overflow",
    { timeout: PLAYWRIGHT_TEST_TIMEOUT_MS },
    async (type) => {
      await assertPlaywrightChromiumAvailable();

      const slots = koreanFixtures[type];
      const revision = await createTestRevision(`uncommitted-korean-${type}-`);
      const story = createStoryDraft({
        slides: [
          {
            index: 1,
            title: `Korean sentence layout check: ${type}`,
            body: `Slide 1 carries a realistic Korean ${type} card.`,
            visualMood: "story-card-like korean layout coverage"
          }
        ]
      });
      const plan: StoryCardPlan = {
        schemaVersion: 1,
        cards: [{ type, slots, source: "generated" }]
      };

      const cards = createCarouselHtmlCards(story, {
        visualStyle: "story-card",
        storyCardPlan: plan
      });
      const visualAssets = await writeVisualAssets(revision, cards.length);

      // renderCarouselPngs runs the base/tight/compact fit fallbacks and
      // throws when .card-stage still overflows after the last one.
      const result = await renderCarouselPngs({ revision, cards, visualAssets });

      expect(result.files).toEqual(["carousel/01.png"]);
      const png = await readFile(join(revision.outputDir, result.files[0]));
      expect(readPngDimensions(png)).toEqual({ width: 1080, height: 1350 });

      const html = cards[0].html;
      expect(html).toContain(`data-story-card-kind="${type}"`);

      for (const value of stringsOf(slots)) {
        if (type === "chat") {
          // chat lines are rendered as `speaker: message` split on the first ": ".
          const separator = value.indexOf(": ");
          expect(html).toContain(value.slice(0, separator));
          expect(html).toContain(value.slice(separator + 2));
        } else {
          expect(html).toContain(value);
        }
      }
    }
  );
});

const fixturePng = await sharp({
  create: { width: 1080, height: 1350, channels: 3, background: "#123456" }
})
  .png()
  .toBuffer();

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

function readPngDimensions(png: Buffer): { width: number; height: number } {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
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
