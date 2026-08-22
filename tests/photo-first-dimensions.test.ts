import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CAROUSEL_HEIGHT, CAROUSEL_WIDTH } from "../src/carousel-dimensions.js";
import { assertCarouselPngDimensions } from "../src/carousel-renderer.js";
import { normaliseCarouselAsset } from "../src/visual-assets.js";

describe("carousel dimensions (UNC-267)", () => {
  it("declares the Instagram-recommended 4:5 frame", () => {
    expect([CAROUSEL_WIDTH, CAROUSEL_HEIGHT]).toEqual([1080, 1350]);
  });
});

describe("photo-first asset normalisation (UNC-267 / parent AC5)", () => {
  it("normalises a 1024x1536 provider response to 1080x1350", async () => {
    const providerPng = await sharp({
      create: {
        width: 1024,
        height: 1536,
        channels: 3,
        background: { r: 20, g: 80, b: 120 }
      }
    })
      .png()
      .toBuffer();

    const normalised = await normaliseCarouselAsset(new Uint8Array(providerPng));
    const metadata = await sharp(Buffer.from(normalised)).metadata();

    expect(metadata.width).toBe(CAROUSEL_WIDTH);
    expect(metadata.height).toBe(CAROUSEL_HEIGHT);
  });
});

describe("raw-copy dimension guard (UNC-267)", () => {
  it("accepts a correctly sized asset", async () => {
    const png = await sharp({
      create: { width: 1080, height: 1350, channels: 3, background: "#123456" }
    })
      .png()
      .toBuffer();

    await expect(assertCarouselPngDimensions(new Uint8Array(png))).resolves.toBeUndefined();
  });

  it("rejects a legacy 1024x1280 asset", async () => {
    const png = await sharp({
      create: { width: 1024, height: 1280, channels: 3, background: "#123456" }
    })
      .png()
      .toBuffer();

    await expect(assertCarouselPngDimensions(new Uint8Array(png))).rejects.toThrow();
  });
});
