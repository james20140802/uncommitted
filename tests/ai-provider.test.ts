import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiGenerationError,
  createAiGenerationRequest,
  generateStructured,
  loadAiProviderConfig,
  MockAiProvider
} from "../src/ai-provider.js";
import type { SafeActivitySummary } from "../src/ai-provider.js";

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
      instructions: "Build from safe summaries only.",
      summary: {
        ...createQuietSummary(),
        overview:
          "See dev@example.com, /Users/dev/private, git@github.com:acme/private.git, and `const token = process.env.SECRET`.",
        highlights: ["diff --git a/secret.ts b/secret.ts"]
      }
    });

    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("dev@example.com");
    expect(serialized).not.toContain("/Users/dev/private");
    expect(serialized).not.toContain("git@github.com:acme/private.git");
    expect(serialized).not.toContain("const token");
    expect(serialized).not.toContain("process.env.SECRET");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).toContain("[redacted-email]");
    expect(serialized).toContain("[redacted-path]");
    expect(serialized).toContain("[redacted-url]");
    expect(serialized).toContain("[redacted-code]");

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
