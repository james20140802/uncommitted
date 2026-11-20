import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  ExportCommandError,
  exportErrorExitCode
} from "../src/export-command.js";
import {
  InstagramMediaError,
  countCaptionHashtags,
  countCaptionMentions,
  prepareInstagramMedia
} from "../src/instagram-media.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const base = join(tmpdir(), `unc-ig-media-test-${randomUUID()}`);
  await mkdir(base, { recursive: true });
  return base;
}

async function makePng(width = 1080, height = 1350, alpha = false): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 18, g: 52, b: 86, alpha: 0.5 } : "#123456"
    }
  })
    .png()
    .toBuffer();
}

type DraftOptions = {
  carouselCount?: number;
  caption?: string;
  safety?: { status: "safe" | "warning" | "blocked"; message?: string } | null;
  metadata?: Record<string, unknown>;
  pngSize?: { width: number; height: number };
};

async function scaffoldDraft(root: string, opts: DraftOptions = {}): Promise<string> {
  const draftPath = join(root, "drafts", "2026-11-20", "rev-001");
  await mkdir(join(draftPath, "carousel"), { recursive: true });

  await writeFile(
    join(draftPath, "caption.txt"),
    opts.caption ?? "오늘은 테스트가 초록불이었다. #uncommitted\n",
    "utf8"
  );
  await writeFile(
    join(draftPath, "metadata.json"),
    JSON.stringify(opts.metadata ?? { schemaVersion: 1, status: "complete" }),
    "utf8"
  );

  if (opts.safety !== null) {
    const safety = opts.safety ?? { status: "safe", message: "Safety check passed." };
    await writeFile(
      join(draftPath, "safety-report.json"),
      JSON.stringify({ schemaVersion: 1, risks: [], redactionsApplied: [], ...safety }),
      "utf8"
    );
  }

  const count = opts.carouselCount ?? 6;
  const png = await makePng(opts.pngSize?.width, opts.pngSize?.height);
  for (let i = 1; i <= count; i++) {
    await writeFile(join(draftPath, "carousel", `${String(i).padStart(2, "0")}.png`), png);
  }

  return draftPath;
}

async function snapshotCarousel(draftPath: string): Promise<Map<string, Buffer>> {
  const dir = join(draftPath, "carousel");
  const snapshot = new Map<string, Buffer>();
  for (const name of await readdir(dir)) {
    snapshot.set(name, await readFile(join(dir, name)));
  }
  return snapshot;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AC1: happy path
// ---------------------------------------------------------------------------

describe("prepareInstagramMedia (UNC-294 AC1: JPEG package)", () => {
  it("turns six 1080x1350 PNGs into six 1080x1350 JPEGs plus the caption, leaving PNGs byte-identical", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root);
    const outputDir = join(root, "publish");
    const before = await snapshotCarousel(draftPath);

    const result = await prepareInstagramMedia({ draftPath, outputDir });

    expect(result.images).toHaveLength(6);
    expect(result.caption).toBe("오늘은 테스트가 초록불이었다. #uncommitted");
    expect(result.safetyStatus).toBe("safe");
    expect(result.warnings).toEqual([]);

    for (const [index, image] of result.images.entries()) {
      expect(image.path).toBe(join(outputDir, `${String(index + 1).padStart(2, "0")}.jpg`));
      expect(image.width).toBe(1080);
      expect(image.height).toBe(1350);

      const bytes = await readFile(image.path);
      expect(image.bytes).toBe(bytes.byteLength);

      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(1080);
      expect(meta.height).toBe(1350);
      expect(meta.space).toBe("srgb");
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
    }

    const after = await snapshotCarousel(draftPath);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, buf] of before) {
      expect(after.get(name)?.equals(buf)).toBe(true);
    }
  });

  it.each([
    ["an ancestor of the draft", (draftPath: string) => join(draftPath, "..")],
    ["the draft itself", (draftPath: string) => draftPath],
    ["inside the draft", (draftPath: string) => join(draftPath, "publish")]
  ])("refuses an outputDir that is %s and leaves the draft untouched", async (_label, pick) => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { carouselCount: 2 });
    const before = await snapshotCarousel(draftPath);

    await expect(
      prepareInstagramMedia({ draftPath, outputDir: pick(draftPath) })
    ).rejects.toThrow(/overlap/i);

    expect(await exists(join(draftPath, "caption.txt"))).toBe(true);
    const after = await snapshotCarousel(draftPath);
    expect([...after.keys()]).toEqual([...before.keys()]);
  });

  it("flattens transparent PNGs instead of failing", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { carouselCount: 2 });
    await writeFile(join(draftPath, "carousel", "01.png"), await makePng(1080, 1350, true));

    const result = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") });

    const meta = await sharp(await readFile(result.images[0].path)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: carousel count
// ---------------------------------------------------------------------------

describe("prepareInstagramMedia (UNC-294 AC2: carousel count)", () => {
  it("rejects an 11-card draft with a count error and writes no package", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { carouselCount: 11 });
    const outputDir = join(root, "publish");

    const error = await prepareInstagramMedia({ draftPath, outputDir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstagramMediaError);
    expect((error as InstagramMediaError).violations).toEqual([
      { constraint: "carousel-count", message: "캐러셀 11장: Instagram은 최대 10장입니다." }
    ]);
    expect(await exists(outputDir)).toBe(false);
  });

  it("rejects a single-card draft as below the carousel minimum", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { carouselCount: 1 });

    const error = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") }).catch(
      (e: unknown) => e
    );

    expect((error as InstagramMediaError).violations[0]?.constraint).toBe("carousel-count");
    expect((error as InstagramMediaError).message).toContain("캐러셀 1장");
  });

  it("rejects cards that are not 1080x1350", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { carouselCount: 2, pngSize: { width: 1080, height: 1080 } });

    const error = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") }).catch(
      (e: unknown) => e
    );

    expect((error as InstagramMediaError).violations.map((v) => v.constraint)).toEqual([
      "image-dimensions",
      "image-dimensions"
    ]);
    expect((error as InstagramMediaError).message).toContain("01.png 1080x1080");
  });
});

// ---------------------------------------------------------------------------
// AC3: caption limits
// ---------------------------------------------------------------------------

describe("prepareInstagramMedia (UNC-294 AC3: caption limits)", () => {
  it("rejects a 2,201-character caption naming the length limit", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { caption: "가".repeat(2201) });
    const outputDir = join(root, "publish");

    const error = await prepareInstagramMedia({ draftPath, outputDir }).catch((e: unknown) => e);

    expect((error as InstagramMediaError).violations).toEqual([
      { constraint: "caption-length", message: "캡션 2,201자: Instagram은 최대 2,200자입니다." }
    ]);
    expect(await exists(outputDir)).toBe(false);
  });

  it("accepts exactly 2,200 characters", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { caption: "가".repeat(2200), carouselCount: 2 });

    const result = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") });
    expect(result.caption).toHaveLength(2200);
  });

  it("rejects 31 hashtags naming the hashtag limit", async () => {
    const root = await createTempDir();
    const tags = Array.from({ length: 31 }, (_, i) => `#태그${i}`).join(" ");
    const draftPath = await scaffoldDraft(root, { caption: `오늘의 일기 ${tags}` });

    const error = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") }).catch(
      (e: unknown) => e
    );

    expect((error as InstagramMediaError).violations).toEqual([
      { constraint: "caption-hashtags", message: "해시태그 31개: Instagram은 최대 30개입니다." }
    ]);
  });

  it("rejects 21 mentions naming the mention limit", async () => {
    const root = await createTempDir();
    const mentions = Array.from({ length: 21 }, (_, i) => `@user_${i}`).join(" ");
    const draftPath = await scaffoldDraft(root, { caption: `고마운 사람들 ${mentions}` });

    const error = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") }).catch(
      (e: unknown) => e
    );

    expect((error as InstagramMediaError).violations).toEqual([
      { constraint: "caption-mentions", message: "멘션 21개: Instagram은 최대 20개입니다." }
    ]);
  });

  it("counts hashtags and mentions without matching mid-word symbols", () => {
    expect(countCaptionHashtags("#one #둘 a#b C# &#39; #")).toBe(2);
    expect(countCaptionMentions("@alice hi @bob.k a@b.com")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC4: safety policy reuse
// ---------------------------------------------------------------------------

describe("prepareInstagramMedia (UNC-294 AC4: safety policy)", () => {
  it("rejects a blocked draft with the export message and exit code 6", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, { safety: { status: "blocked", message: "secret" } });
    const outputDir = join(root, "publish");

    const error = await prepareInstagramMedia({ draftPath, outputDir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExportCommandError);
    expect((error as ExportCommandError).code).toBe("safety-blocked");
    expect((error as ExportCommandError).message).toBe(
      "Export blocked: draft contains sensitive content. Review safety-report.json."
    );
    expect(exportErrorExitCode(error as ExportCommandError)).toBe(6);
    expect(await exists(outputDir)).toBe(false);
  });

  it("returns the package together with the warning for a warning draft", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, {
      carouselCount: 2,
      safety: { status: "warning", message: "Redacted 1 private URL." }
    });

    const result = await prepareInstagramMedia({ draftPath, outputDir: join(root, "publish") });

    expect(result.safetyStatus).toBe("warning");
    expect(result.warnings).toEqual(["Safety warning: Redacted 1 private URL."]);
    expect(result.images).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC5: incomplete draft
// ---------------------------------------------------------------------------

describe("prepareInstagramMedia (UNC-294 AC5: incomplete draft)", () => {
  it("rejects a draft whose metadata status is incomplete", async () => {
    const root = await createTempDir();
    const draftPath = await scaffoldDraft(root, {
      metadata: { schemaVersion: 1, status: "incomplete", incomplete: { stage: "caption" } }
    });
    const outputDir = join(root, "publish");

    const error = await prepareInstagramMedia({ draftPath, outputDir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExportCommandError);
    expect((error as ExportCommandError).code).toBe("incomplete-draft");
    expect(await exists(outputDir)).toBe(false);
  });
});
