import { readFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";

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

  try {
    const parsed = JSON.parse(await readFile(paths.configFile, "utf8")) as unknown;

    if (!isAiConfigFile(parsed)) {
      throw new AiGenerationError("AI config is invalid.", "invalid-config");
    }

    const provider = parseProviderName(parsed.aiProvider);

    if (!provider) {
      throw new AiGenerationError("AI provider is not supported.", "invalid-config");
    }

    return {
      provider,
      persona: parsed.persona,
      roastLevel: parsed.roastLevel
    };
  } catch (error) {
    if (error instanceof AiGenerationError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      throw new AiGenerationError(
        "AI config is missing. Run `uncommitted init` first.",
        "invalid-config"
      );
    }

    throw new AiGenerationError("AI config is invalid.", "invalid-config");
  }
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

  throw new AiGenerationError(
    "AI provider is not implemented yet.",
    "provider-unavailable"
  );
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

function isAiConfigFile(value: unknown): value is {
  schemaVersion: 1;
  aiProvider: string;
  persona: string;
  roastLevel: number;
} {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.aiProvider === "string" &&
    typeof value.persona === "string" &&
    Number.isInteger(value.roastLevel)
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
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(
      /(^|[\s(["'])\/[^\s)"']+/g,
      "$1[redacted-path]"
    );
}
