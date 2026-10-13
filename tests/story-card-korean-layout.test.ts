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
import { storyCardRegistry, type StoryCardSlots } from "../src/story-card-registry.js";
import type { StoryCardPlan } from "../src/story-card-plan.js";

const PLAYWRIGHT_TEST_TIMEOUT_MS = 60_000;

type NarrativeKind = "typo" | "checkboard" | "modal" | "chat";

// UNC-287: 스모크 테스트는 띄어쓰기 없는 한글 필러로만 슬롯 최대치를 검증한다.
// 실제 카드 문구는 띄어쓰기가 있는 한국어 문장에 허용 영어 토큰(PR, CI,
// TypeScript)이 섞이므로 단어 단위 줄바꿈으로 더 많은 줄을 차지할 수 있다.
// 그 실제 형태를 한도 근처까지 채워 렌더 레이아웃 검증을 통과하는지 종류별로 본다.
// 한도는 레지스트리에 등록된 각 종류의 slots 스키마에서 직접 읽는다 —
// 한도가 재조정되면 이 테스트도 새 한도 기준으로 다시 검증된다.

const koreanFixtures: Record<NarrativeKind, StoryCardSlots> = {
  typo: {
    headline: "커밋은 없는데 바뀐 파일만 열일곱 개나 쌓여 있던 조용한 하루였음 정말로",
    kicker: "작업 트리가 조용히 부풀어 오른 날이었음"
  },
  checkboard: {
    heading: "오늘 끝낸 일과 아직 남아 있는 일을 정리함 PR 전에",
    done: [
      "복구 경로의 버그 두 개를 고치고 테스트까지 붙인 뒤 PR에 정리해 둠",
      "CI가 다시 초록색으로 돌아온 것을 확인하고 로그까지 꼼꼼히 훑어봄"
    ],
    todo: [
      "TypeScript 타입 경고 남은 것들을 하나씩 정리해서 줄이기 시작",
      "리뷰에서 나온 PR 코멘트에 답장 달고 CI 통과 확인까지 마치고 닫기"
    ]
  },
  modal: {
    title: "정말 테스트를 지우고 바로 커밋해 버리실 건가요 지금?",
    body: "지금 지우면 어제 고친 복구 버그가 다시 살아날 수 있습니다. 테스트는 남겨 두고 나머지 정리만 먼저 끝낸 다음 PR을 여는 쪽을 권합니다. CI도 한 번 더 돌려 보고 문제가 없는 것을 확인한 뒤에 계속할까요?",
    primaryAction: "테스트 남기고 계속 진행하기",
    secondaryAction: "다시 한번 더 검토해 보기"
  },
  chat: {
    messages: [
      "개발자: 오늘 커밋은 몇 개였어? 아까부터 파일만 계속 바뀌던데 CI는 괜찮은 거야 지금 확인해 봤어?",
      "나: 커밋은 하나도 없고 바뀐 파일만 열일곱 개야. 다들 정리 중이라고 하더라고 TypeScript 경고도",
      "개발자: 그럼 내일 아침에 한꺼번에 올라오겠네. CI가 놀라지 않았으면 좋겠다 진짜 정말로 말이야 그치?",
      "나: 일단 테스트부터 돌려 보고 PR은 그다음에 열기로 했어. 오늘은 여기까지 하고 쉬는 걸로 하자 응"
    ]
  }
};

function stringsOf(slots: StoryCardSlots): string[] {
  return Object.values(slots).flatMap((value) => (Array.isArray(value) ? value : [value as string]));
}

const fixturePng = await sharp({
  create: { width: 1080, height: 1350, channels: 3, background: "#123456" }
})
  .png()
  .toBuffer();

describe("narrative story-card kinds render realistic Korean sentences", () => {
  it("keeps every fixture within 3 characters below its declared slot limit", () => {
    for (const [type, slots] of Object.entries(koreanFixtures)) {
      const kind = storyCardRegistry.find((candidate) => candidate.id === type);
      expect(kind, `story-card kind "${type}" is registered`).toBeDefined();

      for (const [name, spec] of Object.entries(kind!.slots)) {
        const value = slots[name];
        const limit = spec.maxLength;
        expect(value, `${type}.${name} has a fixture`).toBeDefined();
        expect(limit, `${type}.${name} declares maxLength`).toBeDefined();

        const lines = spec.type === "lines" ? (value as string[]) : [value as string];
        if (spec.type === "lines") {
          expect(Array.isArray(value), `${type}.${name} is a lines slot`).toBe(true);
          expect(lines.length, `${type}.${name} fills maxLines`).toBe(spec.maxLines);
        } else {
          expect(typeof value, `${type}.${name} is a text slot`).toBe("string");
        }

        for (const line of lines) {
          expect(line.length, `${type}.${name} within limit`).toBeLessThanOrEqual(limit!);
          expect(line.length, `${type}.${name} near limit`).toBeGreaterThanOrEqual(limit! - 3);
        }
      }
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
          "Story-card Korean layout tests require Playwright Chromium.",
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
