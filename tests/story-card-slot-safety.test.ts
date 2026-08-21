import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import type {
  AiProvider,
  AiProviderRawResponse,
  AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import type { GitActivityEvent } from "../src/collect-git-command.js";
import { runCli } from "../src/cli.js";
import type { CaptionResult } from "../src/diary-generator.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import {
  checkStoryCardPlanSafety,
  createSafetyReport,
  mergeStoryCardSlotFindings
} from "../src/safety-report.js";
import {
  revalidateStoryCardPlan,
  type StoryCardPlan
} from "../src/story-card-plan.js";
import type { MoodPlan } from "../src/story-format-plan.js";

/**
 * UNC-269 / T5: 카드 슬롯이 렌더 경로를 타고 공개 산출물(story.json,
 * 렌더된 PNG)이 된 이상, 슬롯 원문에 담긴 secret은 export를 막지 않으면서도
 * (2026-07-26 exit 4/6 사고를 반복하지 않으면서) 마스킹되어야 한다.
 * 이 파일은 그 계약을 고정한다.
 */

const fakeToken = "sk-live-000000000000000000000000000000000000000000000000";

const planWithToken: StoryCardPlan = {
  schemaVersion: 1,
  cards: [
    {
      type: "terminal",
      slots: { command: `export OPENAI_API_KEY=${fakeToken}`, output: ["done"] },
      source: "generated"
    },
    {
      type: "typo",
      slots: { headline: "평범한 하루" },
      source: "generated"
    }
  ]
};

function createQuietSummary(): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-08-17",
    generatedAt: "2026-08-17T00:00:00.000Z",
    activityLevel: "none",
    dominantTheme: "quiet",
    projects: [],
    commitSignals: {
      totalCommits: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      subjects: [],
      themes: []
    },
    uncommittedChanges: {
      totalFiles: 0,
      byStatus: {
        modified: 0,
        added: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        untracked: 0,
        other: 0
      },
      files: []
    },
    manualContext: { noteCount: 0, notes: [] },
    smallWins: [],
    blockersOrConfusion: [],
    unfinishedThreads: [],
    possibleJokes: [],
    publicSafetyNotes: [],
    privateItemsToAvoid: [],
    uncertaintyNotes: []
  };
}

const quietSummary = createQuietSummary();

// tests/safety-report.test.ts에서 실제로 "blocked"를 만드는 입력을 그대로
// 가져온다 — 자체 제작한 문자열이 우연히 blocked가 되는 상황에 기대지 않는다.
const realBlockedText =
  "The deployment failed with OPENAI_API_KEY=sk-1234567890abcdef, TOKEN=abc123, SECRET=def456, PASSWORD=hunter2, and Bearer ghp_abcdefghijklmnopqrstuvwxyz.";

describe("checkStoryCardPlanSafety (UNC-269 AC1/AC4)", () => {
  it("masks the secret out of the slot value in place", () => {
    const { plan } = checkStoryCardPlanSafety(planWithToken);
    const masked = JSON.stringify(plan);

    expect(masked).not.toContain(fakeToken);
  });

  it("leaves clean slots untouched", () => {
    const { plan } = checkStoryCardPlanSafety(planWithToken);

    expect(plan.cards[1].slots.headline).toBe("평범한 하루");
  });

  it("records findings per slot, not per draft", () => {
    const { findings } = checkStoryCardPlanSafety(planWithToken);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toMatchObject({
      cardIndex: 0,
      cardType: "terminal",
      slot: "command",
      severity: "warning"
    });
  });

  it("never emits a blocked severity, even for a hard secret match", () => {
    const { findings } = checkStoryCardPlanSafety(planWithToken);

    expect(findings.every((finding) => finding.severity === "warning")).toBe(true);
  });
});

describe("mergeStoryCardSlotFindings (UNC-269 AC2/AC3)", () => {
  it("raises a safe report to warning and keeps export allowed", () => {
    const { findings } = checkStoryCardPlanSafety(planWithToken);
    const merged = mergeStoryCardSlotFindings(createSafetyReport("아무 문제 없는 하루"), findings);

    expect(merged.status).toBe("warning");
    expect(merged.exportAllowed).toBe(true);
    expect(merged.storyCardSlots).toHaveLength(findings.length);
  });

  it("never promotes a report to blocked because of card slots", () => {
    const { findings } = checkStoryCardPlanSafety(planWithToken);
    const merged = mergeStoryCardSlotFindings(createSafetyReport("아무 문제 없는 하루"), findings);

    expect(merged.status).not.toBe("blocked");
  });

  it("leaves an already-blocked report blocked (blocking came from elsewhere)", () => {
    const blocked = createSafetyReport(realBlockedText);

    expect(blocked.status).toBe("blocked");

    const merged = mergeStoryCardSlotFindings(blocked, []);

    expect(merged.status).toBe(blocked.status);
    expect(merged.exportAllowed).toBe(blocked.exportAllowed);
  });

  it("keeps a blocked report blocked even when card slots also carry findings", () => {
    const blocked = createSafetyReport(realBlockedText);
    const { findings } = checkStoryCardPlanSafety(planWithToken);
    const merged = mergeStoryCardSlotFindings(blocked, findings);

    expect(merged.status).toBe("blocked");
    expect(merged.exportAllowed).toBe(false);
  });
});

describe("revalidateStoryCardPlan (UNC-269 — masked slots must still fit)", () => {
  it("degrades a card whose masked slot no longer fits its own limits", () => {
    // headline maxLength 40. 마스킹 치환 문자열이 길어져 한계를 넘는 상황.
    const plan: StoryCardPlan = {
      schemaVersion: 1,
      cards: [
        {
          type: "typo",
          slots: { headline: "x".repeat(200) },
          source: "generated"
        }
      ]
    };

    const revalidated = revalidateStoryCardPlan({ plan, summary: quietSummary });

    expect(revalidated.cards).toHaveLength(1);
    expect(String(revalidated.cards[0].slots.headline).length).toBeLessThanOrEqual(40);
  });

  it("leaves a conforming plan alone", () => {
    const plan: StoryCardPlan = {
      schemaVersion: 1,
      cards: [{ type: "typo", slots: { headline: "짧은 헤드라인" }, source: "generated" }]
    };

    expect(revalidateStoryCardPlan({ plan, summary: quietSummary }).cards[0].slots.headline).toBe(
      "짧은 헤드라인"
    );
  });
});

/**
 * UNC-269 AC2/AC3 종단 증거. 하네스는 tests/story-card-generate-e2e.test.ts의
 * 선례(프로젝트 fixture / git 이벤트 / manual note / mock provider)를 그대로
 * 따른다 — 그 파일도 export된 헬퍼가 없어 인라인했다는 같은 이유로 여기서도
 * 인라인한다.
 */
const execFileAsync = promisify(execFile);

type StoryJsonShape = {
  storyCardPlan?: {
    cards: { type: string; slots: Record<string, string | string[]>; source: string }[];
  };
};

type SafetyReportShape = {
  status: string;
  exportAllowed: boolean;
  storyCardSlots?: { severity: string }[];
};

describe("generate with a secret in a card slot (UNC-269 AC2/AC3)", () => {
  it("finishes with exit 0, records warning, keeps export allowed, and masks story.json", async () => {
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      storyCards: {
        cards: [
          {
            type: "terminal",
            slots: [
              { name: "prompt", lines: ["~/uncommitted"] },
              // terminal.command의 maxLength는 60이다. fakeToken 자체(56자)를
              // 그대로 쓴다 — "TOKEN=" 등 접두사를 붙이면 슬롯 검증(형식
              // 위반)에 먼저 걸려 마스킹 경로 자체를 태우지 못한다.
              { name: "command", lines: [fakeToken] },
              { name: "output", lines: ["done"] }
            ]
          }
        ]
      }
    });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["generate", "today"], {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    }, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const safety = (await readJson(
      join(outputDir, "safety-report.json")
    )) as SafetyReportShape;

    expect(exitCode).toBe(0);
    // 카드 슬롯 경고는 stderr에 "Safety warning: ..." 한 줄을 남긴다 — 이건
    // exit 6이 아니라는 확인이지, 조용히 지나가야 한다는 뜻이 아니다.
    expect(stderr).toEqual(["Safety warning: Review redactions before export."]);
    expect(JSON.stringify(story.storyCardPlan)).not.toContain(fakeToken);
    expect(safety.status).toBe("warning");
    expect(safety.exportAllowed).toBe(true);
    expect(safety.storyCardSlots?.length ?? 0).toBeGreaterThan(0);
    expect(
      (safety.storyCardSlots ?? []).every((finding) => finding.severity === "warning")
    ).toBe(true);
  });
});

function validTypoCard() {
  return {
    type: "typo",
    slots: [
      { name: "headline", lines: ["오늘의 커밋 하나"] },
      { name: "kicker", lines: ["2026-05-12"] }
    ]
  };
}

class TaskAwareProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "fixture-model";
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(private readonly options: { storyCards?: unknown } = {}) {}

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    this.requests.push(request);

    if (request.task === "story-plan") {
      return { responseJson: JSON.stringify(createStoryFormatPlan()) };
    }

    if (request.task === "draft") {
      return { responseJson: JSON.stringify(createProviderDraft()) };
    }

    if (request.task === "story-card") {
      return {
        responseJson: JSON.stringify(this.options.storyCards ?? { cards: [validTypoCard()] })
      };
    }

    if (request.task === "caption") {
      return { responseJson: JSON.stringify(createProviderCaption()) };
    }

    throw new Error(`Unexpected task: ${request.task}`);
  }
}

function createStoryFormatPlan(): MoodPlan {
  return {
    schemaVersion: 2,
    mood: "grind",
    angle: "Story-card slot safety fixture angle: one concrete, unglamorous signal.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 3
    },
    reason: "Story-card slot safety fixture: enough real signals for a compact update.",
    structure: [
      { part: "Signal", purpose: "Name the concrete activity." },
      { part: "Draft", purpose: "Turn it into a diary beat." },
      { part: "Close", purpose: "End without inventing extra work." }
    ],
    captionStyle: "short witty caption",
    doNotMention: ["raw diffs", "private paths"]
  };
}

function createProviderDraft() {
  return {
    title: "Story Card Slot Safety Day",
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
        body: "No secrets leaked into the rendered output.",
        visualMood: "checklist with one unchecked render item"
      }
    ],
    altText: "Uncommitted text diary draft generated from local activity."
  };
}

function createProviderCaption(): CaptionResult {
  return {
    caption: "오늘은 카드 슬롯 안전 검사를 붙였다.",
    hashtags: ["#Uncommitted", "#개발일기"]
  };
}

async function createRegisteredProjectFixture(): Promise<{
  homeDir: string;
  draftRoot: string;
  project: ProjectRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-story-card-safety-"));
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
  await writeConfig(homeDir, draftRoot);

  const registered = await addProject(repoDir, {
    homeDir,
    now: () => "2026-05-12T00:00:00.000Z"
  });

  return { homeDir, draftRoot, project: registered.project };
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

async function writeGitEvent(
  project: ProjectRecord,
  targetDate: string
): Promise<void> {
  const event: GitActivityEvent = {
    schemaVersion: 1,
    source: "git",
    targetDate,
    collectedAt: `${targetDate}T23:00:00.000Z`,
    project: { id: project.id, name: project.name },
    activity: {
      schemaVersion: 1,
      targetDate,
      repository: { rootName: project.name },
      commits: [
        {
          hash: "abc1234",
          shortHash: "abc1234",
          authorName: "Fixture Dev",
          subject: "implement story card slot safety",
          authoredAt: `${targetDate}T10:00:00.000Z`,
          stats: { filesChanged: 2, insertions: 45, deletions: 5 }
        }
      ],
      dirty: {
        files: [{ path: "src/safety-report.ts", status: "modified" }],
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
      totals: { commits: 1, filesChanged: 2, insertions: 45, deletions: 5 }
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
      text: "Wired the story card slot safety check into the generate path.",
      source: "manual"
    })}\n`,
    "utf8"
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
