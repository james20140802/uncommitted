import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  AiProvider,
  AiProviderRawResponse,
  AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import { runCli } from "../src/cli.js";
import { checkDraftSafety } from "../src/safety-report.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import type { GitActivityEvent } from "../src/collect-git-command.js";
import type { CaptionResult, DiaryDraft } from "../src/diary-generator.js";
import type { ImageAssetProvider, ImageAssetRequest } from "../src/visual-assets.js";

const execFileAsync = promisify(execFile);

/**
 * Cross-cutting regression + reproduction suite for the
 * architecture-disclosure safety rule (UNC-198 / UNC-208 / T4).
 *
 * (a) Regression (parent AC3): every pre-existing redaction category from
 *     tests/safety-report.test.ts still fires and still maps to its
 *     existing `status`, unaffected by the new architecture-disclosure
 *     rule running alongside it in the same detection pipeline.
 * (b) Reproduction (parent AC1 + AC2 + AC4): an anonymized fixture modeled
 *     on the 2026-06-05 / 2026-06-07 `safetyConcern=true` class (multiple
 *     distinct disclosure classes co-occurring) is driven end-to-end
 *     through `runCli(["generate", "today"], ...)`, exactly like
 *     tests/generate-command.test.ts, and asserted to:
 *       - be blocked with an `architecture-disclosure` reason recorded in
 *         safety-report.json (AC2, AC4)
 *       - keep the written story.json/caption.txt fully sanitized (AC1)
 *     A companion single-class case stays a warning and exports, so the
 *     image-prompt surface (which is only generated for exportable
 *     drafts — a blocked draft never reaches visual-asset generation, see
 *     src/generate-command.ts) is also locked as sanitized (AC1 boundary).
 *
 * HARD PRIVACY GUARD: no real user data is read anywhere in this file.
 * ~/Uncommitted/evals/daily-feedback.jsonl (or anything under ~/Uncommitted
 * or ~/.uncommitted) is never opened. The 2026-06-05/06-07 reproduction
 * fixture below is hand-authored fiction shaped like that feedback class
 * (route-guard + admin-allowlist + auth-checkpoint + server-side-
 * authorization exposure), not a copy of any real record.
 */

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    },
    stdout,
    stderr
  };
}

describe("architecture-disclosure e2e (UNC-208 / T4)", () => {
  describe("(a) no-regression: pre-existing redaction categories are unaffected", () => {
    it("still warns and redacts local paths, emails, phone numbers, and private URLs", () => {
      const result = checkDraftSafety(
        [
          "Debug notes lived at /Users/chase/private/todo.md.",
          "Ask dev@example.com or 555-123-4567.",
          "Private repo: https://github.com/acme/secret-project"
        ].join(" ")
      );

      expect(result.report.status).toBe("warning");
      expect(result.report.exportAllowed).toBe(true);
      expect(result.report.risks.map((risk) => risk.category)).toEqual([
        "private-url",
        "email",
        "phone-number",
        "local-path"
      ]);
      expect(result.redactedText).not.toContain("/Users/chase");
      expect(result.redactedText).not.toContain("dev@example.com");
      expect(result.redactedText).not.toContain("555-123-4567");
      expect(result.redactedText).not.toContain("secret-project");
      // No architecture-disclosure risk should appear for text that never
      // mentions an access-control mechanism.
      expect(
        result.report.risks.some((risk) => risk.category === "architecture-disclosure")
      ).toBe(false);
    });

    it("still blocks token-like secrets and database credentials", () => {
      const result = checkDraftSafety(
        "The deployment failed with OPENAI_API_KEY=sk-1234567890abcdef and DATABASE_URL=postgres://user:password@localhost:5432/app"
      );

      expect(result.report.status).toBe("blocked");
      expect(result.report.exportAllowed).toBe(false);
      expect(result.report.risks).toEqual(
        expect.arrayContaining([
          {
            category: "secret",
            severity: "blocked",
            message: "Secret or token was redacted."
          },
          {
            category: "database-credential",
            severity: "blocked",
            message: "Database credential was redacted."
          }
        ])
      );
      expect(result.redactedText).not.toContain("sk-1234567890abcdef");
      expect(result.redactedText).not.toContain("postgres://user:password");
    });

    it("still blocks exploit details and recognizes private repository remotes", () => {
      const result = checkDraftSafety(
        [
          "Do not publish the SQL injection payload: ' OR 1=1 --",
          "Origin was git@github.com:acme/secret-project.git during cleanup."
        ].join(" ")
      );

      expect(result.report.status).toBe("blocked");
      expect(result.report.exportAllowed).toBe(false);
      expect(result.report.risks).toEqual(
        expect.arrayContaining([
          {
            category: "exploit-detail",
            severity: "blocked",
            message: "Exploit detail was redacted."
          },
          {
            category: "private-repo-remote",
            severity: "warning",
            message: "Private repository remote was redacted."
          }
        ])
      );
      expect(result.redactedText).not.toContain("' OR 1=1 --");
      expect(result.redactedText).not.toContain("git@github.com");
    });

    it("keeps every pre-existing category firing independently when an incidental architecture-disclosure mention is mixed in", () => {
      // Composability check: a single incidental architecture-disclosure
      // fact (one distinct class -> warning severity on its own) must not
      // suppress, merge into, or otherwise change how the other
      // categories are detected, redacted, or severity-mapped alongside it.
      const result = checkDraftSafety(
        [
          "Debug notes lived at /Users/chase/private/todo.md.",
          "Ask dev@example.com about the release.",
          "In passing, docs now mention the route guard once."
        ].join(" ")
      );

      expect(result.report.status).toBe("warning");
      expect(result.report.exportAllowed).toBe(true);
      expect(result.report.risks).toEqual(
        expect.arrayContaining([
          {
            category: "local-path",
            severity: "warning",
            message: "Local absolute path was redacted."
          },
          {
            category: "email",
            severity: "warning",
            message: "Email address was redacted."
          },
          {
            category: "architecture-disclosure",
            severity: "warning",
            message:
              "Security architecture detail was redacted; residual mention should be reviewed before export."
          }
        ])
      );
      expect(result.redactedText).not.toContain("/Users/chase");
      expect(result.redactedText).not.toContain("dev@example.com");
      expect(result.redactedText).not.toContain("route guard");
    });

    it("still blocks on a pre-existing blocked category even when architecture-disclosure only contributes a warning-level mention", () => {
      // A blocked-severity category (secret) co-occurring with a single
      // incidental architecture-disclosure class (warning-level on its
      // own) must still overall block, and both reasons must be
      // independently recorded — the new rule must not downgrade or
      // swallow the pre-existing blocked verdict.
      const result = checkDraftSafety(
        "TOKEN=abc123 was rotated after we touched the route guard in passing."
      );

      expect(result.report.status).toBe("blocked");
      expect(result.report.exportAllowed).toBe(false);
      expect(result.report.risks).toEqual(
        expect.arrayContaining([
          {
            category: "secret",
            severity: "blocked",
            message: "Secret or token was redacted."
          },
          {
            category: "architecture-disclosure",
            severity: "warning",
            message:
              "Security architecture detail was redacted; residual mention should be reviewed before export."
          }
        ])
      );
    });
  });

  describe("(b) reproduction: 2026-06-05 / 2026-06-07 style multi-class disclosure blocks end-to-end", () => {
    it("blocks the anonymized multi-class fixture end-to-end and keeps written artifacts sanitized (AC1, AC2, AC4)", async () => {
      const { io, stdout, stderr } = createIo();
      const fixture = await createRegisteredProjectFixture();
      // Hand-authored anonymized fixture shaped like the 2026-06-05 /
      // 2026-06-07 safetyConcern=true class: FOUR distinct disclosure
      // classes co-occur (admin-allowlist, route-guard, auth-checkpoint,
      // server-side-authorization), so the draft's core content IS the
      // access-control surface and must block.
      const provider = new FixtureAwareProvider({
        draft: createDraft({
          title: "the admin allowlist and route guard finally agreed",
          slides: [
            {
              index: 1,
              title: "Access control day",
              body: "Rebuilt the admin allowlist so only allowlisted admins reach the route guard.",
              visualMood: "route guard glowing on a terminal"
            },
            {
              index: 2,
              title: "Checkpoint",
              body: "The auth checkpoint now runs the server-side authorization check before anything else.",
              visualMood: "auth checkpoint diagram"
            },
            {
              index: 3,
              title: "Close",
              body: "No card rendering happened yet, exactly as scoped.",
              visualMood: "checklist with one unchecked render item"
            }
          ]
        }),
        caption: createCaption({
          caption:
            "오늘은 admin allowlist와 route guard를 다시 손봤다. auth checkpoint와 server-side authorization check까지 정리."
        })
      });

      await writeGitEvent(fixture.project, "2026-06-05");

      const exitCode = await runCli(["generate", "--date", "2026-06-05"], io, {
        homeDir: fixture.homeDir,
        now: () => "2026-06-05T23:30:00.000Z",
        aiProvider: provider
      });
      const outputDir = join(fixture.draftRoot, "2026-06-05", "rev-001");
      const story = (await readJson(join(outputDir, "story.json"))) as {
        title: string;
        slides: Array<{ title: string; body: string; visualMood: string }>;
      };
      const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
      const safetyReport = (await readJson(
        join(outputDir, "safety-report.json")
      )) as {
        status: string;
        exportAllowed: boolean;
        risks: Array<{ category: string; severity: string; message: string }>;
        redactionsApplied: Array<{
          category: string;
          replacement: string;
          count: number;
        }>;
      };

      // AC4: reproduction class blocks end-to-end at the CLI boundary.
      expect(exitCode).toBe(6);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        "Draft blocked by safety checks. Remove blocked sensitive content."
      ]);

      // AC2: safety-report.json records a distinct architecture-disclosure
      // reason (not folded into another category).
      expect(safetyReport.status).toBe("blocked");
      expect(safetyReport.exportAllowed).toBe(false);
      expect(safetyReport.risks).toContainEqual({
        category: "architecture-disclosure",
        severity: "blocked",
        message: "Security architecture detail was redacted."
      });
      expect(safetyReport.redactionsApplied).toContainEqual(
        expect.objectContaining({
          category: "architecture-disclosure",
          replacement: "[redacted-architecture]"
        })
      );
      // No other category leaked into this reproduction's risk list — the
      // block is attributable specifically to architecture-disclosure.
      expect(safetyReport.risks).toEqual([
        {
          category: "architecture-disclosure",
          severity: "blocked",
          message: "Security architecture detail was redacted."
        }
      ]);

      // AC1: the architecture-disclosure detail is ABSENT from the caption
      // and slide surfaces on disk, even though generation was blocked —
      // story.json/caption.txt are written (sanitized) before the CLI
      // boundary throws.
      const disclosureTokens = [
        "admin allowlist",
        "allowlisted admins",
        "route guard",
        "auth checkpoint",
        "server-side authorization"
      ];

      for (const token of disclosureTokens) {
        expect(story.title.toLowerCase()).not.toContain(token);
        expect(caption.toLowerCase()).not.toContain(token);

        for (const slide of story.slides) {
          expect(slide.title.toLowerCase()).not.toContain(token);
          expect(slide.body.toLowerCase()).not.toContain(token);
          expect(slide.visualMood.toLowerCase()).not.toContain(token);
        }
      }

      expect(story.title).toContain("[redacted-architecture]");
      expect(caption).toContain("[redacted-architecture]");
      expect(story.slides[0]?.body).toContain("[redacted-architecture]");
      expect(story.slides[1]?.body).toContain("[redacted-architecture]");
    });

    it("keeps a single-class incidental mention as a warning, exportable, and sanitizes the image-prompt surface (AC1 boundary)", async () => {
      const { io, stdout, stderr } = createIo();
      const fixture = await createRegisteredProjectFixture();
      const imageAssetProvider = new RecordingImageAssetProvider();
      // Exactly ONE disclosure class ("route guard"), echoed in a slide
      // body and the caption — two raw occurrences, one distinct class.
      // This must stay exportable so it reaches visual-asset generation,
      // letting us assert the image-prompt surface is also sanitized.
      const provider = new FixtureAwareProvider({
        draft: createDraft({
          slides: [
            {
              index: 1,
              title: "Signal",
              body: "Collected activity and manual notes were summarized safely.",
              visualMood: "compact terminal summary"
            },
            {
              index: 2,
              title: "Docs",
              body: "Docs now mention the route guard once, nothing else changed.",
              visualMood: "route guard sketch on a whiteboard"
            },
            {
              index: 3,
              title: "Close",
              body: "No card rendering happened yet, exactly as scoped.",
              visualMood: "checklist with one unchecked render item"
            }
          ]
        }),
        caption: createCaption({
          caption: "오늘은 route guard 버그를 하나 잡았다. 나머지는 조용했다."
        })
      });

      await writeGitEvent(fixture.project, "2026-06-07");

      const exitCode = await runCli(["generate", "--date", "2026-06-07"], io, {
        homeDir: fixture.homeDir,
        now: () => "2026-06-07T23:30:00.000Z",
        aiProvider: provider,
        imageAssetProvider
      });
      const outputDir = join(fixture.draftRoot, "2026-06-07", "rev-001");
      const story = (await readJson(join(outputDir, "story.json"))) as {
        slides: Array<{ title: string; body: string; visualMood: string }>;
      };
      const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
      const metadata = await readJson(join(outputDir, "metadata.json"));
      const safetyReport = (await readJson(
        join(outputDir, "safety-report.json")
      )) as {
        status: string;
        exportAllowed: boolean;
        risks: Array<{ category: string; severity: string; message: string }>;
      };

      // AC1 boundary: single class stays a warning and exports.
      expect(exitCode).toBe(0);
      expect(stdout[0]).toContain("Generated text draft");
      expect(stderr).toEqual([
        "Safety warning: Review redactions before export."
      ]);
      expect(metadata).toMatchObject({
        exportPolicy: "warning",
        exportReady: true,
        publishable: true
      });
      expect(safetyReport.status).toBe("warning");
      expect(safetyReport.exportAllowed).toBe(true);
      expect(safetyReport.risks).toContainEqual({
        category: "architecture-disclosure",
        severity: "warning",
        message:
          "Security architecture detail was redacted; residual mention should be reviewed before export."
      });

      // Caption/slide surfaces sanitized.
      expect(story.slides[1]?.body).not.toContain("route guard");
      expect(story.slides[1]?.body).toContain("[redacted-architecture]");
      expect(caption).not.toContain("route guard");
      expect(caption).toContain("[redacted-architecture]");

      // Image-prompt surface: because this draft is exportable, it DOES
      // reach visual-asset generation, whose prompt is built from
      // slide.visualMood. Assert the recorded provider request never saw
      // the raw disclosure token.
      expect(imageAssetProvider.requests.length).toBeGreaterThan(0);
      for (const request of imageAssetProvider.requests) {
        expect(request.prompt).not.toContain("route guard");
        expect(request.promptSummary).not.toContain("route guard");
      }
      expect(
        imageAssetProvider.requests.some((request) =>
          request.prompt.includes("[redacted-architecture]")
        )
      ).toBe(true);
    });
  });
});

class FixtureAwareProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "fixture-model";
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(
    private readonly options: {
      draft: ReturnType<typeof createDraft>;
      caption: CaptionResult;
    }
  ) {}

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    this.requests.push(request);

    if (request.task === "story-plan") {
      return {
        responseJson: JSON.stringify({
          schemaVersion: 1,
          formatName: "Access Control Dispatch",
          voice: "dry coworker",
          tone: "concise and lightly amused",
          reason: "Generation workflow had enough real signals for a compact update.",
          structure: [
            { part: "Signal", purpose: "Name the concrete activity." },
            { part: "Draft", purpose: "Turn it into a diary beat." },
            { part: "Close", purpose: "End without inventing extra work." }
          ],
          suggestedSlideCount: 3,
          captionStyle: "short witty caption",
          doNotMention: ["raw diffs", "private paths"]
        })
      };
    }

    if (request.task === "draft") {
      return { responseJson: JSON.stringify(this.options.draft) };
    }

    if (request.task === "caption") {
      return { responseJson: JSON.stringify(this.options.caption) };
    }

    throw new Error(`Unexpected task: ${request.task}`);
  }
}

class RecordingImageAssetProvider implements ImageAssetProvider {
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

async function createRegisteredProjectFixture(): Promise<{
  directory: string;
  repoDir: string;
  homeDir: string;
  draftRoot: string;
  project: ProjectRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-arch-e2e-"));
  const repoDir = join(directory, "repo");
  const homeDir = join(directory, "home");
  const draftRoot = join(directory, "drafts");

  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Fixture Dev"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "dev@example.com"]);
  await writeConfig(homeDir, draftRoot);

  const registered = await addProject(repoDir, {
    homeDir,
    now: () => "2026-06-05T00:00:00.000Z"
  });

  return {
    directory,
    repoDir,
    homeDir,
    draftRoot,
    project: registered.project
  };
}

async function writeConfig(homeDir: string, draftRoot: string): Promise<void> {
  const configDir = join(homeDir, ".uncommitted");

  await mkdir(join(configDir, "history"), { recursive: true });
  await writeJsonFile(join(configDir, "config.json"), {
    schemaVersion: 1,
    draftRoot,
    scheduleTime: "23:30",
    aiProvider: "mock",
    persona: "wry coworker",
    roastLevel: 2,
    // photo-first + a recording provider lets the incidental-warning case
    // exercise the image-prompt surface end-to-end.
    carouselVisualStyle: "photo-first"
  });
  await writeJsonFile(join(configDir, "history", "formats.json"), {
    schemaVersion: 1,
    formats: []
  });
}

async function writeGitEvent(
  project: ProjectRecord,
  targetDate: string
): Promise<void> {
  const event: GitActivityEvent = {
    schemaVersion: 1,
    source: "git",
    targetDate,
    collectedAt: `${targetDate}T23:00:00.000Z`,
    project: {
      id: project.id,
      name: project.name
    },
    activity: {
      schemaVersion: 1,
      targetDate,
      repository: {
        rootName: project.name
      },
      commits: [
        {
          hash: "abc1234",
          shortHash: "abc1234",
          authorName: "Fixture Dev",
          subject: "harden access control",
          authoredAt: `${targetDate}T10:00:00.000Z`,
          stats: {
            filesChanged: 2,
            insertions: 45,
            deletions: 5
          }
        }
      ],
      dirty: {
        files: [
          {
            path: "src/access-control.ts",
            status: "modified"
          }
        ],
        totals: {
          modified: 1,
          added: 0,
          deleted: 0,
          renamed: 0,
          copied: 0,
          untracked: 0,
          other: 0
        }
      },
      totals: {
        commits: 1,
        filesChanged: 2,
        insertions: 45,
        deletions: 5
      }
    }
  };
  const eventsDir = join(project.root, ".uncommitted", "events", "git");

  await mkdir(eventsDir, { recursive: true });
  await writeJsonFile(join(eventsDir, `${targetDate}.json`), event);
}

function createDraft(
  overrides: Partial<Omit<DiaryDraft, "schemaVersion" | "targetDate" | "metadata">> = {}
) {
  return {
    title: "Access Control Day",
    slides: [
      {
        index: 1,
        title: "Signal",
        body: "Collected activity and manual notes were summarized safely.",
        visualMood: "compact terminal summary"
      },
      {
        index: 2,
        title: "Draft",
        body: "Story and caption artifacts were written for the target date.",
        visualMood: "plain text files"
      },
      {
        index: 3,
        title: "Close",
        body: "No card rendering happened yet, exactly as scoped.",
        visualMood: "checklist with one unchecked render item"
      }
    ],
    altText: "Uncommitted text diary draft generated from local activity.",
    ...overrides
  };
}

function createCaption(overrides: Partial<CaptionResult> = {}): CaptionResult {
  return {
    caption: "오늘은 access control 작업을 했다.",
    hashtags: ["#Uncommitted", "#개발일기"],
    ...overrides
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
