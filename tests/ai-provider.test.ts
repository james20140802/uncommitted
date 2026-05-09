import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiGenerationError,
  createAiGenerationRequest,
  createAiProvider,
  generateStructured,
  loadAiProviderConfig,
  MockAiProvider
} from "../src/ai-provider.js";
import type {
  AiProviderHttpRequest,
  AiProviderHttpResponse,
  SafeActivitySummary
} from "../src/ai-provider.js";

describe("AI provider abstraction", () => {
  it("loads provider configuration from the existing MVP config shape", async () => {
    const homeDir = await createHomeWithConfig({
      aiProvider: "mock",
      persona: "dry reviewer",
      roastLevel: 4
    });

    await expect(loadAiProviderConfig({ homeDir })).resolves.toEqual({
      provider: "mock",
      persona: "dry reviewer",
      roastLevel: 4
    });
  });

  it("returns deterministic structured JSON from the mock provider", async () => {
    const request = createAiGenerationRequest({
      task: "story-plan",
      instructions: "Build a concise story plan.",
      summary: {
        schemaVersion: 1,
        targetDate: "2026-05-08",
        quiet: false,
        overview: "Implemented config loading and provider boundaries.",
        highlights: ["Added a typed provider interface."],
        projectSummaries: [
          {
            projectId: "uncommitted",
            projectName: "uncommitted",
            summary: "Provider work without raw diffs.",
            stats: {
              commits: 2,
              filesChanged: 3,
              insertions: 120,
              deletions: 12,
              dirtyFiles: 0
            }
          }
        ]
      }
    });
    const provider = new MockAiProvider({
      responseJson: JSON.stringify({
        title: "Provider boundary day",
        beats: ["Configured", "Mocked", "Validated"]
      })
    });

    await expect(generateStructured(provider, request)).resolves.toEqual({
      schemaVersion: 1,
      provider: "mock",
      data: {
        title: "Provider boundary day",
        beats: ["Configured", "Mocked", "Validated"]
      }
    });
    expect(provider.requests).toEqual([request]);
  });

  it("creates an OpenAI provider with environment credentials and safe JSON requests", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(calls, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "OpenAI provider day",
                  beats: ["Configured", "Generated"]
                })
              }
            }
          ]
        })
      }
    );
    const request = createAiGenerationRequest({
      task: "story-plan",
      instructions: "Return a compact JSON object.",
      summary: createQuietSummary()
    });

    await expect(generateStructured(provider, request)).resolves.toEqual({
      schemaVersion: 1,
      provider: "openai",
      data: {
        title: "OpenAI provider day",
        beats: ["Configured", "Generated"]
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.request.headers.Authorization).toBe("Bearer sk-test-secret");
    expect(calls[0]?.request.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      model?: string;
      messages?: Array<{ role: string; content: string }>;
      response_format?: {
        type: string;
        json_schema?: { name?: string; strict?: boolean; schema?: unknown };
      };
    };

    expect(body.model).toBe("gpt-5.5");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "uncommitted_story_format_plan",
        strict: true
      }
    });
    expect(body.messages?.map((message) => message.role)).toEqual([
      "system",
      "user"
    ]);
    expect(JSON.stringify(body)).not.toContain("sk-test-secret");
  });

  it("creates an OpenRouter provider with provider-specific credentials and endpoint", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createAiProvider(
      {
        provider: "openrouter",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENROUTER_API_KEY: "or-test-secret" },
        transport: createTransport(calls, {
          choices: [
            {
              message: {
                content: JSON.stringify({ title: "OpenRouter provider day" })
              }
            }
          ]
        })
      }
    );

    await generateStructured(
      provider,
      createAiGenerationRequest({
        task: "draft",
        instructions: "Return JSON.",
        summary: createQuietSummary()
      })
    );

    expect(provider.name).toBe("openrouter");
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.request.headers.Authorization).toBe("Bearer or-test-secret");

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      model?: string;
      response_format?: {
        type: string;
        json_schema?: { name?: string; strict?: boolean; schema?: unknown };
      };
    };

    expect(body.model).toBe("openai/gpt-5.5");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "uncommitted_diary_draft",
        strict: true
      }
    });
  });

  it("fails clearly when real provider credentials are missing", () => {
    expect(() =>
      createAiProvider(
        {
          provider: "openai",
          persona: "dry reviewer",
          roastLevel: 3
        },
        { env: {} }
      )
    ).toThrow(
      expect.objectContaining({
        code: "provider-unavailable",
        exitCode: 4,
        message: "OPENAI_API_KEY is not set."
      })
    );
  });

  it("fails clearly for configured providers that do not have adapters yet", () => {
    expect(() =>
      createAiProvider({
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      })
    ).toThrow(
      expect.objectContaining({
        code: "provider-unavailable",
        exitCode: 4,
        message: "AI provider is not implemented yet: anthropic."
      })
    );
  });

  it("normalizes OpenAI-compatible HTTP failures without leaking response bodies", async () => {
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport([], { error: "invalid key sk-test-secret" }, 401)
      }
    );

    await expect(
      generateStructured(
        provider,
        createAiGenerationRequest({
          task: "draft",
          instructions: "Return JSON.",
          summary: createQuietSummary()
        })
      )
    ).rejects.toMatchObject({
      code: "provider-failed",
      exitCode: 4,
      message: "AI provider authentication failed. Check API key."
    });
  });

  it("fails before downstream generation when provider response content is malformed", async () => {
    const provider = createAiProvider(
      {
        provider: "openrouter",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENROUTER_API_KEY: "or-test-secret" },
        transport: createTransport([], {
          choices: [{ message: { content: "not-json" } }]
        })
      }
    );

    await expect(
      generateStructured(
        provider,
        createAiGenerationRequest({
          task: "story-plan",
          instructions: "Return JSON.",
          summary: createQuietSummary()
        })
      )
    ).rejects.toMatchObject({
      code: "malformed-response",
      exitCode: 4,
      message: "AI provider returned invalid JSON."
    });
  });

  it("fails with a short actionable error for malformed provider responses", async () => {
    const request = createAiGenerationRequest({
      task: "caption",
      instructions: "Write a caption.",
      summary: createQuietSummary()
    });
    const provider = new MockAiProvider({ responseJson: "not-json" });

    await expect(generateStructured(provider, request)).rejects.toMatchObject({
      code: "malformed-response",
      exitCode: 4,
      message: "AI provider returned invalid JSON."
    });
  });

  it("normalizes provider failures into generation errors", async () => {
    const request = createAiGenerationRequest({
      task: "caption",
      instructions: "Write a caption.",
      summary: createQuietSummary()
    });
    const provider = new MockAiProvider({
      failure: new Error("socket hang up with a very long provider trace")
    });

    await expect(generateStructured(provider, request)).rejects.toMatchObject({
      code: "provider-failed",
      exitCode: 4,
      message: "AI provider failed. Check provider configuration."
    });
  });

  it("keeps provider requests on safe summaries and rejects unsafe raw inputs", () => {
    const request = createAiGenerationRequest({
      task: "story-plan",
      instructions:
        "Build from safe summaries only. Authorization: Bearer secret-token-value.",
      summary: {
        ...createQuietSummary(),
        overview:
          "See dev@example.com, /Users/dev/private, git@github.com:acme/private.git, OPENAI_API_KEY=sk-live-secret123, and `const token = process.env.SECRET`.",
        highlights: [
          "diff --git a/secret.ts b/secret.ts",
          "Copied provider key sk-proj-secret123 into a local note."
        ]
      }
    });

    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("dev@example.com");
    expect(serialized).not.toContain("/Users/dev/private");
    expect(serialized).not.toContain("git@github.com:acme/private.git");
    expect(serialized).not.toContain("const token");
    expect(serialized).not.toContain("process.env.SECRET");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("sk-live-secret123");
    expect(serialized).not.toContain("sk-proj-secret123");
    expect(serialized).not.toContain("Bearer secret-token-value");
    expect(serialized).toContain("[redacted-email]");
    expect(serialized).toContain("[redacted-path]");
    expect(serialized).toContain("[redacted-url]");
    expect(serialized).toContain("[redacted-code]");
    expect(serialized).toContain("[redacted-secret]");

    expect(() =>
      createAiGenerationRequest({
        task: "story-plan",
        instructions: "Build from safe summaries only.",
        summary: {
          ...createQuietSummary(),
          rawDiff: "+ const apiKey = 'secret';"
        }
      })
    ).toThrow(AiGenerationError);
  });
});

async function createHomeWithConfig(
  overrides: Partial<{ aiProvider: string; persona: string; roastLevel: number }> = {}
): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-ai-provider-"));
  const configDir = join(homeDir, ".uncommitted");

  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      draftRoot: join(homeDir, "Uncommitted", "drafts"),
      scheduleTime: "23:30",
      aiProvider: overrides.aiProvider ?? "none",
      persona: overrides.persona ?? "wry coworker",
      roastLevel: overrides.roastLevel ?? 2
    })}\n`,
    "utf8"
  );

  return homeDir;
}

function createQuietSummary(): SafeActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-08",
    quiet: true,
    overview: "Quiet day with no recorded project activity.",
    highlights: [],
    projectSummaries: []
  };
}

function createTransport(
  calls: Array<{ url: string; request: AiProviderHttpRequest }>,
  responseBody: unknown,
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
      json: async () => responseBody
    };
  };
}
