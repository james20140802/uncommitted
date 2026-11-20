import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { CAROUSEL_HEIGHT, CAROUSEL_WIDTH } from "./carousel-dimensions.js";
import {
  ExportCommandError,
  assertDraftIsComplete,
  checkSafetyPolicy,
  collectCarouselPngs,
  readSafetyInfo
} from "./export-command.js";
import type { SafetyStatus } from "./safety-report.js";

/**
 * UNC-294: 드래프트를 Instagram Graph API가 그대로 받는 게시 패키지
 * (JPEG 캐러셀 + 검증된 캡션)로 바꾼다. API를 부르기 전에 로컬에서
 * 거절될 이유를 모두 걸러 낸다. 업로드(UNC-295)와 API 호출(UNC-296)은
 * 이 모듈 밖이다.
 *
 * 수치는 Instagram Content Publishing 문서 기준이다: 캐러셀 2~10장,
 * JPEG만, 장당 8MB, 캡션 2,200자·해시태그 30개·멘션 20개.
 */
export const INSTAGRAM_LIMITS = {
  minCarouselImages: 2,
  maxCarouselImages: 10,
  maxImageBytes: 8 * 1024 * 1024,
  maxCaptionChars: 2200,
  maxHashtags: 30,
  maxMentions: 20,
  jpegQuality: 90
} as const;

export type InstagramConstraint =
  | "carousel-count"
  | "image-dimensions"
  | "image-bytes"
  | "caption-length"
  | "caption-hashtags"
  | "caption-mentions";

export type InstagramViolation = {
  constraint: InstagramConstraint;
  message: string;
};

export class InstagramMediaError extends Error {
  constructor(public readonly violations: InstagramViolation[]) {
    super(violations.map((v) => v.message).join(" "));
    this.name = "InstagramMediaError";
  }
}

export type InstagramMediaImage = {
  path: string;
  width: number;
  height: number;
  bytes: number;
};

export type InstagramMediaPackage = {
  images: InstagramMediaImage[];
  caption: string;
  safetyStatus: SafetyStatus;
  warnings: string[];
};

export type PrepareInstagramMediaOptions = {
  /** 드래프트 revision 폴더 (예: ~/Uncommitted/drafts/2026-11-20/rev-001) */
  draftPath: string;
  /** JPEG를 쓸 폴더. 매번 비우고 다시 만든다. 드래프트 밖이어야 한다. */
  outputDir: string;
};

/**
 * 검사 순서: 미완성 → safety → 장수·규격·캡션 → JPEG 인코딩(메모리) →
 * 용량 → 디스크 기록. 어느 단계에서 거절되든 outputDir에는 아무것도
 * 남지 않고, 드래프트 원본은 읽기만 한다.
 */
export async function prepareInstagramMedia(
  options: PrepareInstagramMediaOptions
): Promise<InstagramMediaPackage> {
  const { draftPath, outputDir } = options;

  // export와 같은 게이트를 같은 함수로 쓴다 (정책 복제 금지).
  const safetyInfo = await readSafetyInfo(draftPath);
  await assertDraftIsComplete(draftPath);
  const policy = checkSafetyPolicy(safetyInfo.status, safetyInfo.reason);

  const pngNames = await collectCarouselPngs(draftPath);
  const caption = await readCaption(draftPath);

  const violations: InstagramViolation[] = [
    ...checkCarouselCount(pngNames.length),
    ...checkCaption(caption)
  ];

  const pngs = await Promise.all(
    pngNames.map((name) => readFile(join(draftPath, "carousel", name)))
  );
  if (violations.every((v) => v.constraint !== "carousel-count")) {
    violations.push(...(await checkDimensions(pngNames, pngs)));
  }
  throwIfAny(violations);

  const jpegs = await Promise.all(pngs.map((png) => encodeJpeg(png)));
  throwIfAny(checkBytes(pngNames, jpegs));

  const images = await writePackage(outputDir, jpegs);

  return {
    images,
    caption,
    safetyStatus: safetyInfo.status,
    warnings: policy.warningMessage ? [policy.warningMessage] : []
  };
}

// ---------------------------------------------------------------------------
// Caption counting
// ---------------------------------------------------------------------------

const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_&#])#[\p{L}\p{N}_]+/gu;
const MENTION_PATTERN = /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9._]+/gu;

export function countCaptionHashtags(caption: string): number {
  return caption.match(HASHTAG_PATTERN)?.length ?? 0;
}

export function countCaptionMentions(caption: string): number {
  return caption.match(MENTION_PATTERN)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkCarouselCount(count: number): InstagramViolation[] {
  const { minCarouselImages: min, maxCarouselImages: max } = INSTAGRAM_LIMITS;
  if (count > max) {
    return [{ constraint: "carousel-count", message: `캐러셀 ${count}장: Instagram은 최대 ${max}장입니다.` }];
  }
  if (count < min) {
    return [{ constraint: "carousel-count", message: `캐러셀 ${count}장: Instagram 캐러셀은 최소 ${min}장입니다.` }];
  }
  return [];
}

function checkCaption(caption: string): InstagramViolation[] {
  const violations: InstagramViolation[] = [];
  const length = [...caption].length;
  const hashtags = countCaptionHashtags(caption);
  const mentions = countCaptionMentions(caption);

  if (length > INSTAGRAM_LIMITS.maxCaptionChars) {
    violations.push({
      constraint: "caption-length",
      message: `캡션 ${formatCount(length)}자: Instagram은 최대 ${formatCount(INSTAGRAM_LIMITS.maxCaptionChars)}자입니다.`
    });
  }
  if (hashtags > INSTAGRAM_LIMITS.maxHashtags) {
    violations.push({
      constraint: "caption-hashtags",
      message: `해시태그 ${hashtags}개: Instagram은 최대 ${INSTAGRAM_LIMITS.maxHashtags}개입니다.`
    });
  }
  if (mentions > INSTAGRAM_LIMITS.maxMentions) {
    violations.push({
      constraint: "caption-mentions",
      message: `멘션 ${mentions}개: Instagram은 최대 ${INSTAGRAM_LIMITS.maxMentions}개입니다.`
    });
  }
  return violations;
}

async function checkDimensions(names: string[], pngs: Buffer[]): Promise<InstagramViolation[]> {
  const violations: InstagramViolation[] = [];
  for (const [index, png] of pngs.entries()) {
    const { width, height } = await sharp(png).metadata();
    if (width !== CAROUSEL_WIDTH || height !== CAROUSEL_HEIGHT) {
      violations.push({
        constraint: "image-dimensions",
        message: `${names[index]} ${width}x${height}: Instagram 캐러셀은 모든 장이 ${CAROUSEL_WIDTH}x${CAROUSEL_HEIGHT}(4:5)여야 합니다.`
      });
    }
  }
  return violations;
}

function checkBytes(names: string[], jpegs: Buffer[]): InstagramViolation[] {
  const max = INSTAGRAM_LIMITS.maxImageBytes;
  return jpegs.flatMap((jpeg, index) =>
    jpeg.byteLength > max
      ? [{
          constraint: "image-bytes" as const,
          message: `${names[index]} JPEG ${formatCount(jpeg.byteLength)}바이트: Instagram은 장당 최대 8MB입니다.`
        }]
      : []
  );
}

function throwIfAny(violations: InstagramViolation[]): void {
  if (violations.length > 0) {
    throw new InstagramMediaError(violations);
  }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

async function readCaption(draftPath: string): Promise<string> {
  try {
    return (await readFile(join(draftPath, "caption.txt"), "utf8")).trim();
  } catch {
    throw new ExportCommandError("caption.txt is missing from the draft.", "export-failed");
  }
}

/**
 * JPEG는 알파가 없으므로 흰 배경에 합성한다. sharp는 withMetadata()를
 * 부르지 않으면 EXIF·ICC를 버리므로 메타데이터 제거는 기본 동작이다.
 */
function encodeJpeg(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .jpeg({ quality: INSTAGRAM_LIMITS.jpegQuality, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function writePackage(outputDir: string, jpegs: Buffer[]): Promise<InstagramMediaImage[]> {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const images: InstagramMediaImage[] = [];
  for (const [index, jpeg] of jpegs.entries()) {
    const path = join(outputDir, `${String(index + 1).padStart(2, "0")}.jpg`);
    await writeFile(path, jpeg);
    images.push({ path, width: CAROUSEL_WIDTH, height: CAROUSEL_HEIGHT, bytes: jpeg.byteLength });
  }
  return images;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
