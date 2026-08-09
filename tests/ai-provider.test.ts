import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiGenerationError,
  createAiGenerationRequest,
  createAiProvider,
  createMoodPlanSchema,
  generateStructured,
  generateStructuredWithRetry,
  loadAiProviderConfig,
  MockAiProvider
} from "../src/ai-provider.js";
import type {
  AiProvider,
  AiProviderHttpRequest,
  AiProviderHttpResponse,
  AiProviderRawResponse,
  AiStructuredGenerationRequest,
  JsonObject,
  SafeActivitySummary
} from "../src/ai-provider.js";
import { PERSONA_PRESETS } from "../src/persona.js";

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

  it("accepts a structured persona config and returns its backstory", async () => {
    const structuredPersona = PERSONA_PRESETS["까칠한 시니어"].persona;
    const homeDir = await mkdtemp(
      join(tmpdir(), "uncommitted-ai-provider-structured-")
    );
    const configDir = join(homeDir, ".uncommitted");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        draftRoot: join(homeDir, "Uncommitted", "drafts"),
        scheduleTime: "23:30",
        aiProvider: "mock",
        persona: structuredPersona,
        roastLevel: 3
      })}\n`,
      "utf8"
    );

    await expect(loadAiProviderConfig({ homeDir })).resolves.toEqual({
      provider: "mock",
      persona: structuredPersona.identity.backstory,
      roastLevel: 3
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
      },
      rawResponseJson: JSON.stringify({
        title: "Provider boundary day",
        beats: ["Configured", "Mocked", "Validated"]
      })
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
      },
      rawResponseJson: JSON.stringify({
        title: "OpenAI provider day",
        beats: ["Configured", "Generated"]
      })
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

  it("uses the MoodPlan schema for the OpenAI-compatible story-plan response format, not the legacy formatName schema", async () => {
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
                content: JSON.stringify({ mood: "grind" })
              }
            }
          ]
        })
      }
    );

    await generateStructured(
      provider,
      createAiGenerationRequest({
        task: "story-plan",
        instructions: "Return a compact JSON object.",
        summary: createQuietSummary()
      })
    );

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      response_format?: {
        json_schema?: {
          schema?: { required?: string[]; properties?: Record<string, unknown> };
        };
      };
    };

    const schema = body.response_format?.json_schema?.schema;
    expect(schema?.required).toContain("mood");
    expect(schema?.required).not.toContain("formatName");
    expect(schema?.properties?.formatName).toBeUndefined();
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

  it("does not fall back to process env when an explicit env map is injected", () => {
    const previousApiKey = process.env.OPENAI_API_KEY;

    process.env.OPENAI_API_KEY = "sk-machine-secret";

    try {
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
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it("fails clearly for configured providers that do not have adapters yet", () => {
    expect(() =>
      createAiProvider({
        provider: "google",
        persona: "dry reviewer",
        roastLevel: 3
      })
    ).toThrow(
      expect.objectContaining({
        code: "provider-unavailable",
        exitCode: 4,
        message: "AI provider is not implemented yet: google."
      })
    );
  });

  it("creates an Anthropic provider with environment credentials and safe JSON requests", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport(calls, {
          content: [
            {
              type: "tool_use",
              name: "uncommitted_story_format_plan",
              input: { title: "Anthropic provider day", beats: ["Configured", "Generated"] }
            }
          ],
          stop_reason: "tool_use"
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
      provider: "anthropic",
      data: { title: "Anthropic provider day", beats: ["Configured", "Generated"] },
      rawResponseJson: JSON.stringify({
        title: "Anthropic provider day",
        beats: ["Configured", "Generated"]
      })
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.request.headers["x-api-key"]).toBe("sk-ant-test-secret");
    expect(calls[0]?.request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.request.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      model?: string;
      max_tokens?: number;
      system?: string;
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{
        name: string;
        description: string;
        strict?: boolean;
        input_schema: unknown;
      }>;
      tool_choice?: { type: string; name: string };
    };

    expect(body.model).toBe("claude-sonnet-4-6");
    expect(typeof body.max_tokens).toBe("number");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(typeof body.system).toBe("string");
    expect(body.messages).toHaveLength(1);
    expect(body.messages?.[0]?.role).toBe("user");
    expect(typeof body.messages?.[0]?.content).toBe("string");
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.name).toBe("uncommitted_story_format_plan");
    expect(body.tools?.[0]?.strict).toBe(true);
    expect(typeof body.tools?.[0]?.input_schema).toBe("object");
    expect(body.tool_choice).toEqual({ type: "tool", name: "uncommitted_story_format_plan" });
    expect(JSON.stringify(body)).not.toContain("sk-ant-test-secret");
  });

  it("uses the MoodPlan schema for the Anthropic story-plan tool, not the legacy formatName schema", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport(calls, {
          content: [
            {
              type: "tool_use",
              name: "uncommitted_story_format_plan",
              input: { mood: "grind" }
            }
          ],
          stop_reason: "tool_use"
        })
      }
    );

    await generateStructured(
      provider,
      createAiGenerationRequest({
        task: "story-plan",
        instructions: "Return a compact JSON object.",
        summary: createQuietSummary()
      })
    );

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      tools?: Array<{
        input_schema?: { required?: string[]; properties?: Record<string, unknown> };
      }>;
    };

    const schema = body.tools?.[0]?.input_schema;
    expect(schema?.required).toContain("mood");
    expect(schema?.required).not.toContain("formatName");
    expect(schema?.properties?.formatName).toBeUndefined();
  });

  it("creates an Anthropic provider that uses the diary draft schema for the draft task", async () => {
    const calls: Array<{ url: string; request: AiProviderHttpRequest }> = [];
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport(calls, {
          content: [
            {
              type: "tool_use",
              name: "uncommitted_diary_draft",
              input: { title: "Draft day", slides: [], altText: "A quiet day." }
            }
          ],
          stop_reason: "tool_use"
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

    const body = JSON.parse(calls[0]?.request.body ?? "{}") as {
      tools?: Array<{ name: string }>;
      tool_choice?: { type: string; name: string };
    };

    expect(body.tools?.[0]?.name).toBe("uncommitted_diary_draft");
    expect(body.tool_choice?.name).toBe("uncommitted_diary_draft");
  });

  it("fails clearly when ANTHROPIC_API_KEY is missing", () => {
    expect(() =>
      createAiProvider(
        {
          provider: "anthropic",
          persona: "dry reviewer",
          roastLevel: 3
        },
        { env: {} }
      )
    ).toThrow(
      expect.objectContaining({
        code: "provider-unavailable",
        exitCode: 4,
        message: "ANTHROPIC_API_KEY is not set."
      })
    );
  });

  it("normalizes Anthropic HTTP failures without leaking response bodies", async () => {
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport(
          [],
          { error: { type: "authentication_error", message: "invalid x-api-key sk-ant-test-secret" } },
          401
        )
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

  it("normalizes Anthropic rate-limit failures", async () => {
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport([], { error: "rate limit exceeded" }, 429)
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
      message: "AI provider rate limit exceeded. Try again later."
    });
  });

  it("reports a billing-class 429 (insufficient_quota) distinctly, not as a temporary rate limit", async () => {
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(
          [],
          { error: { type: "insufficient_quota", code: "insufficient_quota" } },
          429
        )
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
      message:
        "AI provider credit/billing quota exhausted. Check your plan and billing details."
    });
  });

  it("reports a billing-class 429 recognized via error.code only (billing_hard_limit_reached)", async () => {
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(
          [],
          { error: { code: "billing_hard_limit_reached" } },
          429
        )
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
      message:
        "AI provider credit/billing quota exhausted. Check your plan and billing details."
    });
  });

  it("keeps the generic 429 message verbatim for a plain rate-limit body", async () => {
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        transport: createTransport(
          [],
          { error: { type: "rate_limit_exceeded" } },
          429
        )
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
      message: "AI provider rate limit exceeded. Try again later."
    });
  });

  it("falls back to the generic 429 message when the 429 body cannot be parsed", async () => {
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
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
      message: "AI provider rate limit exceeded. Try again later."
    });
  });

  it("normalizes Anthropic timeout via env override", async () => {
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: {
          ANTHROPIC_API_KEY: "sk-ant-test-secret",
          UNCOMMITTED_AI_TIMEOUT_MS: "1"
        },
        transport: async (_url, request) => {
          return await new Promise<AiProviderHttpResponse>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
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
      message: "AI provider timed out. Try again later."
    });
  });

  it("fails before downstream generation when Anthropic response has no tool_use block", async () => {
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport([], {
          content: [{ type: "text", text: "no tool used" }],
          stop_reason: "end_turn"
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

  it("fails when Anthropic tool_use input is not valid JSON-serializable structure", async () => {
    const provider = createAiProvider(
      {
        provider: "anthropic",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        transport: createTransport([], {
          content: [{ type: "tool_use", name: "x", input: "not an object" }],
          stop_reason: "tool_use"
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

  it("allows long-running provider calls to use an environment timeout override", async () => {
    const provider = createAiProvider(
      {
        provider: "openai",
        persona: "dry reviewer",
        roastLevel: 3
      },
      {
        env: {
          OPENAI_API_KEY: "sk-test-secret",
          UNCOMMITTED_AI_TIMEOUT_MS: "1"
        },
        transport: async (_url, request) => {
          return await new Promise<AiProviderHttpResponse>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
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
      message: "AI provider timed out. Try again later."
    });
  });

  it("rejects invalid provider timeout overrides", () => {
    expect(() =>
      createAiProvider(
        {
          provider: "openai",
          persona: "dry reviewer",
          roastLevel: 3
        },
        {
          env: {
            OPENAI_API_KEY: "sk-test-secret",
            UNCOMMITTED_AI_TIMEOUT_MS: "soon"
          }
        }
      )
    ).toThrow(
      expect.objectContaining({
        code: "invalid-config",
        exitCode: 4,
        message: "UNCOMMITTED_AI_TIMEOUT_MS must be a positive integer."
      })
    );
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

  it("carries structured details when provided", () => {
    const error = new AiGenerationError("bad", "malformed-response", {
      violations: ["caption-empty"],
      rawResponseJson: '{"caption":""}'
    });

    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("malformed-response");
    expect(error.details?.violations).toEqual(["caption-empty"]);
    expect(error.details?.rawResponseJson).toBe('{"caption":""}');
  });

  it("leaves details undefined when omitted", () => {
    const error = new AiGenerationError("bad", "provider-failed");

    expect(error.details).toBeUndefined();
    expect(error.exitCode).toBe(4);
  });
});

describe("generateStructuredWithRetry", () => {
  it("stops after one call when isRetryable rejects the error", async () => {
    const request = createAiGenerationRequest({
      task: "caption",
      instructions: "Write a caption.",
      summary: createQuietSummary()
    });
    const provider = new RetrySequenceProvider([{ caption: "" }]);

    await expect(
      generateStructuredWithRetry(provider, request, {
        maxAttempts: 2,
        isRetryable: () => false,
        buildRetryInstructions: (previous) => `${previous}\nretry`,
        validate: () => {
          throw new AiGenerationError("rejected", "malformed-response", {
            violations: ["caption-empty"]
          });
        }
      })
    ).rejects.toMatchObject({ code: "malformed-response" });

    expect(provider.requests).toHaveLength(1);
  });

  it("redacts sensitive text in retry instructions before the retry request is sent", async () => {
    const request = createAiGenerationRequest({
      task: "caption",
      instructions: "Write a caption.",
      summary: createQuietSummary()
    });
    const provider = new RetrySequenceProvider([
      { caption: "" },
      { caption: "fixed" }
    ]);

    const result = await generateStructuredWithRetry(provider, request, {
      maxAttempts: 2,
      isRetryable: () => true,
      buildRetryInstructions: (previous) =>
        `${previous}\nUse this key: sk-abcdefgh12345678`,
      validate: (data: JsonObject) => {
        if (data.caption === "") {
          throw new AiGenerationError("rejected", "malformed-response", {
            violations: ["caption-empty"]
          });
        }

        return data.caption;
      }
    });

    expect(result).toBe("fixed");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].instructions).toContain("[redacted-secret]");
    expect(provider.requests[1].instructions).not.toContain("sk-abcdefgh12345678");
  });
});

/**
 * UNC-254 / T3: `MockAiProvider` returns the same response on every call, so
 * it cannot express a retry sequence. This local stub returns responses in
 * call order (the last response repeats for any further calls).
 */
class RetrySequenceProvider implements AiProvider {
  public readonly name = "mock" as const;
  public readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(private readonly responses: JsonObject[]) {}

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    this.requests.push(request);
    const next =
      this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];

    return { responseJson: JSON.stringify(next) };
  }
}

describe("createMoodPlanSchema", () => {
  it("requires mood/angle/pacing/reason/structure/captionStyle/doNotMention and forbids extras", () => {
    const schema = createMoodPlanSchema();

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "mood",
        "angle",
        "pacing",
        "reason",
        "structure",
        "captionStyle",
        "doNotMention"
      ]
    });

    const properties = (schema as { properties?: Record<string, unknown> })
      .properties;

    expect(properties?.mood).toEqual({
      type: "string",
      enum: [
        "release",
        "firefight",
        "quiet",
        "grind",
        "breakthrough",
        "cleanup"
      ]
    });
    expect(properties?.pacing).toMatchObject({
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
    });

    // formatName is set internally (== mood); it must not appear in the AI schema.
    expect(properties?.formatName).toBeUndefined();
    expect(
      (schema as { required?: string[] }).required
    ).not.toContain("formatName");
  });

  it("omits voice and tone from the mood plan schema", () => {
    const schema = createMoodPlanSchema() as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(schema.required).not.toContain("voice");
    expect(schema.required).not.toContain("tone");
    expect(schema.properties).not.toHaveProperty("voice");
    expect(schema.properties).not.toHaveProperty("tone");
    expect(schema.required).toContain("mood");
    expect(schema.required).toContain("angle");
    expect(schema.required).toContain("pacing");
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
