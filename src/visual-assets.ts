import process from "node:process";
import sharp from "sharp";
import type {
  AiProviderConfig,
  AiProviderHttpRequest,
  AiProviderHttpResponse,
  AiProviderHttpTransport,
  AiProviderName
} from "./ai-provider.js";
import type {
  CarouselHtmlCard,
  CarouselVisualStyleMode
} from "./carousel-renderer.js";
import {
  type DraftRevision,
  DraftStorageError,
  writeDraftArtifactBinary
} from "./draft-storage.js";
import { checkDraftSafety } from "./safety-report.js";

export type VisualAssetFallbackState =
  | "none"
  | "no-provider"
  | "provider-unsupported"
  | "image-generation-disabled"
  | "provider-failed";

export type VisualAssetGenerationErrorCode =
  | "provider-failed"
  | "provider-unavailable"
  | "write-failed";

export class VisualAssetGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: VisualAssetGenerationErrorCode
  ) {
    super(message);
    this.name = "VisualAssetGenerationError";
  }
}

export type ImageAssetRequest = {
  schemaVersion: 1;
  slideIndex: number;
  assetSlotId: string;
  prompt: string;
  promptSummary: string;
};

export type ImageAssetProviderResult = {
  mimeType: "image/png";
  data: Uint8Array;
};

export interface ImageAssetProvider {
  readonly name: string;
  generateImageAsset(
    request: ImageAssetRequest
  ): Promise<ImageAssetProviderResult>;
}

export type VisualAssetMetadata = {
  schemaVersion: 1;
  slideIndex: number;
  assetSlotId: string;
  visualStyle: CarouselVisualStyleMode;
  promptSummary: string;
  provider: string;
  filePath: string;
  fallbackState: VisualAssetFallbackState;
};

export type VisualAssetGenerationResult = {
  schemaVersion: 1;
  files: string[];
  assets: VisualAssetMetadata[];
};

export type GenerateCarouselVisualAssetsOptions = {
  revision: DraftRevision;
  cards: CarouselHtmlCard[];
  provider?: ImageAssetProvider;
  fallbackProviderName: AiProviderName | string;
  fallbackState?: VisualAssetFallbackState;
};

export type CreateImageAssetProviderOptions = {
  env?: Record<string, string | undefined>;
  transport?: AiProviderHttpTransport;
  timeoutMs?: number;
};

const openAiImageEndpoint = "https://api.openai.com/v1/images/generations";
const openAiImageEnvKey = "OPENAI_API_KEY";
const openAiImageModel = "gpt-image-1.5";
const openAiImageRequestSize = "1024x1536";
const openAiImageRequestHeight = 1536;
const carouselTargetWidth = 1024;
const carouselTargetHeight = 1280;
const defaultImageProviderTimeoutMs = 300_000;
const providerTimeoutEnvKey = "UNCOMMITTED_AI_TIMEOUT_MS";
const placeholderPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

export function createImageAssetProvider(
  config: AiProviderConfig,
  options: CreateImageAssetProviderOptions = {}
): ImageAssetProvider | undefined {
  if (config.provider !== "openai") {
    return undefined;
  }

  const apiKey = resolveEnvValue(options, openAiImageEnvKey);

  if (!apiKey) {
    throw new VisualAssetGenerationError(
      `${openAiImageEnvKey} is not set.`,
      "provider-unavailable"
    );
  }

  return new OpenAiImageAssetProvider({
    apiKey,
    timeoutMs: resolveProviderTimeoutMs(options),
    transport: options.transport ?? defaultFetchTransport
  });
}

export async function generateCarouselVisualAssets(
  options: GenerateCarouselVisualAssetsOptions
): Promise<VisualAssetGenerationResult> {
  const assets: VisualAssetMetadata[] = [];
  const files: string[] = [];

  for (const [index, card] of options.cards.entries()) {
    const fileName = `visuals/${String(index + 1).padStart(2, "0")}.png`;
    const request = createImageAssetRequest(card);
    const provider =
      card.visualStyle === "photo-first" ? options.provider : undefined;
    const image = provider
      ? await generateProviderImage(provider, request)
      : {
          mimeType: "image/png" as const,
          data: placeholderPng
        };

    try {
      await writeDraftArtifactBinary(options.revision, fileName, image.data);
    } catch (error) {
      if (error instanceof DraftStorageError) {
        throw new VisualAssetGenerationError(
          error.message,
          "write-failed"
        );
      }

      throw error;
    }

    files.push(fileName);
    assets.push({
      schemaVersion: 1,
      slideIndex: card.slideIndex,
      assetSlotId: card.visualTreatment.assetSlotId,
      visualStyle: card.visualStyle,
      promptSummary: request.promptSummary,
      provider: provider?.name ?? options.fallbackProviderName,
      filePath: fileName,
      fallbackState: provider
        ? "none"
        : deriveFallbackState({
            card,
            fallbackProviderName: options.fallbackProviderName,
            fallbackState: options.fallbackState
          })
    });
  }

  return {
    schemaVersion: 1,
    files,
    assets
  };
}

function createImageAssetRequest(card: CarouselHtmlCard): ImageAssetRequest {
  const promptSummary = sanitizeVisualPrompt(card.visualTreatment.prompt);
  const prompt =
    card.visualStyle === "photo-first"
      ? createPhotoFirstPrompt(promptSummary)
      : createStoryCardPrompt(promptSummary);

  return {
    schemaVersion: 1,
    slideIndex: card.slideIndex,
    assetSlotId: card.visualTreatment.assetSlotId,
    promptSummary,
    prompt
  };
}

function createPhotoFirstPrompt(promptSummary: string): string {
  return [
    "Create a natural 4:5 editorial photo for an Instagram photo dump.",
    "Use cinematic but casual workspace mood, detail shot, aftermath shot, desk object, or quiet developer environment language.",
    "No readable text, no code, no UI screenshots, no logos, no people faces, no file paths, no emails, no tokens, and no private URLs.",
    "Not a poster, not an infographic, not an explanatory card, and not a text-overlay concept.",
    `Visual intent: ${promptSummary}`
  ].join("\n");
}

function createStoryCardPrompt(promptSummary: string): string {
  return [
    "Create a 4:5 local visual treatment for an Uncommitted story-card carousel.",
    "Use abstract UI objects, terminals, notes, browser frames, charts, or desk objects.",
    "Do not include readable secrets, raw code, private URLs, emails, tokens, logos, UI screenshots, or local file paths.",
    `Visual intent: ${promptSummary}`
  ].join("\n");
}

function sanitizeVisualPrompt(value: string): string {
  const safetyChecked = checkDraftSafety(value).redactedText;
  const codeRedacted = safetyChecked
    .replace(/`[^`]*`/g, "[redacted-code]")
    .replace(/\bdiff --git\b[\s\S]*/gi, "[redacted-code]")
    .replace(
      /\b(?:const|let|var|function|class|import|export)\s+[^.;\n]+[;]?/g,
      "[redacted-code]"
    )
    .replace(/\bprocess\.env\.[A-Z0-9_]+\b/gi, "[redacted-secret]")
    .replace(/`/g, "");
  const normalized = codeRedacted.replace(/\s+/g, " ").trim();

  return normalized.length > 0 ? normalized.slice(0, 280) : "abstract workday";
}

class OpenAiImageAssetProvider implements ImageAssetProvider {
  readonly name = "openai";

  constructor(
    private readonly options: {
      apiKey: string;
      timeoutMs: number;
      transport: AiProviderHttpTransport;
    }
  ) {}

  async generateImageAsset(
    request: ImageAssetRequest
  ): Promise<ImageAssetProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.options.transport(openAiImageEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: openAiImageModel,
          prompt: request.prompt,
          n: 1,
          size: openAiImageRequestSize,
          quality: "low",
          output_format: "png"
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throwOpenAiImageHttpError(response.status);
      }

      return {
        mimeType: "image/png",
        data: await cropToInstagramFourFive(
          decodeOpenAiImageResponse(await readResponseJson(response))
        )
      };
    } catch (error) {
      if (error instanceof VisualAssetGenerationError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new VisualAssetGenerationError(
          "Visual generation timed out. Try again later.",
          "provider-failed"
        );
      }

      throw new VisualAssetGenerationError(
        "Visual generation failed. Check image provider configuration.",
        "provider-failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function generateProviderImage(
  provider: ImageAssetProvider,
  request: ImageAssetRequest
): Promise<ImageAssetProviderResult> {
  try {
    const result = await provider.generateImageAsset(request);

    if (result.mimeType !== "image/png") {
      throw new VisualAssetGenerationError(
        "Visual generation failed. Check image provider configuration.",
        "provider-failed"
      );
    }

    return result;
  } catch (error) {
    if (error instanceof VisualAssetGenerationError) {
      throw error;
    }

    throw new VisualAssetGenerationError(
      "Visual generation failed. Check image provider configuration.",
      "provider-failed"
    );
  }
}

async function defaultFetchTransport(
  url: string,
  request: AiProviderHttpRequest
): Promise<AiProviderHttpResponse> {
  return await fetch(url, request);
}

async function readResponseJson(
  response: AiProviderHttpResponse
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new VisualAssetGenerationError(
      "Image provider returned invalid response.",
      "provider-failed"
    );
  }
}

// OpenAI's image API does not accept 1024x1280 as a `size`; the closest
// supported 4:5-ish value is 1024x1536. Center-crop the response down to the
// Instagram 4:5 frame the carousel expects.
async function cropToInstagramFourFive(png: Uint8Array): Promise<Uint8Array> {
  try {
    const top = Math.floor((openAiImageRequestHeight - carouselTargetHeight) / 2);
    const buffer = await sharp(Buffer.from(png))
      .extract({
        left: 0,
        top,
        width: carouselTargetWidth,
        height: carouselTargetHeight
      })
      .png()
      .toBuffer();

    return new Uint8Array(buffer);
  } catch {
    throw new VisualAssetGenerationError(
      "Visual generation failed. Check image provider configuration.",
      "provider-failed"
    );
  }
}

function decodeOpenAiImageResponse(value: unknown): Uint8Array {
  if (!isOpenAiImageResponse(value)) {
    throw new VisualAssetGenerationError(
      "Image provider returned invalid response.",
      "provider-failed"
    );
  }

  return Buffer.from(value.data[0].b64_json, "base64");
}

function throwOpenAiImageHttpError(status: number): never {
  if (status === 401 || status === 403) {
    throw new VisualAssetGenerationError(
      "Image provider authentication failed. Check API key.",
      "provider-failed"
    );
  }

  if (status === 408 || status === 504) {
    throw new VisualAssetGenerationError(
      "Visual generation timed out. Try again later.",
      "provider-failed"
    );
  }

  if (status === 429) {
    throw new VisualAssetGenerationError(
      "Image provider rate limit exceeded. Try again later.",
      "provider-failed"
    );
  }

  throw new VisualAssetGenerationError(
    "Visual generation failed. Check image provider configuration.",
    "provider-failed"
  );
}

function resolveProviderTimeoutMs(
  options: CreateImageAssetProviderOptions
): number {
  if (options.timeoutMs !== undefined) {
    return assertPositiveIntegerTimeout(options.timeoutMs);
  }

  const timeoutValue = resolveEnvValue(options, providerTimeoutEnvKey);

  if (timeoutValue === undefined || timeoutValue.trim() === "") {
    return defaultImageProviderTimeoutMs;
  }

  return assertPositiveIntegerTimeout(Number(timeoutValue));
}

function assertPositiveIntegerTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new VisualAssetGenerationError(
      `${providerTimeoutEnvKey} must be a positive integer.`,
      "provider-failed"
    );
  }

  return value;
}

function resolveEnvValue(
  options: CreateImageAssetProviderOptions,
  key: string
): string | undefined {
  return options.env === undefined ? process.env[key] : options.env[key];
}

function deriveFallbackState(options: {
  card: CarouselHtmlCard;
  fallbackProviderName: AiProviderName | string;
  fallbackState?: VisualAssetFallbackState;
}): VisualAssetFallbackState {
  if (options.fallbackState) {
    return options.fallbackState;
  }

  if (options.card.visualStyle === "story-card") {
    return "image-generation-disabled";
  }

  return options.fallbackProviderName === "none"
    ? "no-provider"
    : "provider-unsupported";
}

function isOpenAiImageResponse(value: unknown): value is {
  data: [{ b64_json: string }];
} {
  return (
    isRecord(value) &&
    Array.isArray(value.data) &&
    isRecord(value.data[0]) &&
    typeof value.data[0].b64_json === "string" &&
    value.data[0].b64_json.trim().length > 0
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
