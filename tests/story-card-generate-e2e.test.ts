import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type {
  AiProvider,
  AiProviderRawResponse,
  AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import { runCli } from "../src/cli.js";
import { writeStoryCardFailureDiagnostics } from "../src/draft-storage.js";
import { generateStoryCardPlan } from "../src/story-card-generator.js";
import type { GitActivityEvent } from "../src/collect-git-command.js";
import type { CaptionResult } from "../src/diary-generator.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import { storyCardRegistry } from "../src/story-card-registry.js";
import type { MoodPlan } from "../src/story-format-plan.js";

/**
 * UNC-265 / T7: 카드 계획이 generate 경로를 타고 story.json까지 실려 나가는지,
 * 그리고 **카드가 실패해도 그날이 죽지 않는지**를 종단으로 증명한다.
 * 부모 AC4(한 장 실패해도 나머지와 드래프트가 계속) / AC5(전부 실패해도 최소
 * typo 한 장으로 완성)의 종단 증거가 이 파일이다.
 *
 * 하네스(프로젝트 fixture / git 이벤트 / manual note / mock provider)는
 * tests/collect-all-generate-e2e.test.ts가 세운 선례를 따라 이 파일에
 * 인라인한다 — tests/generate-command.test.ts의 헬퍼들은 export되어 있지
 * 않고, 그것들을 공용 모듈로 빼는 건 이 이슈 범위 밖의 리팩터링이다.
 */

/**
 * UNC-265 T7 리뷰 반영 (finding 4): "진단 기록 실패가 드래프트 생성을
 * 막아서는 안 된다"는 규칙을 실제로 태워보려면 쓰기 자체를 실패시켜야
 * 한다. 디스크 상태만으로는 이 실패를 주입할 수 없으므로(리비전 출력
 * 경로를 미리 만들어 충돌시키면 allocateNextRevision의 readdir 스캔이
 * 그걸 보고 다른 리비전 번호를 잡아버린다), tests/generate-command.test.ts가
 * 세운 선례대로 실제 구현을 vi.fn(...)으로 감싼다 — 기본 동작은 실제
 * 함수로 그대로 통과하고, 딱 한 테스트만 mockRejectedValueOnce로
 * 한 번의 호출을 실패시킨다.
 */
vi.mock("../src/draft-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/draft-storage.js")>();

  return {
    ...actual,
    writeStoryCardFailureDiagnostics: vi.fn(actual.writeStoryCardFailureDiagnostics)
  };
});

/**
 * UNC-265 T7 리뷰 반영 (finding 2): AiGenerationError가 **아닌** throw도
 * 사유가 진단에 남아야 한다. 이 갈래는 실재한다 — generateStoryCardPlan의
 * 후보 투영·지시문 생성·안전 입력 매핑은 그 함수의 try 블록 **밖**에서
 * 돌아서, 거기서 난 오류는 AiGenerationError로 감싸이지 않고 그대로
 * 빠져나온다. 프로바이더 스텁으로는 만들 수 없는 실패라 위와 같은
 * 방식으로 실제 구현을 감싸고 한 테스트에서만 한 번 실패시킨다.
 */
vi.mock("../src/story-card-generator.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/story-card-generator.js")>();

  return {
    ...actual,
    generateStoryCardPlan: vi.fn(actual.generateStoryCardPlan)
  };
});

const execFileAsync = promisify(execFile);

type StoryCardPlanCardShape = {
  type: string;
  slots: Record<string, string | string[]>;
  source: "generated" | "degraded" | "fallback";
};

type StoryJsonShape = {
  schemaVersion: number;
  storyCardPlan?: {
    schemaVersion: number;
    cards: StoryCardPlanCardShape[];
  };
};

type StoryCardFailureShape = {
  schemaVersion: number;
  stage: string;
  attempts: number;
  cards: {
    cardIndex: number;
    cardType: string | null;
    outcome: "degraded" | "dropped";
    violations: string[];
  }[];
};

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

describe("story card plan in the generate path (UNC-265)", () => {
  it("records every validated card in story.json and writes no failure diagnostics", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      storyCards: validStoryCardResponse()
    });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`Generated text draft for 2026-05-12: ${outputDir}`]);
    expect(provider.requests.map((request) => request.task)).toEqual([
      "story-plan",
      "draft",
      "story-card",
      "caption"
    ]);
    // 하위 호환 추가 필드다 — schemaVersion은 그대로 1이어야 한다.
    expect(story.schemaVersion).toBe(1);
    expect(story.storyCardPlan?.schemaVersion).toBe(1);
    expect(story.storyCardPlan?.cards).toEqual([
      {
        type: "typo",
        slots: { headline: "오늘의 커밋 하나", kicker: "2026-05-12" },
        source: "generated"
      },
      {
        type: "terminal",
        slots: {
          prompt: "~/uncommitted",
          command: "pnpm test",
          output: ["3 passed"]
        },
        source: "generated"
      }
    ]);
    // 카드가 전부 검증을 통과한 실행에는 진단 파일이 남지 않아야 한다.
    expect(await fileExists(join(outputDir, "story-card-failure.json"))).toBe(false);
    await expectCompleteDraft(outputDir);
  });

  it("keeps the surviving cards and degrades only the violating card (parent AC4)", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      storyCards: {
        cards: [
          validTypoCard(),
          {
            type: "terminal",
            slots: [
              { name: "prompt", lines: ["~/uncommitted"] },
              // terminal.command의 maxLength는 60이다.
              { name: "command", lines: ["x".repeat(80)] }
            ]
          }
        ]
      }
    });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const cards = story.storyCardPlan?.cards ?? [];

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // 형제 카드는 그대로 살아남는다.
    expect(cards[0]).toEqual({
      type: "typo",
      slots: { headline: "오늘의 커밋 하나", kicker: "2026-05-12" },
      source: "generated"
    });
    // 실패한 카드는 같은 종류의 결정론적 기본값으로 남는다.
    expect(cards[1]?.type).toBe("terminal");
    expect(cards[1]?.source).toBe("degraded");
    expect(cards[1]?.slots.command).not.toContain("xxxx");

    const diagnostics = (await readJson(
      join(outputDir, "story-card-failure.json")
    )) as StoryCardFailureShape;

    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      stage: "story-card",
      cards: [
        {
          cardIndex: 1,
          cardType: "terminal",
          outcome: "degraded",
          violations: ["card-text-too-long"]
        }
      ]
    });
    // 형식 위반은 재시도를 한 번 태운다 (STORY_CARD_MAX_ATTEMPTS = 2).
    expect(diagnostics.attempts).toBe(2);
    await expectCompleteDraft(outputDir);
  });

  it("falls back to a single typo card when every card is out of candidates (parent AC5)", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      storyCards: {
        cards: [
          { type: "not-a-card-kind", slots: [{ name: "headline", lines: ["…"] }] },
          { type: "also-not-a-kind", slots: [{ name: "headline", lines: ["…"] }] }
        ]
      }
    });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const cards = story.storyCardPlan?.cards ?? [];

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.type).toBe("typo");
    expect(cards[0]?.source).toBe("fallback");

    const diagnostics = (await readJson(
      join(outputDir, "story-card-failure.json")
    )) as StoryCardFailureShape;

    expect(diagnostics.cards).toEqual([
      {
        cardIndex: 0,
        cardType: "not-a-card-kind",
        outcome: "dropped",
        violations: ["card-unknown-type"]
      },
      {
        cardIndex: 1,
        cardType: "also-not-a-kind",
        outcome: "dropped",
        violations: ["card-unknown-type"]
      }
    ]);
    await expectCompleteDraft(outputDir);
  });

  it("completes a quiet day with at least one card and no empty required slot", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    // 조용한 날의 후보는 typo 하나뿐이다 (나머지 종류의 requires()가 거짓).
    // terminal 카드는 그래서 "오늘의 후보가 아니다"로 거부되어야 한다.
    const provider = new TaskAwareProvider({
      storyCards: validStoryCardResponse()
    });

    const exitCode = await runCli(["generate", "--date", "2026-05-11"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-11", "rev-001");
    const activitySummary = (await readJson(
      join(outputDir, "activity-summary.json")
    )) as { activityLevel: string };
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const cards = story.storyCardPlan?.cards ?? [];

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // 이 시나리오가 정말 조용한 날을 태우는지부터 못 박는다. fixture가
    // 언젠가 이 날짜에 활동을 만들기 시작하면, 이 단언이 없으면 테스트는
    // 계속 통과하면서 조용한 날 경로를 더 이상 검증하지 않게 된다.
    expect(activitySummary.activityLevel).toBe("none");
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0]).toMatchObject({ type: "typo", source: "generated" });
    expectNoEmptyRequiredSlot(cards);
    await expectCompleteDraft(outputDir);
  });

  it("still completes the draft when card generation fails at the provider level", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({ failStoryCards: true });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const cards = story.storyCardPlan?.cards ?? [];

    // 카드 생성 실패가 exit 4로 번지지 않는다.
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0]?.source).toBe("fallback");
    expectNoEmptyRequiredSlot(cards);

    const diagnostics = (await readJson(
      join(outputDir, "story-card-failure.json")
    )) as StoryCardFailureShape & { providerFailure?: { code: string } };

    expect(diagnostics).toMatchObject({
      stage: "story-card",
      attempts: 0,
      cards: []
    });
    // 프로바이더 호출 자체가 죽은 실행은 그 사실을 진단에 남긴다 (부모 AC6).
    expect(diagnostics.providerFailure?.code).toBe("provider-failed");
    await expectCompleteDraft(outputDir);
  });

  it("records the cause when card generation throws a non-AiGenerationError", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({
      storyCards: validStoryCardResponse()
    });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    // 후보 투영·지시문 생성 단계의 프로그래밍 오류를 흉내낸다 — 프로바이더
    // 실패가 아니라 분류되지 않은 예외다.
    vi.mocked(generateStoryCardPlan).mockRejectedValueOnce(
      new TypeError("candidates is not iterable")
    );

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const diagnostics = (await readJson(
      join(outputDir, "story-card-failure.json")
    )) as StoryCardFailureShape & {
      providerFailure?: { code: string; message: string };
    };

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(story.storyCardPlan?.cards[0]?.source).toBe("fallback");
    // 아무것도 설명하지 못하는 `{ attempts: 0, cards: [] }`만 남아서는 안 된다.
    expect(diagnostics.providerFailure?.message).toContain(
      "candidates is not iterable"
    );
    expect(diagnostics.providerFailure?.message).toContain("Unclassified");
    await expectCompleteDraft(outputDir);
  });

  it("still completes the draft when writing the failure diagnostics itself fails", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();
    const provider = new TaskAwareProvider({ failStoryCards: true });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    // 진단 기록 호출 딱 한 번을 실패시킨다 (디스크 가득 참·권한 등).
    // 앞선 시나리오들도 같은 모듈 mock을 공유하므로 호출 수를 먼저 비운다.
    vi.mocked(writeStoryCardFailureDiagnostics).mockClear();
    vi.mocked(writeStoryCardFailureDiagnostics).mockRejectedValueOnce(
      new Error("disk full")
    );

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const story = (await readJson(join(outputDir, "story.json"))) as StoryJsonShape;
    const cards = story.storyCardPlan?.cards ?? [];

    // 카드 실패도, 그 실패를 기록하려다 난 실패도 그날을 죽이지 않는다.
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(vi.mocked(writeStoryCardFailureDiagnostics)).toHaveBeenCalledTimes(1);
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0]?.source).toBe("fallback");
    expectNoEmptyRequiredSlot(cards);
    // 쓰기가 죽었으니 진단 파일은 남지 않는다 — 그래도 드래프트는 완성된다.
    expect(await fileExists(join(outputDir, "story-card-failure.json"))).toBe(false);
    await expectCompleteDraft(outputDir);
  });
});

/**
 * 드래프트가 "완성"되었다는 뜻: 필수 아티팩트 4종이 전부 있고 metadata가
 * draft 상태다. story-card-failure.json은 필수 목록에 들어가지 않으므로
 * 여기서 따지지 않는다 — 그게 카드 실패가 그날을 죽이지 않는다는 규칙이다.
 */
async function expectCompleteDraft(outputDir: string): Promise<void> {
  const metadata = (await readJson(join(outputDir, "metadata.json"))) as {
    status: string;
  };

  expect(metadata.status).toBe("draft");

  for (const name of [
    "activity-summary.json",
    "story.json",
    "caption.txt",
    "safety-report.json"
  ]) {
    expect(await fileExists(join(outputDir, name))).toBe(true);
  }
}

function expectNoEmptyRequiredSlot(cards: StoryCardPlanCardShape[]): void {
  for (const card of cards) {
    const definition = storyCardRegistry.find((kind) => kind.id === card.type);

    expect(definition).toBeDefined();

    for (const [slotName, spec] of Object.entries(definition?.slots ?? {})) {
      if (!spec.required) continue;

      const value = card.slots[slotName];
      const lines = Array.isArray(value) ? value : [value ?? ""];

      expect(lines.some((line) => line.trim().length > 0)).toBe(true);
    }
  }
}

function validTypoCard() {
  return {
    type: "typo",
    slots: [
      { name: "headline", lines: ["오늘의 커밋 하나"] },
      { name: "kicker", lines: ["2026-05-12"] }
    ]
  };
}

function validStoryCardResponse() {
  return {
    cards: [
      validTypoCard(),
      {
        type: "terminal",
        slots: [
          { name: "prompt", lines: ["~/uncommitted"] },
          { name: "command", lines: ["pnpm test"] },
          { name: "output", lines: ["3 passed"] }
        ]
      }
    ]
  };
}

class TaskAwareProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "fixture-model";
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(
    private readonly options: {
      storyCards?: unknown;
      failStoryCards?: boolean;
    } = {}
  ) {}

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
      if (this.options.failStoryCards) {
        throw new Error("card provider unavailable");
      }

      return {
        responseJson: JSON.stringify(this.options.storyCards ?? { cards: [] })
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
    angle: "Story-card E2E fixture angle: one concrete, unglamorous signal.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 3
    },
    reason: "Story-card E2E fixture: enough real signals for a compact update.",
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
    title: "Story Card Wiring Day",
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
    altText: "Uncommitted text diary draft generated from local activity."
  };
}

function createProviderCaption(): CaptionResult {
  return {
    caption: "오늘은 story card 계획을 story.json까지 연결했다.",
    hashtags: ["#Uncommitted", "#개발일기"]
  };
}

async function createRegisteredProjectFixture(): Promise<{
  homeDir: string;
  draftRoot: string;
  project: ProjectRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-story-card-"));
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
          subject: "implement story card wiring",
          authoredAt: `${targetDate}T10:00:00.000Z`,
          stats: { filesChanged: 2, insertions: 45, deletions: 5 }
        }
      ],
      dirty: {
        files: [{ path: "src/generate-command.ts", status: "modified" }],
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
      text: "Wired the story card plan into the generate path.",
      source: "manual"
    })}\n`,
    "utf8"
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
