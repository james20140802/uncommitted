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
import type { GitActivityEvent } from "../src/collect-git-command.js";
import type { CaptionResult } from "../src/diary-generator.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import type { MoodPlan } from "../src/story-format-plan.js";

const execFileAsync = promisify(execFile);

type SourceName = "git" | "claude" | "codex" | "github";
type SourcesOverride = Partial<Record<SourceName, { enabled: boolean }>>;

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

describe("generate command — per-source gating", () => {
  it("skips claude/codex/github signals when those sources are disabled", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture({
      sources: {
        git: { enabled: true },
        claude: { enabled: false },
        codex: { enabled: false },
        github: { enabled: false }
      }
    });
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
    await writeCodexSignals(fixture.project, "2026-05-12", [
      {
        projectId: fixture.project.id,
        timestamp: "2026-05-12T09:30:00.000Z",
        kind: "codex-assistant-text",
        summary: "implement the codex session adapter",
        safetyNotes: []
      }
    ]);
    await writeGitHubSignals(fixture.project, "2026-05-12", [
      {
        projectId: fixture.project.id,
        timestamp: "2026-05-12T10:00:00.000Z",
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
    )) as {
      smallWins: string[];
      commitSignals: { totalCommits: number };
    };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // Git signals still present.
    expect(activitySummary.commitSignals.totalCommits).toBe(1);
    // Disabled sources contribute nothing — none of their summaries leak in.
    expect(activitySummary.smallWins).not.toContain(
      "implement the claude session adapter"
    );
    expect(activitySummary.smallWins).not.toContain(
      "implement the codex session adapter"
    );
    expect(activitySummary.smallWins).not.toContain(
      "PR #42 merged: add the github collector"
    );
  });

  it("skips git events when git is disabled in config", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture({
      sources: {
        git: { enabled: false },
        claude: { enabled: true },
        codex: { enabled: true },
        github: { enabled: true }
      }
    });
    const provider = new TaskAwareProvider();

    await writeGitEvent(fixture.project, "2026-05-12");
    // Drop a manual note so projects still have signal — generate should not
    // throw when git is disabled but other inputs exist.
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const activitySummary = (await readJson(
      join(outputDir, "activity-summary.json")
    )) as {
      commitSignals: { totalCommits: number; subjects: string[] };
      manualContext: { noteCount: number };
    };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // Git events were on disk but gating prevented them from loading.
    expect(activitySummary.commitSignals.totalCommits).toBe(0);
    expect(activitySummary.commitSignals.subjects).not.toContain(
      "implement generate command"
    );
    // Manual notes are NOT gated by source config.
    expect(activitySummary.manualContext.noteCount).toBe(1);
  });

  it("legacy configs without a sources key keep all four sources enabled", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture({
      omitSources: true
    });
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
    await writeGitHubSignals(fixture.project, "2026-05-12", [
      {
        projectId: fixture.project.id,
        timestamp: "2026-05-12T10:00:00.000Z",
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
    )) as {
      smallWins: string[];
      commitSignals: { totalCommits: number };
    };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // Missing `sources` key ⇒ all enabled; git + claude + github signals load.
    expect(activitySummary.commitSignals.totalCommits).toBe(1);
    expect(activitySummary.smallWins).toContain(
      "implement the claude session adapter"
    );
    expect(activitySummary.smallWins).toContain(
      "PR #42 merged: add the github collector"
    );
  });

  it("gates the Tier 2 raw-narrative projection by source: a disabled source's raw archive is not projected, an enabled one is", async () => {
    const SEED_TEXT = "raw narrative projection seed turn unique-marker";

    // Disabled run: claude raw archive present on disk, but claude is off.
    const disabledRun = createIo();
    const disabledFixture = await createRegisteredProjectFixture({
      sources: {
        git: { enabled: true },
        claude: { enabled: false },
        codex: { enabled: true },
        github: { enabled: true }
      }
    });
    const disabledProvider = new TaskAwareProvider();
    await writeGitEvent(disabledFixture.project, "2026-05-12");
    await writeClaudeRawArchive(disabledFixture.project, "2026-05-12", [
      { role: "assistant", text: SEED_TEXT, timestamp: "2026-05-12T09:00:00.000Z" }
    ]);

    const disabledExit = await runCli(["generate", "today"], disabledRun.io, {
      homeDir: disabledFixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: disabledProvider
    });

    expect(disabledExit).toBe(0);
    const disabledDraft = disabledProvider.requests.find(
      (request) => request.task === "draft"
    );
    const disabledProjection = (
      disabledDraft?.input as {
        rawNarrativeProjection?: { turns: { text: string }[] };
      }
    ).rawNarrativeProjection;
    // Source gating must keep the disabled source's raw turns out of egress.
    expect(disabledProjection?.turns ?? []).toEqual([]);

    // Enabled run: identical archive, claude on — the turn is projected.
    const enabledRun = createIo();
    const enabledFixture = await createRegisteredProjectFixture({
      sources: {
        git: { enabled: true },
        claude: { enabled: true },
        codex: { enabled: true },
        github: { enabled: true }
      }
    });
    const enabledProvider = new TaskAwareProvider();
    await writeGitEvent(enabledFixture.project, "2026-05-12");
    await writeClaudeRawArchive(enabledFixture.project, "2026-05-12", [
      { role: "assistant", text: SEED_TEXT, timestamp: "2026-05-12T09:00:00.000Z" }
    ]);

    const enabledExit = await runCli(["generate", "today"], enabledRun.io, {
      homeDir: enabledFixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: enabledProvider
    });

    expect(enabledExit).toBe(0);
    const enabledDraft = enabledProvider.requests.find(
      (request) => request.task === "draft"
    );
    const enabledProjection = (
      enabledDraft?.input as {
        rawNarrativeProjection?: { turns: { text: string }[] };
      }
    ).rawNarrativeProjection;
    expect(enabledProjection?.turns.map((turn) => turn.text)).toContain(
      SEED_TEXT
    );
  });
});

async function createRegisteredProjectFixture(options: {
  sources?: SourcesOverride;
  omitSources?: boolean;
} = {}): Promise<{
  directory: string;
  repoDir: string;
  homeDir: string;
  draftRoot: string;
  project: ProjectRecord;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "uncommitted-generate-source-gating-")
  );
  const repoDir = join(directory, "repo");
  const homeDir = join(directory, "home");
  const draftRoot = join(directory, "drafts");

  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Fixture Dev"]);
  await execFileAsync("git", [
    "-C",
    repoDir,
    "config",
    "user.email",
    "dev@example.com"
  ]);
  await writeConfig(homeDir, draftRoot, options);

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

async function writeConfig(
  homeDir: string,
  draftRoot: string,
  options: { sources?: SourcesOverride; omitSources?: boolean }
): Promise<void> {
  const configDir = join(homeDir, ".uncommitted");

  await mkdir(join(configDir, "history"), { recursive: true });

  const baseConfig: Record<string, unknown> = {
    schemaVersion: 1,
    draftRoot,
    scheduleTime: "23:30",
    aiProvider: "mock",
    persona: "wry coworker",
    roastLevel: 2
  };

  if (!options.omitSources) {
    baseConfig.sources = options.sources ?? {
      git: { enabled: true },
      claude: { enabled: true },
      codex: { enabled: true },
      github: { enabled: true }
    };
  }

  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify(baseConfig, null, 2)}\n`,
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
      text: "Manual note that survives git gating.",
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
  await writeSessionSignals(project, targetDate, "claude", signals);
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
  await writeSessionSignals(project, targetDate, "codex", signals);
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
  await writeSessionSignals(project, targetDate, "github", signals);
}

async function writeClaudeRawArchive(
  project: ProjectRecord,
  targetDate: string,
  turns: { role: string; text: string; timestamp: string }[]
): Promise<void> {
  const rawDir = join(
    project.root,
    ".uncommitted",
    "events",
    "claude",
    "raw"
  );

  await mkdir(rawDir, { recursive: true });
  await writeFile(
    join(rawDir, `${targetDate}.jsonl`),
    turns
      .map((turn) => JSON.stringify({ kind: "turn", ...turn }))
      .join("\n") + "\n",
    "utf8"
  );
}

async function writeSessionSignals(
  project: ProjectRecord,
  targetDate: string,
  source: "claude" | "codex" | "github",
  signals: {
    projectId: string;
    timestamp: string;
    kind: string;
    summary: string;
    safetyNotes: string[];
  }[]
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", source);

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.jsonl`),
    signals.map((signal) => JSON.stringify(signal)).join("\n") + "\n",
    "utf8"
  );
}

class TaskAwareProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "fixture-model";
  readonly requests: AiStructuredGenerationRequest[] = [];

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    this.requests.push(request);

    if (request.task === "story-plan") {
      const plan: MoodPlan = {
        schemaVersion: 2,
        mood: "grind",
        angle: "Source-gating test fixture angle.",
        pacing: {
          openWith: "scene",
          shape: "hook-turn-landing",
          suggestedSlideCount: 3
        },
        voice: "dry coworker",
        tone: "concise and lightly amused",
        reason: "Source-gating test fixture.",
        structure: [
          { part: "Signal", purpose: "Name the activity." },
          { part: "Draft", purpose: "Beat the diary." },
          { part: "Close", purpose: "End cleanly." }
        ],
        captionStyle: "short witty caption",
        doNotMention: ["raw diffs", "private paths"],
        formatName: "grind"
      };
      return { responseJson: JSON.stringify(plan) };
    }

    if (request.task === "draft") {
      return {
        responseJson: JSON.stringify({
          title: "Source Gating Day",
          slides: [
            {
              index: 1,
              title: "Signal",
              body: "Collected enabled-source signals.",
              visualMood: "compact terminal summary"
            },
            {
              index: 2,
              title: "Draft",
              body: "Disabled-source signals stayed off the page.",
              visualMood: "plain text files"
            },
            {
              index: 3,
              title: "Close",
              body: "Ended without inventing extra work.",
              visualMood: "checklist"
            }
          ],
          altText: "Source-gating draft fixture."
        })
      };
    }

    if (request.task === "caption") {
      const caption: CaptionResult = {
        caption: "오늘은 소스 게이팅을 텍스트 draft까지 연결했다.",
        hashtags: ["#Uncommitted", "#개발일기"]
      };
      return { responseJson: JSON.stringify(caption) };
    }

    throw new Error(`Unexpected task: ${request.task}`);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
