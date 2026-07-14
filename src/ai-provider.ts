import process from "node:process";
import { resolveConfigPaths } from "./config-paths.js";
import { isRoastLevel, loadGlobalConfig } from "./global-config.js";
import { isPersona, selectPersona } from "./persona.js";
import { emailPattern } from "./redaction.js";
import { isRecord } from "./type-guards.js";
import {
  BILLING_429_MESSAGE,
  classify429ResponseBody
} from "./provider-429-classifier.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AiProviderName =
  | "none"
  | "mock"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "mistral"
  | "openrouter";

export type AiGenerationTask = "story-plan" | "caption" | "draft";

export type SafeProjectSummary = {
  projectId: string;
  projectName: string;
  summary: string;
  stats: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
    dirtyFiles: number;
  };
};

export type SafeActivitySummary = {
  schemaVersion: 1;
  targetDate: string;
  quiet: boolean;
  overview: string;
  highlights: string[];
  projectSummaries: SafeProjectSummary[];
  [key: string]: JsonValue;
};

export type AiGenerationRequestOptions = {
  task: AiGenerationTask;
  instructions: string;
  summary: SafeActivitySummary;
};

export type AiStructuredGenerationRequest = {
  schemaVersion: 1;
  task: AiGenerationTask;
  instructions: string;
  input: SafeActivitySummary;
};

export type AiProviderRawResponse = {
  responseJson: string;
};

export type AiStructuredGenerationResponse<
  TData extends JsonObject = JsonObject
> = {
  schemaVersion: 1;
  provider: AiProviderName;
  data: TData;
};

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model?: string;
  generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse>;
}

export type AiProviderConfig = {
  provider: AiProviderName;
  persona: string;
  roastLevel: number;
};

export type LoadAiProviderConfigOptions = {
  homeDir?: string;
};

export type MockAiProviderOptions = {
  responseJson?: string;
  response?: JsonObject;
  failure?: Error;
};

export type CreateAiProviderOptions = {
  mockResponseJson?: string;
  env?: Record<string, string | undefined>;
  transport?: AiProviderHttpTransport;
  timeoutMs?: number;
};

export type AiProviderHttpRequest = {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};

export type AiProviderHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type AiProviderHttpTransport = (
  url: string,
  request: AiProviderHttpRequest
) => Promise<AiProviderHttpResponse>;

type OpenAiCompatibleProviderName = "openai" | "openrouter";

type OpenAiCompatibleProviderMetadata = {
  name: OpenAiCompatibleProviderName;
  endpoint: string;
  envKey: string;
  model: string;
};

export type AiGenerationErrorCode =
  | "invalid-config"
  | "malformed-response"
  | "provider-failed"
  | "provider-unavailable"
  | "unsafe-request";

export class AiGenerationError extends Error {
  public readonly exitCode = 4;

  constructor(
    message: string,
    public readonly code: AiGenerationErrorCode
  ) {
    super(message);
    this.name = "AiGenerationError";
  }
}

const providerNames: readonly AiProviderName[] = [
  "none",
  "mock",
  "openai",
  "anthropic",
  "google",
  "ollama",
  "mistral",
  "openrouter"
];
const defaultProviderTimeoutMs = 300_000;
const providerTimeoutEnvKey = "UNCOMMITTED_AI_TIMEOUT_MS";
const openAiCompatibleProviders: Record<
  OpenAiCompatibleProviderName,
  OpenAiCompatibleProviderMetadata
> = {
  openai: {
    name: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    model: "gpt-5.5"
  },
  openrouter: {
    name: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    envKey: "OPENROUTER_API_KEY",
    model: "openai/gpt-5.5"
  }
};

const unsafeInputKeys = new Set([
  "apikey",
  "api_key",
  "absolutepath",
  "absolute_path",
  "diff",
  "gitroot",
  "git_root",
  "password",
  "patch",
  "rawcode",
  "raw_code",
  "rawdiff",
  "raw_diff",
  "rawtranscript",
  "raw_transcript",
  "remoteurl",
  "remote_url",
  "secret",
  "secrets",
  "token",
  "tokens",
  "transcript"
]);

export function createAiGenerationRequest(
  options: AiGenerationRequestOptions
): AiStructuredGenerationRequest {
  return {
    schemaVersion: 1,
    task: options.task,
    instructions: redactSensitiveText(options.instructions),
    input: sanitizeSafeSummary(options.summary)
  };
}

export async function loadAiProviderConfig(
  options: LoadAiProviderConfigOptions = {}
): Promise<AiProviderConfig> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const outcome = await loadGlobalConfig(paths.configFile);

  if (outcome.status === "missing") {
    throw new AiGenerationError(
      "AI config is missing. Run `uncommitted init` first.",
      "invalid-config"
    );
  }

  if (outcome.status !== "ok" || !isAiConfigFile(outcome.value)) {
    throw new AiGenerationError("AI config is invalid.", "invalid-config");
  }

  const provider = parseProviderName(outcome.value.aiProvider);

  if (!provider) {
    throw new AiGenerationError("AI provider is not supported.", "invalid-config");
  }

  return {
    provider,
    // Config `persona` may be a structured `Persona` (written by `init` /
    // `persona set`) or a legacy free-text string. `selectPersona` normalizes
    // both to a structured persona; its backstory is the free-text voice this
    // legacy `AiProviderConfig.persona` string carries.
    persona: selectPersona(outcome.value).identity.backstory,
    roastLevel: outcome.value.roastLevel
  };
}

export function createAiProvider(
  config: AiProviderConfig,
  options: CreateAiProviderOptions = {}
): AiProvider {
  if (config.provider === "mock") {
    return new MockAiProvider({
      responseJson: options.mockResponseJson ?? "{}"
    });
  }

  if (isOpenAiCompatibleProviderName(config.provider)) {
    const metadata = openAiCompatibleProviders[config.provider];
    const apiKey = resolveEnvValue(options, metadata.envKey);

    if (!apiKey) {
      throw new AiGenerationError(
        `${metadata.envKey} is not set.`,
        "provider-unavailable"
      );
    }

    return new OpenAiCompatibleProvider({
      apiKey,
      metadata,
      timeoutMs: resolveProviderTimeoutMs(options),
      transport: options.transport ?? defaultFetchTransport
    });
  }

  if (config.provider === "anthropic") {
    const apiKey = resolveEnvValue(options, "ANTHROPIC_API_KEY");

    if (!apiKey) {
      throw new AiGenerationError(
        "ANTHROPIC_API_KEY is not set.",
        "provider-unavailable"
      );
    }

    return new AnthropicProvider({
      apiKey,
      model: "claude-sonnet-4-6",
      timeoutMs: resolveProviderTimeoutMs(options),
      transport: options.transport ?? defaultFetchTransport
    });
  }

  throw new AiGenerationError(
    `AI provider is not implemented yet: ${config.provider}.`,
    "provider-unavailable"
  );
}

function resolveProviderTimeoutMs(options: CreateAiProviderOptions): number {
  if (options.timeoutMs !== undefined) {
    return assertPositiveIntegerTimeout(options.timeoutMs);
  }

  const timeoutValue = resolveEnvValue(options, providerTimeoutEnvKey);

  if (timeoutValue === undefined || timeoutValue.trim() === "") {
    return defaultProviderTimeoutMs;
  }

  return assertPositiveIntegerTimeout(Number(timeoutValue));
}

function assertPositiveIntegerTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AiGenerationError(
      `${providerTimeoutEnvKey} must be a positive integer.`,
      "invalid-config"
    );
  }

  return value;
}

function resolveEnvValue(
  options: CreateAiProviderOptions,
  key: string
): string | undefined {
  return options.env === undefined ? process.env[key] : options.env[key];
}

export async function generateStructured<
  TData extends JsonObject = JsonObject
>(
  provider: AiProvider,
  request: AiStructuredGenerationRequest
): Promise<AiStructuredGenerationResponse<TData>> {
  assertSafeProviderInput(request);

  let rawResponse: AiProviderRawResponse;

  try {
    rawResponse = await provider.generateStructured(request);
  } catch (error) {
    if (error instanceof AiGenerationError) {
      throw error;
    }

    throw new AiGenerationError(
      "AI provider failed. Check provider configuration.",
      "provider-failed"
    );
  }

  const data = parseStructuredResponse<TData>(rawResponse.responseJson);

  return {
    schemaVersion: 1,
    provider: provider.name,
    data
  };
}

export class MockAiProvider implements AiProvider {
  public readonly name = "mock";
  public readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(private readonly options: MockAiProviderOptions = {}) {}

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    this.requests.push(request);

    if (this.options.failure) {
      throw this.options.failure;
    }

    if (this.options.responseJson !== undefined) {
      return { responseJson: this.options.responseJson };
    }

    return {
      responseJson: JSON.stringify(this.options.response ?? {})
    };
  }
}

class OpenAiCompatibleProvider implements AiProvider {
  public readonly name: OpenAiCompatibleProviderName;
  public readonly model: string;

  constructor(
    private readonly options: {
      apiKey: string;
      metadata: OpenAiCompatibleProviderMetadata;
      timeoutMs: number;
      transport: AiProviderHttpTransport;
    }
  ) {
    this.name = options.metadata.name;
    this.model = options.metadata.model;
  }

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.options.transport(this.options.metadata.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(createChatCompletionBody(request, this.options.metadata)),
        signal: controller.signal
      });

      if (!response.ok) {
        await throwProviderHttpError(response);
      }

      return { responseJson: extractChatCompletionContent(await readResponseJson(response)) };
    } catch (error) {
      if (error instanceof AiGenerationError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new AiGenerationError(
          "AI provider timed out. Try again later.",
          "provider-failed"
        );
      }

      throw new AiGenerationError(
        "AI provider failed. Check provider configuration.",
        "provider-failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

class AnthropicProvider implements AiProvider {
  public readonly name = "anthropic" as const;
  public readonly model: string;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      timeoutMs: number;
      transport: AiProviderHttpTransport;
    }
  ) {
    this.model = options.model;
  }

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.options.transport("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(createAnthropicMessagesBody(request, this.options.model)),
        signal: controller.signal
      });

      if (!response.ok) {
        await throwProviderHttpError(response);
      }

      return {
        responseJson: extractAnthropicToolUseContent(await readResponseJson(response))
      };
    } catch (error) {
      if (error instanceof AiGenerationError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new AiGenerationError(
          "AI provider timed out. Try again later.",
          "provider-failed"
        );
      }

      throw new AiGenerationError(
        "AI provider failed. Check provider configuration.",
        "provider-failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function defaultFetchTransport(
  url: string,
  request: AiProviderHttpRequest
): Promise<AiProviderHttpResponse> {
  return await fetch(url, request);
}

function createChatCompletionBody(
  request: AiStructuredGenerationRequest,
  metadata: OpenAiCompatibleProviderMetadata
): JsonObject {
  return {
    model: metadata.model,
    messages: [
      {
        role: "system",
        content: [
          request.instructions,
          "The response_format JSON schema is authoritative.",
          "Return only one valid JSON object.",
          "Do not wrap the JSON in Markdown or prose."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          task: request.task,
          input: request.input
        })
      }
    ],
    response_format: createResponseFormat(request.task)
  };
}

function createResponseFormat(task: AiGenerationTask): JsonObject {
  return {
    type: "json_schema",
    json_schema:
      task === "story-plan"
        ? {
            name: "uncommitted_story_format_plan",
            strict: true,
            schema: createMoodPlanSchema()
          }
        : task === "caption"
          ? {
              name: "uncommitted_caption",
              strict: true,
              schema: createCaptionSchema()
            }
          : {
              name: "uncommitted_diary_draft",
              strict: true,
              schema: createDiaryDraftSchema()
            }
  };
}

/**
 * JSON schema for the mood/angle/pacing engine's MoodPlan output (UNC-212).
 * Wired into both createResponseFormat and createAnthropicToolDefinition for
 * the story-plan task (UNC-213). `formatName` is intentionally absent — it is
 * set internally (== mood), never requested from the AI provider.
 */
export function createMoodPlanSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "mood",
      "angle",
      "pacing",
      "voice",
      "tone",
      "reason",
      "structure",
      "captionStyle",
      "doNotMention"
    ],
    properties: {
      mood: {
        type: "string",
        enum: [
          "release",
          "firefight",
          "quiet",
          "grind",
          "breakthrough",
          "cleanup"
        ]
      },
      angle: { type: "string" },
      pacing: {
        type: "object",
        additionalProperties: false,
        required: ["openWith", "shape", "suggestedSlideCount"],
        properties: {
          openWith: { type: "string", enum: ["scene", "thought"] },
          shape: {
            type: "string",
            enum: ["hook-turn-landing", "list", "single-beat", "spiral"]
          },
          suggestedSlideCount: { type: "integer" }
        }
      },
      voice: { type: "string" },
      tone: { type: "string" },
      reason: { type: "string" },
      structure: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["part", "purpose"],
          properties: {
            part: { type: "string" },
            purpose: { type: "string" }
          }
        }
      },
      captionStyle: { type: "string" },
      doNotMention: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
}

function createDiaryDraftSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "slides", "altText"],
    properties: {
      title: { type: "string" },
      slides: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "title", "body", "visualMood"],
          properties: {
            index: { type: "integer" },
            title: { type: "string" },
            body: { type: "string" },
            visualMood: { type: "string" }
          }
        }
      },
      altText: { type: "string" }
    }
  };
}

function createCaptionSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["caption", "hashtags"],
    properties: {
      caption: { type: "string" },
      hashtags: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
}

function extractChatCompletionContent(value: unknown): string {
  if (
    !isRecord(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length === 0
  ) {
    throwInvalidProviderJson();
  }

  const [choice] = value.choices;

  if (!isRecord(choice) || !isRecord(choice.message)) {
    throwInvalidProviderJson();
  }

  const { content } = choice.message;

  if (typeof content !== "string") {
    throwInvalidProviderJson();
  }

  return content;
}

function createAnthropicMessagesBody(
  request: AiStructuredGenerationRequest,
  model: string
): JsonObject {
  const { toolName, schema } = createAnthropicToolDefinition(request.task);

  return {
    model,
    max_tokens: 4096,
    system: [
      request.instructions,
      "The response_format JSON schema is authoritative.",
      "Return only one valid JSON object.",
      "Do not wrap the JSON in Markdown or prose."
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: JSON.stringify({ task: request.task, input: request.input })
      }
    ],
    tools: [
      {
        name: toolName,
        description: "Return the structured output for this task.",
        strict: true,
        input_schema: schema
      }
    ],
    tool_choice: { type: "tool", name: toolName }
  };
}

function createAnthropicToolDefinition(task: AiGenerationTask): {
  toolName: string;
  schema: JsonObject;
} {
  if (task === "story-plan") {
    return { toolName: "uncommitted_story_format_plan", schema: createMoodPlanSchema() };
  }

  if (task === "caption") {
    return { toolName: "uncommitted_caption", schema: createCaptionSchema() };
  }

  return { toolName: "uncommitted_diary_draft", schema: createDiaryDraftSchema() };
}

function extractAnthropicToolUseContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length === 0) {
    throwInvalidProviderJson();
  }

  const toolUseBlock = (value.content as unknown[]).find(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block.type === "tool_use"
  );

  if (!toolUseBlock || !isRecord(toolUseBlock.input)) {
    throwInvalidProviderJson();
  }

  return JSON.stringify(toolUseBlock.input);
}

async function readResponseJson(
  response: AiProviderHttpResponse
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throwInvalidProviderJson();
  }
}

async function throwProviderHttpError(
  response: AiProviderHttpResponse
): Promise<never> {
  const status = response.status;

  if (status === 401 || status === 403) {
    throw new AiGenerationError(
      "AI provider authentication failed. Check API key.",
      "provider-failed"
    );
  }

  if (status === 408 || status === 504) {
    throw new AiGenerationError(
      "AI provider timed out. Try again later.",
      "provider-failed"
    );
  }

  if (status === 429) {
    if ((await classify429Response(response)) === "billing") {
      throw new AiGenerationError(BILLING_429_MESSAGE, "provider-failed");
    }

    throw new AiGenerationError(
      "AI provider rate limit exceeded. Try again later.",
      "provider-failed"
    );
  }

  throw new AiGenerationError(
    "AI provider failed. Check provider configuration.",
    "provider-failed"
  );
}

async function classify429Response(
  response: AiProviderHttpResponse
): Promise<"billing" | "generic"> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return "generic";
  }

  return classify429ResponseBody(body);
}

function throwInvalidProviderJson(): never {
  throw new AiGenerationError(
    "AI provider returned invalid JSON.",
    "malformed-response"
  );
}

function sanitizeSafeSummary(summary: SafeActivitySummary): SafeActivitySummary {
  const sanitized = sanitizeJsonValue(summary);

  if (!isSafeActivitySummary(sanitized)) {
    throw new AiGenerationError("AI provider request is invalid.", "unsafe-request");
  }

  return sanitized;
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (isRecord(value)) {
    const sanitized: JsonObject = {};

    for (const [key, child] of Object.entries(value)) {
      if (isUnsafeInputKey(key)) {
        throw new AiGenerationError(
          "AI provider request includes unsafe raw input.",
          "unsafe-request"
        );
      }

      if (!isJsonValue(child)) {
        throw new AiGenerationError(
          "AI provider request is invalid.",
          "unsafe-request"
        );
      }

      sanitized[key] = sanitizeJsonValue(child);
    }

    return sanitized;
  }

  return value;
}

function assertSafeProviderInput(value: JsonValue): void {
  assertNoUnsafeKeys(value);
  assertNoSensitiveStrings(value);
}

function assertNoUnsafeKeys(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUnsafeKeys(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (isUnsafeInputKey(key)) {
      throw new AiGenerationError(
        "AI provider request includes unsafe raw input.",
        "unsafe-request"
      );
    }

    if (!isJsonValue(child)) {
      throw new AiGenerationError(
        "AI provider request is invalid.",
        "unsafe-request"
      );
    }

    assertNoUnsafeKeys(child);
  }
}

function assertNoSensitiveStrings(value: JsonValue): void {
  if (typeof value === "string") {
    if (containsSensitiveText(value)) {
      throw new AiGenerationError(
        "AI provider request includes unsafe raw input.",
        "unsafe-request"
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveStrings(item);
    }
    return;
  }

  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      if (isJsonValue(child)) {
        assertNoSensitiveStrings(child);
      }
    }
  }
}

function parseStructuredResponse<TData extends JsonObject>(responseJson: string): TData {
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseJson);
  } catch {
    throw new AiGenerationError(
      "AI provider returned invalid JSON.",
      "malformed-response"
    );
  }

  if (!isJsonObject(parsed)) {
    throw new AiGenerationError(
      "AI provider returned invalid JSON.",
      "malformed-response"
    );
  }

  return parsed as TData;
}

function parseProviderName(value: string): AiProviderName | undefined {
  const normalized = value.trim().toLowerCase();

  return providerNames.find((provider) => provider === normalized);
}

function isOpenAiCompatibleProviderName(
  value: AiProviderName
): value is OpenAiCompatibleProviderName {
  return value === "openai" || value === "openrouter";
}

function isAiConfigFile(value: unknown): value is {
  schemaVersion: 1;
  aiProvider: string;
  persona: unknown;
  roastLevel: number;
} {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.aiProvider === "string" &&
    // Accept both the structured `Persona` (current shape) and a legacy
    // free-text string; `loadAiProviderConfig` normalizes via `selectPersona`.
    (typeof value.persona === "string" || isPersona(value.persona)) &&
    isRoastLevel(value.roastLevel)
  );
}

function isSafeActivitySummary(value: JsonValue): value is SafeActivitySummary {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.targetDate === "string" &&
    typeof value.quiet === "boolean" &&
    typeof value.overview === "string" &&
    Array.isArray(value.highlights) &&
    value.highlights.every((item) => typeof item === "string") &&
    Array.isArray(value.projectSummaries) &&
    value.projectSummaries.every(isSafeProjectSummary)
  );
}

function isSafeProjectSummary(value: unknown): value is SafeProjectSummary {
  return (
    isRecord(value) &&
    typeof value.projectId === "string" &&
    typeof value.projectName === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.stats) &&
    typeof value.stats.commits === "number" &&
    typeof value.stats.filesChanged === "number" &&
    typeof value.stats.insertions === "number" &&
    typeof value.stats.deletions === "number" &&
    typeof value.stats.dirtyFiles === "number"
  );
}

function isUnsafeInputKey(key: string): boolean {
  return unsafeInputKeys.has(key.toLowerCase().replace(/[-\s]/g, "_"));
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    isJsonObject(value)
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  // isRecord already excludes arrays, so no separate Array.isArray check.
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function containsSensitiveText(value: string): boolean {
  return redactSensitiveText(value) !== value;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bdiff --git\b[^\n]*/g, "[redacted-code]")
    .replace(/`[^`]+`/g, "[redacted-code]")
    .replace(
      /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/gi,
      "[redacted-secret]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted-secret]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-secret]")
    .replace(
      /\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/g,
      "[redacted-url]"
    )
    .replace(emailPattern("gi"), "[redacted-email]")
    .replace(
      /(^|[\s(["'])\/[^\s)"']+/g,
      "$1[redacted-path]"
    );
}
