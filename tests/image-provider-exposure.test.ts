import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiProvider,
  AiProviderRawResponse,
  AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import { runCli } from "../src/cli.js";
import { addProject, type ProjectRecord } from "../src/project-add.js";
import type { GitActivityEvent } from "../src/collect-git-command.js";
import type { CaptionResult } from "../src/diary-generator.js";
import type { CarouselVisualStyleMode } from "../src/carousel-renderer.js";
import type { MoodPlan } from "../src/story-format-plan.js";
import {
  createImageAssetProvider,
  VisualAssetGenerationError,
  type ImageAssetProvider
} from "../src/visual-assets.js";

/**
 * UNC-271 / T6: story-card 모드에서 이미지 프로바이더가 **호출되지 않는다**
 * (부모 AC3)와 photo-first 프로바이더 실패가 **전 카드** story-card
 * 재생성으로 degrade된다(부모 AC4, generate 시점 절반)를 회귀로 고정한다.
 *
 * 두 동작 모두 이미 main에 있다 — 이 파일은 새 동작을 추가하지 않는다.
 * `resolveImageAssetProvider`(src/generate-command.ts:792)의 story-card
 * early-return과 `generateVisualAssetsForDraft`(:815-888)의
 * provider-failed degrade 캐치를 지키는 것이 유일한 목적이다.
 *
 * 하네스는 tests/story-card-generate-e2e.test.ts의 선례(프로젝트 fixture /
 * git 이벤트 / manual note / mock provider / vi.mock으로 실제 구현을
 * 감싸는 패턴)를 그대로 따른다. 그 파일의 헬퍼들은 export되어 있지 않으므로
 * 여기 인라인한다.
 *
 * `src/visual-assets.js`의 `createImageAssetProvider`를 실제 구현을 감싼
 * vi.fn으로 모킹해, "생성자조차 호출되지 않는다"를 직접 관측한다 — CLI
 * 옵션에는 image-provider용 HTTP transport 주입 지점이 없다(브리프가
 * 추정한 `transport` 주입은 `CreateImageAssetProviderOptions`에만 있고,
 * `resolveImageAssetProvider`는 그 옵션을 넘기지 않은 채
 * `createImageAssetProvider`를 인자 없이 호출한다). 그래서 이 파일은
 * 실제로 존재하는 두 주입 지점만 쓴다: `options.imageAssetProvider`
 * (주입된 provider 자체가 호출됐는지)와 `createImageAssetProvider`
 * export(생성자가 호출됐는지).
 */

vi.mock("../src/visual-assets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/visual-assets.js")>();

  return {
    ...actual,
    createImageAssetProvider: vi.fn(actual.createImageAssetProvider)
  };
});

const execFileAsync = promisify(execFile);

type DraftMetadataShape = {
  status: string;
  requestedCarouselVisualStyle: CarouselVisualStyleMode;
  carouselVisualStyle: CarouselVisualStyleMode;
  visualAssets: { fallbackState: string }[];
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

describe("image provider exposure (UNC-271 / parent AC3)", () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn(async (): Promise<Response> => {
    throw new Error("network must not be reached in these tests");
  });

  beforeEach(() => {
    vi.mocked(createImageAssetProvider).mockClear();
    fetchSpy.mockClear();
    // Belt-and-suspenders network isolation: even if some future refactor
    // reintroduced a path to the real provider, a real network call must
    // still be impossible in these tests.
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("never calls the injected image provider in story-card mode", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture({
      carouselVisualStyle: "story-card"
    });
    const provider = new TaskAwareProvider({ storyCards: validStoryCardResponse() });
    const injectedProvider: ImageAssetProvider = {
      name: "test-injected-provider",
      generateImageAsset: vi.fn(async () => ({
        mimeType: "image/png" as const,
        data: new Uint8Array()
      }))
    };

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider,
      imageAssetProvider: injectedProvider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const metadata = (await readJson(
      join(outputDir, "metadata.json")
    )) as DraftMetadataShape;

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`Generated text draft for 2026-05-12: ${outputDir}`]);
    // ① 주입한 provider조차 호출되지 않는다 — story-card는 early-return이다.
    expect(injectedProvider.generateImageAsset).not.toHaveBeenCalled();
    expect(metadata.carouselVisualStyle).toBe("story-card");
    expect(metadata.visualAssets.length).toBeGreaterThan(0);
    expect(
      metadata.visualAssets.every((asset) => asset.fallbackState === "image-generation-disabled")
    ).toBe(true);
  });

  it("never constructs an image provider in story-card mode", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture({
      carouselVisualStyle: "story-card"
    });
    const provider = new TaskAwareProvider({ storyCards: validStoryCardResponse() });

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider
      // No imageAssetProvider injected: if the early-return were removed,
      // resolveImageAssetProvider would fall through to
      // createImageAssetProvider(toAiProviderConfig(config)).
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // ② createImageAssetProvider itself is never called in story-card mode.
    expect(createImageAssetProvider).not.toHaveBeenCalled();
    // ③ No HTTP transport call reaches the network either.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("photo-first generate-time degrade (UNC-271 / parent AC4, generate half)", () => {
  it("regenerates every card as story-card when the provider fails", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture({
      carouselVisualStyle: "photo-first"
    });
    const provider = new TaskAwareProvider({ storyCards: validStoryCardResponse() });
    const failingProvider: ImageAssetProvider = {
      name: "test-failing-provider",
      generateImageAsset: vi.fn(async () => {
        throw new VisualAssetGenerationError("provider exploded", "provider-failed");
      })
    };

    await writeGitEvent(fixture.project, "2026-05-12");
    await writeManualNote(fixture.project, "2026-05-12");

    const exitCode = await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: provider,
      imageAssetProvider: failingProvider
    });
    const outputDir = join(fixture.draftRoot, "2026-05-12", "rev-001");
    const metadata = (await readJson(
      join(outputDir, "metadata.json")
    )) as DraftMetadataShape;

    // 드래프트가 완성된다 (exit 0 경로) — degrade가 없다면
    // GenerateCommandError("visual-generation-failed")가 CLI까지 번져
    // exit 5로 죽고 metadata.json도 쓰이지 않는다.
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(metadata.status).toBe("draft");
    // 요청은 photo-first였지만 실제로는 story-card로 갔다.
    expect(metadata.requestedCarouselVisualStyle).toBe("photo-first");
    expect(metadata.carouselVisualStyle).toBe("story-card");
    // 한 장이 아니라 전 카드가 전환됐다.
    expect(metadata.visualAssets.length).toBeGreaterThan(0);
    expect(
      metadata.visualAssets.every((asset) => asset.fallbackState === "provider-failed")
    ).toBe(true);
    expect(failingProvider.generateImageAsset).toHaveBeenCalled();
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

function validStoryCardResponse() {
  // 픽스처 mood plan의 suggestedSlideCount(3)와 장수를 맞춘다 —
  // 장수 불일치는 형식 위반이다.
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
      },
      {
        type: "typo",
        slots: [
          { name: "headline", lines: ["오늘의 커밋 둘"] },
          { name: "kicker", lines: ["2026-05-12"] }
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
    angle: "Image-provider-exposure fixture angle: one concrete signal.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 3
    },
    reason: "Image-provider-exposure fixture: enough real signals for a compact update.",
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
    title: "Image Provider Exposure Fixture Day",
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
        body: "No unexpected image provider call happened.",
        visualMood: "checklist with one unchecked render item"
      }
    ],
    altText: "Uncommitted text diary draft generated from local activity."
  };
}

function createProviderCaption(): CaptionResult {
  return {
    caption: "오늘은 이미지 프로바이더 노출 방어선을 테스트로 못박았다.",
    hashtags: ["#Uncommitted", "#개발일기"]
  };
}

async function createRegisteredProjectFixture(options: {
  carouselVisualStyle: CarouselVisualStyleMode;
}): Promise<{
  homeDir: string;
  draftRoot: string;
  project: ProjectRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-image-provider-"));
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
  await writeConfig(homeDir, draftRoot, options.carouselVisualStyle);

  const registered = await addProject(repoDir, {
    homeDir,
    now: () => "2026-05-12T00:00:00.000Z"
  });

  return { homeDir, draftRoot, project: registered.project };
}

async function writeConfig(
  homeDir: string,
  draftRoot: string,
  carouselVisualStyle: CarouselVisualStyleMode
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
        carouselVisualStyle
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
          subject: "implement image provider exposure guard",
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
      text: "Wired the image provider exposure regression test.",
      source: "manual"
    })}\n`,
    "utf8"
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
