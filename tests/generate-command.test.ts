import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
import type { GitActivityEvent } from "../src/collect-git-command.js";
import type { CaptionResult, DiaryDraft } from "../src/diary-generator.js";
import type { MemoryThread } from "../src/memory-store.js";
import { PERSONA_PRESETS, type Persona } from "../src/persona.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import type { Mood, MoodPlan, StoryFormatPlan } from "../src/story-format-plan.js";
import type { ImageAssetProvider, ImageAssetRequest } from "../src/visual-assets.js";

const execFileAsync = promisify(execFile);

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

describe("generate command", () => {
  it("generates today's text draft from collected Git activity and manual notes", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = await readJson(join(outputDir, "activity-summary.json"));
    const story = await readJson(join(outputDir, "story.json"));
    const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
    const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
      visualAssets: unknown[];
    };
    const safetyReport = await readJson(join(outputDir, "safety-report.json"));
    const visualAsset = await readFile(join(outputDir, "visuals", "01.png"));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`Generated text draft for 2026-05-12: ${outputDir}`]);
    expect(provider.requests.map((request) => request.task)).toEqual([
      "story-plan",
      "draft",
      "caption"
    ]);
    expect(activitySummary).toMatchObject({
      schemaVersion: 1,
      targetDate: "2026-05-12",
      activityLevel: "medium",
      commitSignals: {
        totalCommits: 1,
        subjects: ["implement generate command"]
      },
      manualContext: {
        noteCount: 1
      }
    });
    expect(story).toMatchObject({
      schemaVersion: 1,
      targetDate: "2026-05-12",
      title: "Generate Command Day"
    });
    expect(caption).toBe(
      "오늘은 generate command를 텍스트 draft까지 연결했다.\n\n#Uncommitted #개발일기\n"
    );
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      version: 1,
      targetDate: "2026-05-12",
      date: "2026-05-12",
      artifactVersion: 1,
      createdAt: "2026-05-12T23:30:00.000Z",
      provider: "mock",
      model: "fixture-model",
      projects: [
        {
          id: fixture.project.id,
          name: fixture.project.name
        }
      ],
      activityLevel: "medium",
      // createStoryFormatPlan()'s default mood is "grind" (UNC-215: metadata
      // keys on mood, not the fixture's legacy formatName display-name override).
      mood: "grind",
      status: "draft",
      exportPolicy: "safe",
      exportReady: true,
      publishable: true,
      safety: {
        status: "safe",
        message: "Safety check passed.",
        riskCount: 0
      },
      exported: false,
      published: false,
      carouselVisualStyle: "story-card",
      requestedCarouselVisualStyle: "photo-first",
      files: [
        "activity-summary.json",
        "story.json",
        "caption.txt",
        "metadata.json",
        "safety-report.json",
        "visuals/01.png",
        "visuals/02.png",
        "visuals/03.png"
      ],
      visualAssets: [
        {
          schemaVersion: 1,
          slideIndex: 1,
          assetSlotId: "slide-01-visual",
          visualStyle: "story-card",
          provider: "mock",
          filePath: "visuals/01.png",
          fallbackState: "provider-unsupported",
          promptSummary: "compact terminal summary"
        },
        {
          slideIndex: 2,
          assetSlotId: "slide-02-visual",
          fallbackState: "provider-unsupported"
        },
        {
          slideIndex: 3,
          assetSlotId: "slide-03-visual",
          fallbackState: "provider-unsupported"
        }
      ]
    });
    expect([...visualAsset.subarray(0, 8)]).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a
    ]);
    expect(safetyReport).toMatchObject({
      schemaVersion: 1,
      status: "safe",
      exportAllowed: true,
      risks: [],
      redactionsApplied: []
    });
    expect(JSON.stringify({ activitySummary, story, metadata, safetyReport })).not.toContain(
      fixture.repoDir
    );
  });

  it("writes mood (not formatName) into metadata.json and story.json (UNC-215)", async () => {
    const { io } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = await readJson(join(outputDir, "story.json"));
    const metadata = await readJson(join(outputDir, "metadata.json"));

    expect(exitCode).toBe(0);
    expect(metadata).toMatchObject({ mood: "grind" });
    expect(JSON.stringify(story)).not.toContain("formatName");
    expect(JSON.stringify(metadata)).not.toContain("formatName");
  });

  // UNC-203: git commits and manual notes are the only MVP-scope sources
  // (claude/codex/github collection are all MVP-out-of-scope), so if they do
  // not reach reflection the whole memory feature is dead for default users.
  it("reflects git commits and manual notes into project memory threads (UNC-203)", async () => {
    const { io } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const threads = await readThreadLines(fixture.project.root);

    expect(exitCode).toBe(0);
    expect(threads.map((thread) => thread.note)).toEqual(
      expect.arrayContaining([
        "implement generate command",
        "Finished the text draft workflow without exposing [redacted-email] or [redacted-path]"
      ])
    );
  });

  // A `--date` backfill must age memory against the activity's day, not the
  // wall-clock run day, or a backfilled thread looks freshly seen today and
  // never decays/expires on schedule.
  it("stamps memory threads with the target date, not the run date, on --date backfill (UNC-203)", async () => {
    const { io } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "--date", "2026-05-12"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-20T09:00:00.000Z",
      aiProvider: provider
    });
    const threads = await readThreadLines(fixture.project.root);

    expect(exitCode).toBe(0);
    expect(threads).toHaveLength(1);
    expect(threads[0].lastSeen.slice(0, 10)).toBe("2026-05-12");
    expect(threads[0].firstSeen.slice(0, 10)).toBe("2026-05-12");
  });

  it("accepts a structured persona config and threads its backstory into generation requests", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();
    const structuredPersona = PERSONA_PRESETS["까칠한 시니어"].persona;

    await writeConfigWithPersona(
      fixture.homeDir,
      fixture.draftRoot,
      structuredPersona,
      PERSONA_PRESETS["까칠한 시니어"].roastLevel
    );
    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const captionRequest = provider.requests.find(
      (request) => request.task === "caption"
    );
    expect(captionRequest?.input.overview).toContain(
      structuredPersona.identity.backstory
    );
  });

  it("migrates a legacy free-text persona config and threads it into generation requests", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const captionRequest = provider.requests.find(
      (request) => request.task === "caption"
    );
    // writeConfig() (the default fixture setup) writes the legacy string
    // persona "wry coworker" — migratePersona() should carry it through as
    // the migrated persona's backstory.
    expect(captionRequest?.input.overview).toContain("wry coworker");
  });

  it("incorporates collected Claude signals into the activity summary", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeClaudeSignals(fixture.project, "2026-05-12", [
      {
        projectId: fixture.project.id,
        timestamp: "2026-05-12T09:00:00.000Z",
        kind: "claude-assistant-text",
        summary: "implement the claude session adapter",
        safetyNotes: []
      }
    ]);

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = (await readJson(
      join(outputDir, "activity-summary.json")
    )) as { smallWins: string[] };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(activitySummary.smallWins).toContain(
      "implement the claude session adapter"
    );
  });

  it("incorporates collected Codex signals into the activity summary", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeCodexSignals(fixture.project, "2026-05-12", [
      {
        projectId: fixture.project.id,
        timestamp: "2026-05-12T09:00:00.000Z",
        kind: "codex-assistant-text",
        summary: "implement the codex session adapter",
        safetyNotes: []
      }
    ]);

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = (await readJson(
      join(outputDir, "activity-summary.json")
    )) as { smallWins: string[] };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(activitySummary.smallWins).toContain(
      "implement the codex session adapter"
    );
  });

  it("incorporates collected GitHub signals into the activity summary", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeGitHubSignals(fixture.project, "2026-05-12", [
      {
        projectId: fixture.project.id,
        timestamp: "2026-05-12T09:00:00.000Z",
        kind: "pr",
        summary: "PR #42 merged: add the github collector",
        safetyNotes: []
      }
    ]);

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = (await readJson(
      join(outputDir, "activity-summary.json")
    )) as { smallWins: string[] };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(activitySummary.smallWins).toContain(
      "PR #42 merged: add the github collector"
    );
  });

  it("completes warning drafts with a visible safety warning and metadata state", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({ model: "fixture@example.com" });

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
      visualAssets: unknown[];
    };
    const safetyReport = await readJson(join(outputDir, "safety-report.json"));

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([`Generated text draft for 2026-05-12: ${outputDir}`]);
    expect(stderr).toEqual(["Safety warning: Review redactions before export."]);
    expect(metadata).toMatchObject({
      exportPolicy: "warning",
      exportReady: true,
      publishable: true,
      safety: {
        status: "warning",
        message: "Review redactions before export.",
        riskCount: 1
      }
    });
    expect(safetyReport).toMatchObject({
      status: "warning",
      exportAllowed: true,
      risks: [
        {
          category: "email",
          severity: "warning",
          message: "Email address was redacted."
        }
      ]
    });
  });

  it("blocks the reproduction class (dense route-guard/admin disclosure) while keeping the written caption and story slides redacted (UNC-206 / UNC-207)", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      draft: createProviderDraft({
        title: "the admin allowlist finally behaved",
        slides: [
          {
            index: 1,
            title: "route guard drama",
            body: "Fixed the auth checkpoint so the server-side authorization check stopped flaking.",
            visualMood: "route guard glowing on a terminal"
          },
          {
            index: 2,
            title: "quiet slide",
            body: "Nothing sensitive here, just a normal beat.",
            visualMood: "calm desk"
          },
          {
            index: 3,
            title: "Close",
            body: "No card rendering happened yet, exactly as scoped.",
            visualMood: "checklist with one unchecked render item"
          }
        ]
      }),
      caption: createProviderCaption({
        caption: "오늘은 route guard 버그를 잡았다. admin allowlist는 여전히 말썽이다."
      })
    });

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as {
      title: string;
      slides: Array<{ title: string; body: string; visualMood: string }>;
    };
    const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
    const safetyReport = await readJson(join(outputDir, "safety-report.json"));

    // The reproduction class (parent AC4): core content IS the
    // access-control mechanism, so the draft is blocked at the CLI
    // boundary, same exit code / message shape as the other blocked case.
    expect(exitCode).toBe(6);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Draft blocked by safety checks. Remove blocked sensitive content."
    ]);
    expect(safetyReport).toMatchObject({
      status: "blocked",
      exportAllowed: false,
      risks: expect.arrayContaining([
        {
          category: "architecture-disclosure",
          severity: "blocked",
          message: "Security architecture detail was redacted."
        }
      ])
    });

    // AC1 still holds even when the draft is blocked: the written
    // story.json/caption.txt are sanitized in place, never the raw
    // access-control-mechanism detail.
    const disclosureTokens = [
      "route guard",
      "admin allowlist",
      "auth checkpoint",
      "server-side authorization"
    ];

    for (const token of disclosureTokens) {
      expect(story.title).not.toContain(token);
      expect(caption).not.toContain(token);

      for (const slide of story.slides) {
        expect(slide.title).not.toContain(token);
        expect(slide.body).not.toContain(token);
        expect(slide.visualMood).not.toContain(token);
      }
    }

    expect(story.title).toContain("[redacted-architecture]");
    expect(caption).toContain("[redacted-architecture]");
    expect(story.slides[0]?.title).toContain("[redacted-architecture]");
    expect(story.slides[0]?.body).toContain("[redacted-architecture]");
    expect(story.slides[0]?.visualMood).toContain("[redacted-architecture]");
  });

  it("redacts an architecture-disclosure story-plan angle in the written story.json and metadata.json even when the draft is blocked (UNC-206)", async () => {
    const { io } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const disclosurePlan: MoodPlan = {
      ...createStoryFormatPlan(),
      angle:
        "Framed around the route guard and admin allowlist that finally behaved."
    };
    const provider = new TaskAwareProvider({
      plan: disclosurePlan,
      draft: createProviderDraft({
        title: "the admin allowlist finally behaved",
        slides: [
          {
            index: 1,
            title: "route guard drama",
            body: "Fixed the auth checkpoint so the server-side authorization check stopped flaking.",
            visualMood: "route guard glowing on a terminal"
          },
          {
            index: 2,
            title: "quiet slide",
            body: "Nothing sensitive here, just a normal beat.",
            visualMood: "calm desk"
          },
          {
            index: 3,
            title: "Close",
            body: "No card rendering happened yet, exactly as scoped.",
            visualMood: "checklist with one unchecked render item"
          }
        ]
      }),
      caption: createProviderCaption({
        caption: "오늘은 route guard 버그를 잡았다. admin allowlist는 여전히 말썽이다."
      })
    });

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });

    expect(exitCode).toBe(6);

    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as {
      metadata: { angle: string };
    };
    const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
      storyFormat: { angle: string };
    };

    // The blocked draft is still written to disk, but the free-text angle must
    // never carry the raw architecture-disclosure detail into either artifact.
    for (const token of ["route guard", "admin allowlist"]) {
      expect(story.metadata.angle).not.toContain(token);
      expect(metadata.storyFormat.angle).not.toContain(token);
    }
    expect(story.metadata.angle).toContain("[redacted-architecture]");
    expect(metadata.storyFormat.angle).toContain("[redacted-architecture]");
  });

  it("exports a single incidental architecture-disclosure fact echoed in BOTH a slide body and the caption as a warning (UNC-207)", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    // The SAME single fact ("route guard") appears in a slide body AND in the
    // caption — exactly what happens when both are generated from the same
    // activity. That is two RAW occurrences but only ONE disclosure class, so
    // it must stay a warning and export (parent AC1), not block.
    const provider = new TaskAwareProvider({
      draft: createProviderDraft({
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
            visualMood: "plain text files"
          },
          {
            index: 3,
            title: "Close",
            body: "No card rendering happened yet, exactly as scoped.",
            visualMood: "checklist with one unchecked render item"
          }
        ]
      }),
      caption: createProviderCaption({
        caption: "오늘은 route guard 버그를 하나 잡았다. 나머지는 조용했다."
      })
    });

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as {
      slides: Array<{ title: string; body: string; visualMood: string }>;
    };
    const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
    const metadata = await readJson(join(outputDir, "metadata.json"));
    const safetyReport = await readJson(join(outputDir, "safety-report.json"));

    // An incidental, single fact (parent AC1) is sanitized in place but NOT
    // fundamental to the draft's content, so it exports as a warning even
    // when echoed across both fields.
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
    expect(safetyReport).toMatchObject({
      status: "warning",
      exportAllowed: true,
      risks: expect.arrayContaining([
        {
          category: "architecture-disclosure",
          severity: "warning",
          message:
            "Security architecture detail was redacted; residual mention should be reviewed before export."
        }
      ])
    });

    // The token is absent from BOTH written artifacts, and present in
    // redacted form in each.
    expect(story.slides[1]?.body).not.toContain("route guard");
    expect(story.slides[1]?.body).toContain("[redacted-architecture]");
    expect(caption).not.toContain("route guard");
    expect(caption).toContain("[redacted-architecture]");
  });

  it("blocks unsafe drafts at the CLI boundary while preserving inspectable artifacts", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({ model: "TOKEN=abc123" });

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = await readJson(join(outputDir, "activity-summary.json"));
    const story = await readJson(join(outputDir, "story.json"));
    const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
    const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
      visualAssets: unknown[];
    };
    const safetyReport = await readJson(join(outputDir, "safety-report.json"));
    const latest = await readJson(join(fixture.draftRoot, "latest.json"));

    expect(exitCode).toBe(6);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Draft blocked by safety checks. Remove blocked sensitive content."
    ]);
    expect(activitySummary).toMatchObject({ targetDate: "2026-05-12" });
    expect(story).toMatchObject({ title: "Generate Command Day" });
    expect(caption).toContain("오늘은 generate command를 텍스트 draft까지 연결했다.");
    expect(metadata).toMatchObject({
      exportPolicy: "blocked",
      exportReady: false,
      publishable: false,
      safety: {
        status: "blocked",
        message: "Remove blocked sensitive content.",
        riskCount: 1
      }
    });
    expect(safetyReport).toMatchObject({
      status: "blocked",
      exportAllowed: false,
      risks: [
        {
          category: "secret",
          severity: "blocked",
          message: "Secret or token was redacted."
        }
      ]
    });
    expect(latest).toMatchObject({
      targetDate: "2026-05-12",
      revision: "rev-001",
      path: outputDir
    });
  });

  it("supports --date and generates an honest quiet-day text draft", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      draft: createProviderDraft({
        title: "Quiet Terminal Watch",
        slides: [
          {
            index: 1,
            title: "조용한 시작",
            body: "기록된 Git activity나 manual note가 없었다.",
            visualMood: "still terminal"
          },
          {
            index: 2,
            title: "대기",
            body: "없는 작업을 invent하지 않고 조용한 하루를 적었다.",
            visualMood: "waiting cursor"
          },
          {
            index: 3,
            title: "마무리",
            body: "내일의 기록을 기다리는 쪽으로 닫았다.",
            visualMood: "small note"
          }
        ],
        altText: "Quiet-day Uncommitted draft with no recorded work."
      }),
      caption: createProviderCaption({
        caption: "오늘은 기록된 작업이 없었다. 없는 성과는 만들지 않았다.",
        hashtags: ["#Uncommitted", "#QuietDay"]
      })
    });

    const exitCode = await runCli(["generate", "--date", "2026-05-11"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-11", "rev-001");
    const activitySummary = await readJson(join(outputDir, "activity-summary.json"));
    const story = await readJson(join(outputDir, "story.json"));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      `Generated text draft for 2026-05-11: ${outputDir}`
    ]);
    expect(activitySummary).toMatchObject({
      targetDate: "2026-05-11",
      activityLevel: "none",
      dominantTheme: "quiet",
      projects: []
    });
    expect(story).toMatchObject({
      targetDate: "2026-05-11",
      title: "Quiet Terminal Watch"
    });
    expect(provider.requests[0]?.input.quiet).toBe(true);
  });

  it("creates a new revision for each generation and preserves earlier drafts", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();

    await writeGitEvent(fixture.project, "2026-05-12");

    const firstExitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider({
        caption: createProviderCaption({ caption: "첫 번째 draft 감정 기록." })
      })
    });
    const secondExitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:45:00.000Z",
      aiProvider: new TaskAwareProvider({
        caption: createProviderCaption({ caption: "두 번째 draft 감정 기록." })
      })
    });
    const dateDir = join(fixture.draftRoot, "2026-05-12");
    const revOneCaption = await readFile(
      join(dateDir, "rev-001", "caption.txt"),
      "utf8"
    );
    const revTwoCaption = await readFile(
      join(dateDir, "rev-002", "caption.txt"),
      "utf8"
    );
    const latest = await readJson(join(dateDir, "latest.json"));

    expect(firstExitCode).toBe(0);
    expect(secondExitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      `Generated text draft for 2026-05-12: ${join(dateDir, "rev-001")}`,
      `Generated text draft for 2026-05-12: ${join(dateDir, "rev-002")}`
    ]);
    expect(revOneCaption).toBe("첫 번째 draft 감정 기록.\n\n#Uncommitted #개발일기\n");
    expect(revTwoCaption).toBe("두 번째 draft 감정 기록.\n\n#Uncommitted #개발일기\n");
    expect(latest).toEqual({
      schemaVersion: 1,
      targetDate: "2026-05-12",
      revision: "rev-002",
      path: join(dateDir, "rev-002"),
      updatedAt: "2026-05-12T23:45:00.000Z"
    });
  });

  it("records generated story formats so later drafts can vary genre", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const firstProvider = new TaskAwareProvider({
      plan: createStoryFormatPlan({
        mood: "firefight",
        voice: "tired QA narrator",
        tone: "deadpan courtroom"
      })
    });
    const secondProvider = new TaskAwareProvider({
      plan: createStoryFormatPlan({
        mood: "cleanup",
        voice: "field researcher",
        tone: "observant and warm"
      })
    });

    await writeGitEvent(fixture.project, "2026-05-12");

    await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: firstProvider
    });
    await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:45:00.000Z",
      aiProvider: secondProvider
    });

    const formats = await readJson(
      join(fixture.homeDir, ".uncommitted", "history", "formats.json")
    );

    const sharedAngle =
      "The day circled a concrete, unglamorous signal instead of a story.";

    expect(stderr).toEqual([]);
    expect(secondProvider.requests[0]?.input.recentFormats).toEqual([
      {
        date: "2026-05-12",
        mood: "firefight",
        angle: sharedAngle,
        voice: "tired QA narrator",
        tone: "deadpan courtroom"
      }
    ]);
    expect(formats).toMatchObject({
      schemaVersion: 1,
      formats: [
        {
          date: "2026-05-12",
          mood: "cleanup",
          angle: sharedAngle,
          voice: "field researcher",
          tone: "observant and warm"
        },
        {
          date: "2026-05-12",
          mood: "firefight",
          angle: sharedAngle,
          voice: "tired QA narrator",
          tone: "deadpan courtroom"
        }
      ]
    });
  });

  it("returns a config error when no projects are registered", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-generate-empty-"));
    const homeDir = join(directory, "home");

    await writeConfig(homeDir, join(directory, "drafts"));

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider()
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "No registered projects. Run `uncommitted project add .` first."
    ]);
  });

  it("preserves activity-summary.json when draft generation fails", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({ failDraft: true });

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = await readJson(join(outputDir, "activity-summary.json"));

    expect(exitCode).toBe(4);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["AI provider failed. Check provider configuration."]);
    expect(activitySummary).toMatchObject({
      targetDate: "2026-05-12",
      commitSignals: {
        totalCommits: 1
      }
    });
    await expect(readFile(join(outputDir, "story.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("returns a visual-generation error while preserving text draft artifacts", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider(),
      imageAssetProvider: new FailingImageAssetProvider()
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([`Generated text draft for 2026-05-12: ${outputDir}`]);
    expect(stderr).toEqual([]);
    await expect(readJson(join(outputDir, "activity-summary.json"))).resolves.toMatchObject({
      targetDate: "2026-05-12"
    });
    await expect(readJson(join(outputDir, "story.json"))).resolves.toMatchObject({
      title: "Generate Command Day"
    });
    await expect(readFile(join(outputDir, "caption.txt"), "utf8")).resolves.toContain(
      "오늘은 generate command를 텍스트 draft까지 연결했다."
    );
    await expect(readJson(join(outputDir, "safety-report.json"))).resolves.toMatchObject({
      status: "safe"
    });
    const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
      visualAssets: unknown[];
    };

    expect(metadata).toMatchObject({
      carouselVisualStyle: "story-card",
      requestedCarouselVisualStyle: "photo-first"
    });
    expect(metadata.visualAssets[0]).toMatchObject({
      visualStyle: "story-card",
      fallbackState: "provider-failed",
      filePath: "visuals/01.png"
    });
  });

  it("keeps photo-first mode when image generation succeeds", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const imageAssetProvider = new RecordingImageAssetProvider();

    await writeGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider(),
      imageAssetProvider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
      visualAssets: unknown[];
    };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`Generated text draft for 2026-05-12: ${outputDir}`]);
    expect(imageAssetProvider.requests[0]?.prompt).toContain("editorial photo");
    expect(metadata).toMatchObject({
      carouselVisualStyle: "photo-first",
      requestedCarouselVisualStyle: "photo-first"
    });
    expect(metadata.visualAssets[0]).toMatchObject({
      visualStyle: "photo-first",
      fallbackState: "none",
      filePath: "visuals/01.png"
    });
  });

  it("returns collection exit code for malformed stored Git activity", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();

    await writeMalformedGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider()
    });

    expect(exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Stored Git activity is malformed. Re-run `uncommitted collect git`."
    ]);
  });

  it("does not allocate a draft revision when stored activity is malformed", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();

    await writeMalformedGitEvent(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider()
    });

    expect(exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Stored Git activity is malformed. Re-run `uncommitted collect git`."
    ]);
    await expect(readdir(join(fixture.draftRoot, "2026-05-12"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

class TaskAwareProvider implements AiProvider {
  readonly name = "mock";
  readonly model?: string;
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(
    private readonly options: {
      plan?: MoodPlan;
      draft?: ReturnType<typeof createProviderDraft>;
      caption?: CaptionResult;
      failDraft?: boolean;
      model?: string;
    } = {}
  ) {
    this.model = options.model ?? "fixture-model";
  }

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    this.requests.push(request);

    if (request.task === "story-plan") {
      return {
        responseJson: JSON.stringify(this.options.plan ?? createStoryFormatPlan())
      };
    }

    if (request.task === "draft") {
      if (this.options.failDraft) {
        throw new Error("provider unavailable");
      }

      return {
        responseJson: JSON.stringify(this.options.draft ?? createProviderDraft())
      };
    }

    if (request.task === "caption") {
      return {
        responseJson: JSON.stringify(this.options.caption ?? createProviderCaption())
      };
    }

    throw new Error(`Unexpected task: ${request.task}`);
  }
}

class FailingImageAssetProvider implements ImageAssetProvider {
  readonly name = "fixture-image";

  async generateImageAsset(): Promise<never> {
    throw new Error("image provider unavailable");
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
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-generate-"));
  const repoDir = join(directory, "repo");
  const homeDir = join(directory, "home");
  const draftRoot = join(directory, "drafts");

  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Fixture Dev"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "dev@example.com"]);
  await writeConfig(homeDir, draftRoot);

  const registered = await addProject(repoDir, {
    homeDir,
    now: () => "2026-05-12T00:00:00.000Z"
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
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        draftRoot,
        scheduleTime: "23:30",
        aiProvider: "mock",
        persona: "wry coworker",
        roastLevel: 2
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(configDir, "history", "formats.json"),
    `${JSON.stringify({ schemaVersion: 1, formats: [] })}\n`,
    "utf8"
  );
}

async function writeConfigWithPersona(
  homeDir: string,
  draftRoot: string,
  persona: Persona,
  roastLevel: number
): Promise<void> {
  const configDir = join(homeDir, ".uncommitted");

  await mkdir(join(configDir, "history"), { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        draftRoot,
        scheduleTime: "23:30",
        aiProvider: "mock",
        persona,
        roastLevel
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(configDir, "history", "formats.json"),
    `${JSON.stringify({ schemaVersion: 1, formats: [] })}\n`,
    "utf8"
  );
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
          subject: "implement generate command",
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
            path: "src/generate-command.ts",
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
  await writeFile(
    join(eventsDir, `${targetDate}.json`),
    `${JSON.stringify(event, null, 2)}\n`,
    "utf8"
  );
}

async function writeMalformedGitEvent(
  project: ProjectRecord,
  targetDate: string
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", "git");

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.json`),
    `${JSON.stringify(
      {
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
          commits: [{}],
          dirty: {
            files: [],
            totals: {
              modified: 0,
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
            filesChanged: 0,
            insertions: 0,
            deletions: 0
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeManualNote(
  project: ProjectRecord,
  targetDate: string
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", "manual");

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.jsonl`),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "note-1",
      timestamp: `${targetDate}T15:00:00.000Z`,
      date: targetDate,
      projectId: project.id,
      text: "Finished the text draft workflow without exposing dev@example.com or /Users/dev/private.",
      source: "manual"
    })}\n`,
    "utf8"
  );
}

async function writeClaudeSignals(
  project: ProjectRecord,
  targetDate: string,
  signals: {
    projectId: string;
    timestamp: string;
    kind: string;
    summary: string;
    safetyNotes: string[];
  }[]
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", "claude");

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.jsonl`),
    signals.map((signal) => JSON.stringify(signal)).join("\n") + "\n",
    "utf8"
  );
}

async function writeCodexSignals(
  project: ProjectRecord,
  targetDate: string,
  signals: {
    projectId: string;
    timestamp: string;
    kind: string;
    summary: string;
    safetyNotes: string[];
  }[]
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", "codex");

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.jsonl`),
    signals.map((signal) => JSON.stringify(signal)).join("\n") + "\n",
    "utf8"
  );
}

async function writeGitHubSignals(
  project: ProjectRecord,
  targetDate: string,
  signals: {
    projectId: string;
    timestamp: string;
    kind: string;
    summary: string;
    safetyNotes: string[];
  }[]
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", "github");

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.jsonl`),
    signals.map((signal) => JSON.stringify(signal)).join("\n") + "\n",
    "utf8"
  );
}

// Fixture overrides keep the flat legacy shape (formatName/suggestedSlideCount)
// so existing call sites stay unchanged; internally mapped onto the MoodPlan
// the story-plan AI task now returns (mood/angle/pacing.suggestedSlideCount).
// `formatName` here is fixture-only shorthand (never part of the returned
// MoodPlan, which has no formatName field since UNC-215) — callers that need
// a distinct diversity key per fixture (e.g. format-history variety tests)
// vary `mood`.
function createStoryFormatPlan(
  overrides: Partial<Omit<StoryFormatPlan, "schemaVersion">> & {
    mood?: Mood;
  } = {}
): MoodPlan {
  const { mood, ...legacyOverrides } = overrides;
  const plan = {
    formatName: "Implementation Dispatch",
    voice: "dry coworker",
    tone: "concise and lightly amused",
    reason: "Generation workflow had enough real signals for a compact update.",
    structure: [
      {
        part: "Signal",
        purpose: "Name the concrete activity."
      },
      {
        part: "Draft",
        purpose: "Turn it into a diary beat."
      },
      {
        part: "Close",
        purpose: "End without inventing extra work."
      }
    ],
    suggestedSlideCount: 3,
    captionStyle: "short witty caption",
    doNotMention: ["raw diffs", "private paths"],
    ...legacyOverrides
  };

  return {
    schemaVersion: 2,
    mood: mood ?? "grind",
    angle: "The day circled a concrete, unglamorous signal instead of a story.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: plan.suggestedSlideCount
    },
    voice: plan.voice,
    tone: plan.tone,
    reason: plan.reason,
    structure: plan.structure,
    captionStyle: plan.captionStyle,
    doNotMention: plan.doNotMention
  };
}

function createProviderDraft(
  overrides: Partial<Omit<DiaryDraft, "schemaVersion" | "targetDate" | "metadata">> = {}
) {
  return {
    title: "Generate Command Day",
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

function createProviderCaption(overrides: Partial<CaptionResult> = {}): CaptionResult {
  return {
    caption: "오늘은 generate command를 텍스트 draft까지 연결했다.",
    hashtags: ["#Uncommitted", "#개발일기"],
    ...overrides
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readThreadLines(projectRoot: string): Promise<MemoryThread[]> {
  const content = await readFile(
    join(projectRoot, ".uncommitted", "memory", "threads.jsonl"),
    "utf8"
  );

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as MemoryThread);
}
