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
import type { CaptionResult, DiaryDraft } from "../src/diary-generator.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import type { SourceName } from "../src/source-config.js";
import type { StoryFormatPlan } from "../src/story-format-plan.js";

const execFileAsync = promisify(execFile);

// End-to-end regression for UNC-120 epic acceptance criterion:
// `collect all` followed by `generate today` must produce output that is
// visibly different when non-git sources (claude/codex/github) are enabled
// and seeded with signal fixtures, compared to a git-only baseline run.
//
// Two runs are executed against fully separate tmpdirs (separate fake
// `~/.uncommitted/` config + projects + separate draft roots) so the runs
// cannot interfere with each other. The difference is pinned at two layers:
//   1. The on-disk `activity-summary.json` (`smallWins` field) — non-git
//      signal summaries appear in the full run but not in the baseline.
//   2. The AI-provider prompt-context payload (the `input.highlights` array
//      on the `story-plan` request) — same set-difference, asserted at the
//      contract boundary between `generate` and the AI provider.
describe("collect all → generate today end-to-end (UNC-120)", () => {
  it("baseline (git-only) produces activity-summary without non-git signals", async () => {
    const targetDate = "2026-06-22";
    const { artifacts, providerRequests } = await runScenario({
      targetDate,
      enabledSources: { git: true, claude: false, codex: false, github: false },
      seedNonGit: false
    });

    const summary = artifacts.activitySummary as ActivitySummaryShape;
    const smallWins = summary.smallWins ?? [];
    expect(smallWins.some(containsAnyNonGitMarker)).toBe(false);

    const storyPlanRequest = providerRequests.find(
      (request) => request.task === "story-plan"
    );
    expect(storyPlanRequest).toBeDefined();
    const baselineHighlights = readHighlights(storyPlanRequest!);
    expect(baselineHighlights.some(containsAnyNonGitMarker)).toBe(false);
  });

  it("full run (all sources enabled) produces activity-summary with non-git signals that baseline lacks", async () => {
    const targetDate = "2026-06-22";

    const baseline = await runScenario({
      targetDate,
      enabledSources: { git: true, claude: false, codex: false, github: false },
      seedNonGit: false
    });
    const full = await runScenario({
      targetDate,
      enabledSources: { git: true, claude: true, codex: true, github: true },
      seedNonGit: true
    });

    // Layer 1: on-disk activity summary diff.
    const baselineWins = new Set(
      ((baseline.artifacts.activitySummary as ActivitySummaryShape).smallWins ??
        []) as string[]
    );
    const fullWins = ((full.artifacts.activitySummary as ActivitySummaryShape)
      .smallWins ?? []) as string[];
    const newWins = fullWins.filter((entry) => !baselineWins.has(entry));

    expect(newWins).toContain(NON_GIT_SIGNAL_SUMMARIES.claude);
    expect(newWins).toContain(NON_GIT_SIGNAL_SUMMARIES.codex);
    expect(newWins).toContain(NON_GIT_SIGNAL_SUMMARIES.github);

    // Layer 2: provider prompt-context diff. The story-plan request feeds the
    // AI with the highlights derived from the activity summary; if non-git
    // signals reached the provider, the corresponding summaries must appear
    // there too.
    const baselinePlan = baseline.providerRequests.find(
      (request) => request.task === "story-plan"
    );
    const fullPlan = full.providerRequests.find(
      (request) => request.task === "story-plan"
    );
    expect(baselinePlan).toBeDefined();
    expect(fullPlan).toBeDefined();

    const baselineHighlights = new Set(readHighlights(baselinePlan!));
    const fullHighlights = readHighlights(fullPlan!);
    const newHighlights = fullHighlights.filter(
      (entry) => !baselineHighlights.has(entry)
    );

    expect(newHighlights).toContain(NON_GIT_SIGNAL_SUMMARIES.claude);
    expect(newHighlights).toContain(NON_GIT_SIGNAL_SUMMARIES.codex);
    expect(newHighlights).toContain(NON_GIT_SIGNAL_SUMMARIES.github);
  });
});

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

type EnabledSources = Record<SourceName, boolean>;

type ScenarioResult = {
  fixture: RegisteredProjectFixture;
  artifacts: {
    activitySummary: unknown;
    story: unknown;
    caption: string;
  };
  providerRequests: AiStructuredGenerationRequest[];
};

async function runScenario(options: {
  targetDate: string;
  enabledSources: EnabledSources;
  seedNonGit: boolean;
}): Promise<ScenarioResult> {
  const fixture = await createRegisteredProjectFixture({
    enabledSources: options.enabledSources
  });
  const provider = new TaskAwareProvider();

  // Seed git event for the target date — present in both baseline and full
  // runs so the difference is purely from the non-git sources.
  await writeGitEvent(fixture.project, options.targetDate);

  // Seed claude/codex/github JSONL signals only for the full run.
  if (options.seedNonGit) {
    await writeClaudeSignals(fixture.project, options.targetDate, [
      {
        projectId: fixture.project.id,
        timestamp: `${options.targetDate}T09:00:00.000Z`,
        kind: "claude-assistant-text",
        summary: NON_GIT_SIGNAL_SUMMARIES.claude,
        safetyNotes: []
      }
    ]);
    await writeCodexSignals(fixture.project, options.targetDate, [
      {
        projectId: fixture.project.id,
        timestamp: `${options.targetDate}T10:00:00.000Z`,
        kind: "codex-assistant-text",
        summary: NON_GIT_SIGNAL_SUMMARIES.codex,
        safetyNotes: []
      }
    ]);
    await writeGitHubSignals(fixture.project, options.targetDate, [
      {
        projectId: fixture.project.id,
        timestamp: `${options.targetDate}T11:00:00.000Z`,
        kind: "pr",
        summary: NON_GIT_SIGNAL_SUMMARIES.github,
        safetyNotes: []
      }
    ]);
  }

  const io = createIo();
  const now = () => `${options.targetDate}T23:30:00.000Z`;

  // Use stub invokers so `collect all` is a deterministic pass-through:
  // events are already pre-seeded on disk, so generate reads them directly.
  const stubInvokers = buildStubInvokers();
  const collectExit = await runCli(["collect", "all"], io.io, {
    homeDir: fixture.homeDir,
    now,
    collectInvokers: stubInvokers
  });
  expect(collectExit).toBe(0);

  const generateExit = await runCli(["generate", "today"], io.io, {
    homeDir: fixture.homeDir,
    now,
    aiProvider: provider
  });
  expect(generateExit).toBe(0);
  expect(io.stderr).toEqual([]);

  const outputDir = join(fixture.draftRoot, options.targetDate, "rev-001");
  const activitySummary = JSON.parse(
    await readFile(join(outputDir, "activity-summary.json"), "utf8")
  ) as unknown;
  const story = JSON.parse(
    await readFile(join(outputDir, "story.json"), "utf8")
  ) as unknown;
  const caption = await readFile(join(outputDir, "caption.txt"), "utf8");

  return {
    fixture,
    artifacts: { activitySummary, story, caption },
    providerRequests: provider.requests
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Summaries must include a small-win marker (add/built/fixed/implement/
// implemented/shipped/solved) so the synthesis layer routes them into the
// `smallWins` field. Without that, the per-source readers would still load
// them, but they would not surface on the prompt-context highlights.
const NON_GIT_SIGNAL_SUMMARIES = {
  claude: "implemented the claude source adapter for the collect-all E2E run",
  codex: "shipped the codex source dispatcher wiring for the collect-all E2E run",
  github: "PR #999 merged: add the collect-all github E2E pipeline glue"
} as const;

type ActivitySummaryShape = {
  smallWins?: string[];
};

function containsAnyNonGitMarker(entry: string): boolean {
  return (
    entry === NON_GIT_SIGNAL_SUMMARIES.claude ||
    entry === NON_GIT_SIGNAL_SUMMARIES.codex ||
    entry === NON_GIT_SIGNAL_SUMMARIES.github
  );
}

function readHighlights(request: AiStructuredGenerationRequest): string[] {
  const input = request.input as { highlights?: unknown } | undefined;
  if (!input || !Array.isArray(input.highlights)) {
    return [];
  }
  return input.highlights.filter((value): value is string => typeof value === "string");
}

function buildStubInvokers(): Record<
  SourceName,
  () => Promise<{ successCount: number; failureCount: number; detail?: string }>
> {
  const stub = async () => ({
    successCount: 1,
    failureCount: 0,
    detail: "1 project, 1 signals (stub)"
  });
  return {
    git: stub,
    claude: stub,
    codex: stub,
    github: stub
  };
}

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

// ---------------------------------------------------------------------------
// Fixture + IO helpers (mirror tests/generate-command.test.ts patterns)
// ---------------------------------------------------------------------------

type RegisteredProjectFixture = {
  directory: string;
  repoDir: string;
  homeDir: string;
  draftRoot: string;
  project: ProjectRecord;
};

async function createRegisteredProjectFixture(options: {
  enabledSources: EnabledSources;
}): Promise<RegisteredProjectFixture> {
  const directory = await mkdtemp(
    join(tmpdir(), "uncommitted-collect-all-e2e-")
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
  await writeConfig(homeDir, draftRoot, options.enabledSources);

  const registered = await addProject(repoDir, {
    homeDir,
    now: () => "2026-06-22T00:00:00.000Z"
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
  enabledSources: EnabledSources
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
        persona: "wry coworker",
        roastLevel: 2,
        sources: {
          git: { enabled: enabledSources.git },
          claude: { enabled: enabledSources.claude },
          codex: { enabled: enabledSources.codex },
          github: { enabled: enabledSources.github }
        }
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
          hash: "deadbee",
          shortHash: "deadbee",
          authorName: "Fixture Dev",
          subject: "wire collect-all orchestration",
          authoredAt: `${targetDate}T10:00:00.000Z`,
          stats: {
            filesChanged: 3,
            insertions: 60,
            deletions: 10
          }
        }
      ],
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
        filesChanged: 3,
        insertions: 60,
        deletions: 10
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

type SignalSeed = {
  projectId: string;
  timestamp: string;
  kind: string;
  summary: string;
  safetyNotes: string[];
};

async function writeSignals(
  project: ProjectRecord,
  source: "claude" | "codex" | "github",
  targetDate: string,
  signals: SignalSeed[]
): Promise<void> {
  const eventsDir = join(project.root, ".uncommitted", "events", source);
  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${targetDate}.jsonl`),
    signals.map((signal) => JSON.stringify(signal)).join("\n") + "\n",
    "utf8"
  );
}

async function writeClaudeSignals(
  project: ProjectRecord,
  targetDate: string,
  signals: SignalSeed[]
): Promise<void> {
  await writeSignals(project, "claude", targetDate, signals);
}

async function writeCodexSignals(
  project: ProjectRecord,
  targetDate: string,
  signals: SignalSeed[]
): Promise<void> {
  await writeSignals(project, "codex", targetDate, signals);
}

async function writeGitHubSignals(
  project: ProjectRecord,
  targetDate: string,
  signals: SignalSeed[]
): Promise<void> {
  await writeSignals(project, "github", targetDate, signals);
}

// ---------------------------------------------------------------------------
// Provider stub (inlined from tests/generate-command.test.ts to avoid a
// speculative shared-helper refactor; identical contract).
// ---------------------------------------------------------------------------

class TaskAwareProvider implements AiProvider {
  readonly name = "mock";
  readonly model?: string;
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(
    private readonly options: {
      plan?: StoryFormatPlan;
      draft?: DraftFixture;
      caption?: CaptionResult;
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

type DraftFixture = ReturnType<typeof createProviderDraft>;

function createStoryFormatPlan(
  overrides: Partial<StoryFormatPlan> = {}
): StoryFormatPlan {
  return {
    schemaVersion: 1,
    formatName: "Implementation Dispatch",
    voice: "dry coworker",
    tone: "concise and lightly amused",
    reason: "Collect-all E2E fixture: enough real signals for a compact update.",
    structure: [
      { part: "Signal", purpose: "Name the concrete activity." },
      { part: "Draft", purpose: "Turn it into a diary beat." },
      { part: "Close", purpose: "End without inventing extra work." }
    ],
    suggestedSlideCount: 3,
    captionStyle: "short witty caption",
    doNotMention: ["raw diffs", "private paths"],
    ...overrides
  };
}

function createProviderDraft(
  overrides: Partial<Omit<DiaryDraft, "schemaVersion" | "targetDate" | "metadata">> = {}
) {
  return {
    title: "Collect-All E2E Day",
    slides: [
      {
        index: 1,
        title: "Signal",
        body: "Collected activity from multiple sources was summarized safely.",
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
        body: "Pipeline wrapped cleanly without inventing extra work.",
        visualMood: "checklist with completed items"
      }
    ],
    altText: "Uncommitted text diary draft generated from local activity.",
    ...overrides
  };
}

function createProviderCaption(overrides: Partial<CaptionResult> = {}): CaptionResult {
  return {
    caption: "오늘은 collect all 파이프라인을 끝까지 연결했다.",
    hashtags: ["#Uncommitted", "#개발일기"],
    ...overrides
  };
}
