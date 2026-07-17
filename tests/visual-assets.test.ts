import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type {
  AiProviderHttpRequest,
  AiProviderHttpResponse
} from "../src/ai-provider.js";
import { createCarouselHtmlCards } from "../src/carousel-renderer.js";
import { createDraftRevision } from "../src/draft-storage.js";
import {
  createImageAssetProvider,
  createPhotoFirstPrompt,
  generateCarouselVisualAssets,
  VisualAssetGenerationError
} from "../src/visual-assets.js";
import type {
  ImageAssetProvider,
  ImageAssetRequest
} from "../src/visual-assets.js";

describe("visual asset generation", () => {
  it("creates an OpenAI image asset provider that requests a supported 1024x1536 source and returns a 1024x1280 Instagram 4:5 crop", async () => {
    const sourcePng = await sharp({
      create: {
        width: 1024,
        height: 1536,
        channels: 3,
        background: { r: 200, g: 100, b: 50 }
      }
    })
      .png()
      .toBuffer();
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createImageAssetProvider(
      {
        provider: "openai",
        persona: "wry coworker",
        roastLevel: 2
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(calls, {
          data: [
            {
              b64_json: sourcePng.toString("base64")
            }
          ]
        })
      }
    );

    const result = await provider?.generateImageAsset({
      schemaVersion: 1,
      slideIndex: 1,
      assetSlotId: "slide-01-visual",
      prompt: "safe visual prompt",
      promptSummary: "safe visual prompt"
    });

    expect(result?.mimeType).toBe("image/png");
    const returnedMeta = await sharp(Buffer.from(result?.data ?? new Uint8Array())).metadata();
    expect(returnedMeta.width).toBe(1024);
    expect(returnedMeta.height).toBe(1280);

    expect(provider?.name).toBe("openai");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0]?.request.headers.Authorization).toBe("Bearer sk-test-secret");
    expect(calls[0]?.request.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      model?: string;
      prompt?: string;
      n?: number;
      size?: string;
      quality?: string;
      output_format?: string;
    };

    expect(body).toEqual({
      model: "gpt-image-1.5",
      prompt: "safe visual prompt",
      n: 1,
      size: "1024x1536",
      quality: "low",
      output_format: "png"
    });
    expect(calls[0]?.request.body).not.toContain("sk-test-secret");
  });

  it("surfaces crop failure on a non-PNG OpenAI response as a provider-failed error", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createImageAssetProvider(
      {
        provider: "openai",
        persona: "wry coworker",
        roastLevel: 2
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(calls, {
          data: [
            {
              b64_json: Buffer.from("not a real png payload").toString("base64")
            }
          ]
        })
      }
    );

    await expect(
      provider?.generateImageAsset({
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        prompt: "safe visual prompt",
        promptSummary: "safe visual prompt"
      })
    ).rejects.toEqual(
      new VisualAssetGenerationError(
        "Visual generation failed. Check image provider configuration.",
        "provider-failed"
      )
    );
  });

  it("does not create real image adapters for unsupported MVP providers", () => {
    expect(
      createImageAssetProvider({
        provider: "mock",
        persona: "wry coworker",
        roastLevel: 2
      })
    ).toBeUndefined();
  });

  it("fails clearly when OpenAI image credentials are missing", () => {
    expect(() =>
      createImageAssetProvider(
        {
          provider: "openai",
          persona: "wry coworker",
          roastLevel: 2
        },
        { env: {} }
      )
    ).toThrow(
      new VisualAssetGenerationError(
        "OPENAI_API_KEY is not set.",
        "provider-unavailable"
      )
    );
  });

  it("reports a billing-class 429 (insufficient_quota) distinctly, not as a temporary rate limit", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createImageAssetProvider(
      {
        provider: "openai",
        persona: "wry coworker",
        roastLevel: 2
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(
          calls,
          { error: { type: "insufficient_quota" } },
          429
        )
      }
    );

    await expect(
      provider?.generateImageAsset({
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        prompt: "safe visual prompt",
        promptSummary: "safe visual prompt"
      })
    ).rejects.toEqual(
      new VisualAssetGenerationError(
        "AI provider credit/billing quota exhausted. Check your plan and billing details.",
        "provider-failed"
      )
    );
  });

  it("keeps the generic image 429 message verbatim for a plain rate-limit body", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createImageAssetProvider(
      {
        provider: "openai",
        persona: "wry coworker",
        roastLevel: 2
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(
          calls,
          { error: { type: "rate_limit_exceeded" } },
          429
        )
      }
    );

    await expect(
      provider?.generateImageAsset({
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        prompt: "safe visual prompt",
        promptSummary: "safe visual prompt"
      })
    ).rejects.toEqual(
      new VisualAssetGenerationError(
        "Image provider rate limit exceeded. Try again later.",
        "provider-failed"
      )
    );
  });

  it("falls back to the generic image 429 message when the 429 body cannot be parsed", async () => {
    const provider = createImageAssetProvider(
      {
        provider: "openai",
        persona: "wry coworker",
        roastLevel: 2
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: async () => ({
          ok: false,
          status: 429,
          json: async () => {
            throw new Error("not json");
          }
        })
      }
    );

    await expect(
      provider?.generateImageAsset({
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        prompt: "safe visual prompt",
        promptSummary: "safe visual prompt"
      })
    ).rejects.toEqual(
      new VisualAssetGenerationError(
        "Image provider rate limit exceeded. Try again later.",
        "provider-failed"
      )
    );
  });

  it("writes deterministic placeholder PNG assets with stable slide filenames", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft());

    const result = await generateCarouselVisualAssets({
      revision,
      cards,
      fallbackProviderName: "mock"
    });

    expect(result.files).toEqual([
      "visuals/01.png",
      "visuals/02.png",
      "visuals/03.png"
    ]);
    expect(result.assets).toMatchObject([
      {
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        visualStyle: "story-card",
        provider: "mock",
        filePath: "visuals/01.png",
        fallbackState: "image-generation-disabled"
      },
      {
        slideIndex: 2,
        assetSlotId: "slide-02-visual",
        fallbackState: "image-generation-disabled"
      },
      {
        slideIndex: 3,
        assetSlotId: "slide-03-visual",
        fallbackState: "image-generation-disabled"
      }
    ]);

    const firstPng = await readFile(join(revision.outputDir, "visuals", "01.png"));
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
  });

  it("sends only sanitized visual intent to image providers", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(
      createStoryDraft({
        slides: [
          {
            index: 1,
            title: "Sensitive",
            body: "Do not leak visual input.",
            visualMood:
              "terminal near dev@example.com /Users/dev/private OPENAI_API_KEY=sk-live-secret123 `const token = process.env.SECRET`"
          }
        ]
      }),
      { visualStyle: "photo-first" }
    );
    const provider = new RecordingImageProvider();

    const result = await generateCarouselVisualAssets({
      revision,
      cards,
      provider,
      fallbackProviderName: "mock"
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.prompt).toContain("4:5 editorial photo");
    expect(provider.requests[0]?.prompt).toContain("Instagram photo dump");
    expect(provider.requests[0]?.prompt).toContain("No readable text");
    expect(provider.requests[0]?.prompt).toContain("no code");
    expect(provider.requests[0]?.prompt).toContain("no UI screenshots");
    expect(provider.requests[0]?.prompt).toContain("no logos");
    expect(provider.requests[0]?.prompt).toContain("no people faces");
    expect(provider.requests[0]?.prompt).toContain("no private URLs");
    expect(provider.requests[0]?.prompt).toContain("[redacted-email]");
    expect(provider.requests[0]?.prompt).toContain("[redacted-path]");
    expect(provider.requests[0]?.prompt).toContain("[redacted-secret]");
    expect(provider.requests[0]?.prompt).toContain("[redacted-code]");
    expect(provider.requests[0]?.prompt).not.toContain("dev@example.com");
    expect(provider.requests[0]?.prompt).not.toContain("/Users/dev/private");
    expect(provider.requests[0]?.prompt).not.toContain("OPENAI_API_KEY");
    expect(provider.requests[0]?.prompt).not.toContain("sk-live-secret123");
    expect(provider.requests[0]?.prompt).not.toContain("process.env.SECRET");
    expect(result.assets[0]).toMatchObject({
      provider: "fixture-image",
      fallbackState: "none",
      visualStyle: "photo-first",
      promptSummary:
        "terminal near [redacted-email] [redacted-path] [redacted-secret] [redacted-code]"
    });
  });

  it("redacts architecture-disclosure detail from the image prompt and prompt summary (UNC-206)", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(
      createStoryDraft({
        slides: [
          {
            index: 1,
            title: "Sensitive",
            body: "Do not leak visual input.",
            visualMood:
              "route guard admin allowlist server-side authorization glowing on a terminal"
          }
        ]
      }),
      { visualStyle: "photo-first" }
    );
    const provider = new RecordingImageProvider();

    const result = await generateCarouselVisualAssets({
      revision,
      cards,
      provider,
      fallbackProviderName: "mock"
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.prompt).not.toContain("route guard");
    expect(provider.requests[0]?.prompt).not.toContain("admin allowlist");
    expect(provider.requests[0]?.prompt).not.toContain(
      "server-side authorization"
    );
    expect(provider.requests[0]?.prompt).toContain("[redacted-architecture]");
    expect(provider.requests[0]?.promptSummary).not.toContain("route guard");
    expect(provider.requests[0]?.promptSummary).not.toContain(
      "admin allowlist"
    );
    expect(provider.requests[0]?.promptSummary).not.toContain(
      "server-side authorization"
    );
    expect(result.assets[0]?.promptSummary).not.toContain("route guard");
    expect(result.assets[0]?.promptSummary).not.toContain("admin allowlist");
  });

  it("does not call hosted image providers for story-card mode", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft(), {
      visualStyle: "story-card"
    });
    const provider = new RecordingImageProvider();

    const result = await generateCarouselVisualAssets({
      revision,
      cards: [cards[0]],
      provider,
      fallbackProviderName: "mock"
    });

    expect(provider.requests).toHaveLength(0);
    expect(result.assets[0]).toMatchObject({
      visualStyle: "story-card",
      provider: "mock",
      fallbackState: "image-generation-disabled",
      filePath: "visuals/01.png"
    });
  });

  it("preserves existing draft artifacts when an image provider fails", async () => {
    const revision = await createTestRevision();
    const cards = createCarouselHtmlCards(createStoryDraft(), {
      visualStyle: "photo-first"
    });
    const preservedArtifact = join(revision.outputDir, "story.json");

    await mkdir(revision.outputDir, { recursive: true });
    await writeFile(preservedArtifact, "{\"schemaVersion\":1}\n", "utf8");

    await expect(
      generateCarouselVisualAssets({
        revision,
        cards,
        provider: new FailingImageProvider(),
        fallbackProviderName: "mock"
      })
    ).rejects.toEqual(
      new VisualAssetGenerationError(
        "Visual generation failed. Check image provider configuration.",
        "provider-failed"
      )
    );
    await expect(readFile(preservedArtifact, "utf8")).resolves.toBe(
      "{\"schemaVersion\":1}\n"
    );
  });
});

class RecordingImageProvider implements ImageAssetProvider {
  readonly name = "fixture-image";
  readonly requests: ImageAssetRequest[] = [];

  async generateImageAsset(request: ImageAssetRequest) {
    this.requests.push(request);

    return {
      mimeType: "image/png" as const,
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64"
      )
    };
  }
}

class FailingImageProvider implements ImageAssetProvider {
  readonly name = "fixture-image";

  async generateImageAsset(): Promise<never> {
    throw new Error("remote image API failed with detailed provider trace");
  }
}

function createTransport(
  calls: Array<{ url: string; request: AiProviderHttpRequest }>,
  body: unknown,
  status = 200
) {
  return async (
    url: string,
    request: AiProviderHttpRequest
  ): Promise<AiProviderHttpResponse> => {
    calls.push({ url, request });

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  };
}

describe("createPhotoFirstPrompt grounding (UNC-217)", () => {
  it("grounds the prompt in the day's anchor summary when no structured mood is given", () => {
    const prompt = createPhotoFirstPrompt("migrating the feedback store to mood fields");

    expect(prompt).toContain("migrating the feedback store to mood fields");
    // 회전형 고정 장르 코스튬 문구가 제거되었다
    expect(prompt).not.toContain("aftermath shot");
  });

  it("injects structured mood tone, energy, and anchor keywords when provided", () => {
    const prompt = createPhotoFirstPrompt("debugging a flaky test", {
      tone: "quiet",
      energy: "low",
      anchorKeywords: ["flaky test", "terminal logs"]
    });

    expect(prompt).toContain("quiet");
    expect(prompt).toContain("low");
    expect(prompt).toContain("flaky test");
    expect(prompt).toContain("terminal logs");
  });

  it("still forbids readable text, code, faces, and secrets in the image", () => {
    const prompt = createPhotoFirstPrompt("anything");
    expect(prompt.toLowerCase()).toContain("no readable text");
  });
});

async function createTestRevision() {
  const draftRoot = join(tmpdir(), `uncommitted-visual-assets-${randomUUID()}`);

  await mkdir(draftRoot, { recursive: true });

  return await createDraftRevision({
    draftRoot,
    targetDate: "2026-05-20"
  });
}

function createStoryDraft(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-20",
    title: "Visual Asset Day",
    caption: "Images stay local.",
    slides: [
      {
        index: 1,
        title: "Signal",
        body: "Visual intent gets a local asset slot.",
        visualMood: "compact terminal summary"
      },
      {
        index: 2,
        title: "Asset",
        body: "Stable filenames keep rendering predictable.",
        visualMood: "paper cards on a desk"
      },
      {
        index: 3,
        title: "Fallback",
        body: "Unsupported image providers get placeholders.",
        visualMood: "quiet placeholder frame"
      }
    ],
    hashtags: ["#Uncommitted"],
    altText: "Uncommitted carousel visual asset draft.",
    metadata: {
      projectIds: ["uncommitted"]
    },
    ...overrides
  };
}
