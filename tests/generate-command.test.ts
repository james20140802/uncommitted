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
import type { DiaryDraft } from "../src/diary-generator.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import type { StoryFormatPlan } from "../src/story-format-plan.js";

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
    const metadata = await readJson(join(outputDir, "metadata.json"));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Generated text draft for 2026-05-12."]);
    expect(provider.requests.map((request) => request.task)).toEqual([
      "story-plan",
      "draft"
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
      targetDate: "2026-05-12",
      artifactVersion: 1,
      provider: "mock",
      files: ["activity-summary.json", "story.json", "caption.txt", "metadata.json"]
    });
    expect(JSON.stringify({ activitySummary, story, metadata })).not.toContain(
      fixture.repoDir
    );
  });

  it("supports --date and generates an honest quiet-day text draft", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      draft: createProviderDraft({
        title: "Quiet Terminal Watch",
        caption: "오늘은 기록된 작업이 없었다. 없는 성과는 만들지 않았다.",
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
    expect(stdout).toEqual(["Generated text draft for 2026-05-11."]);
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
        draft: createProviderDraft({ caption: "첫 번째 draft 감정 기록." })
      })
    });
    const secondExitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:45:00.000Z",
      aiProvider: new TaskAwareProvider({
        draft: createProviderDraft({ caption: "두 번째 draft 감정 기록." })
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
      "Generated text draft for 2026-05-12.",
      "Generated text draft for 2026-05-12."
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
        formatName: "Bug Court Transcript",
        voice: "tired QA narrator",
        tone: "deadpan courtroom"
      })
    });
    const secondProvider = new TaskAwareProvider({
      plan: createStoryFormatPlan({
        formatName: "Refactor Field Notes",
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

    expect(stderr).toEqual([]);
    expect(secondProvider.requests[0]?.input.recentFormats).toEqual([
      {
        date: "2026-05-12",
        formatName: "Bug Court Transcript",
        voice: "tired QA narrator",
        tone: "deadpan courtroom"
      }
    ]);
    expect(formats).toMatchObject({
      schemaVersion: 1,
      formats: [
        {
          date: "2026-05-12",
          formatName: "Refactor Field Notes",
          voice: "field researcher",
          tone: "observant and warm"
        },
        {
          date: "2026-05-12",
          formatName: "Bug Court Transcript",
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
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(
    private readonly options: {
      plan?: StoryFormatPlan;
      draft?: ReturnType<typeof createProviderDraft>;
      failDraft?: boolean;
    } = {}
  ) {}

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

    throw new Error(`Unexpected task: ${request.task}`);
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

function createStoryFormatPlan(
  overrides: Partial<StoryFormatPlan> = {}
): StoryFormatPlan {
  return {
    schemaVersion: 1,
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
    ...overrides
  };
}

function createProviderDraft(
  overrides: Partial<Omit<DiaryDraft, "schemaVersion" | "targetDate" | "metadata">> = {}
) {
  return {
    title: "Generate Command Day",
    caption: "오늘은 generate command를 텍스트 draft까지 연결했다.",
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
    hashtags: ["#Uncommitted", "#개발일기"],
    altText: "Uncommitted text diary draft generated from local activity.",
    ...overrides
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
