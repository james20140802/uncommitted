import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildActivitySummary,
  buildSignalsFromInput,
  type ActivitySummary
} from "./activity-summary.js";
import {
  AiGenerationError,
  createAiProvider,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderName
} from "./ai-provider.js";
import {
  createCarouselHtmlCards,
  type CarouselVisualStyleMode
} from "./carousel-renderer.js";
import type { GitActivityEvent } from "./collect-git-command.js";
import { redactArchitectureDisclosure } from "./architecture-disclosure.js";
import { buildCaptionCardGist } from "./caption-card-gist.js";
import { isActivitySignal, type ActivitySignal } from "./event-source.js";
import { resolveConfigPaths } from "./config-paths.js";
import type { MemoryThread } from "./memory-store.js";
import { gateMemoryForInjection } from "./memory-safety-gate.js";
import { readCoreFacts } from "./persona-core-facts.js";
import { reflectProjectThreads } from "./reflection.js";
import {
  isRoastLevel,
  loadGlobalConfig,
  type GlobalConfig
} from "./global-config.js";
import { isPersona, selectPersona, type Persona } from "./persona.js";
import { isNodeError, isRecord } from "./type-guards.js";
import {
  CAPTION_MAX_ATTEMPTS,
  deriveCaptionText,
  generateCaption,
  generateDiaryDraft,
  redactArchitectureDisclosureFromCaption,
  redactArchitectureDisclosureFromDraft,
  type DiaryDraft
} from "./diary-generator.js";
import {
  createDraftRevision,
  DraftStorageError,
  writeCaptionFailureDiagnostics,
  writeDraftArtifactJson,
  writeDraftArtifactText,
  writeIncompleteDraftMarker,
  writeLatestDraftPointer,
  writeStoryCardFailureDiagnostics,
  type StoryCardFailureCardRecord,
  type StoryCardFailureProviderFailure
} from "./draft-storage.js";
import {
  generateStoryCardPlan,
  type StoryCardGenerationResult
} from "./story-card-generator.js";
import {
  assembleStoryCardPlan,
  revalidateStoryCardPlan,
  type StoryCardEntryOutcome,
  type StoryCardPlan
} from "./story-card-plan.js";
import type { ManualNoteEvent } from "./note-command.js";
import type { ProjectRecord, ProjectsFile } from "./project-add.js";
import { loadSourceConfig } from "./source-config.js";
import { buildRawNarrativeProjection } from "./raw-narrative-archive.js";
import {
  emptyRawNarrativeProjection,
  readCaptionProjectionTokenBudget
} from "./raw-narrative-projection.js";
import {
  checkStoryCardPlanSafety,
  createSafetyReport,
  mergeStoryCardSlotFindings,
  rescanStoryCardPlanAfterRevalidation,
  type SafetyReport,
  type SafetyStatus
} from "./safety-report.js";
import {
  generateStoryFormatPlan,
  loadRecentStoryFormatHistory,
  recordStoryFormatHistory,
  type Mood,
  type MoodPlan
} from "./story-format-plan.js";
import {
  createImageAssetProvider,
  generateCarouselVisualAssets,
  type ImageAssetProvider,
  VisualAssetGenerationError,
  type VisualAssetGenerationResult,
  type VisualAssetMetadata
} from "./visual-assets.js";

export type GenerateCommandErrorCode =
  | "invalid-arguments"
  | "invalid-config"
  | "invalid-data"
  | "no-projects"
  | "safety-blocked"
  | "visual-generation-failed";

export class GenerateCommandError extends Error {
  constructor(
    message: string,
    public readonly code: GenerateCommandErrorCode,
    public readonly outputDir?: string
  ) {
    super(message);
    this.name = "GenerateCommandError";
  }
}

export type GenerateCommandOptions = {
  homeDir?: string;
  now?: () => string;
  aiProvider?: AiProvider;
  imageAssetProvider?: ImageAssetProvider;
};

export type GenerateCommandResult = {
  targetDate: string;
  outputDir: string;
  revision: string;
  latestPointerPath: string;
  activitySummary: ActivitySummary;
  storyFormatPlan: MoodPlan;
  draft: DiaryDraft;
  caption: string;
  safetyReport: SafetyReport;
  visualAssets: VisualAssetGenerationResult;
  exportPolicy: SafetyStatus;
  exportReady: boolean;
};

// `persona` is structured (`Persona`) here, not the legacy `AiProviderConfig`
// string — see `toAiProviderConfig` for the adapter used at AI-provider
// construction boundaries that still expect the legacy string shape.
type GenerateConfig = Omit<AiProviderConfig, "persona"> & {
  draftRoot: string;
  carouselVisualStyle: CarouselVisualStyleMode;
  persona: Persona;
};

// On-disk view of the canonical GlobalConfig that `generate` needs, with
// `aiProvider` narrowed to a known provider and `carouselVisualStyle` optional
// (older configs may omit it). `persona` accepts both the structured shape
// and the legacy free-text string still found in unmigrated config files;
// `isGenerateConfigFile` accepts either at runtime and `selectPersona`
// normalizes it.
type GenerateConfigFile = Pick<
  GlobalConfig,
  "schemaVersion" | "draftRoot" | "roastLevel"
> & {
  aiProvider: AiProviderName;
  carouselVisualStyle?: CarouselVisualStyleMode;
  persona: Persona | string;
};

type DraftMetadataBase = {
  schemaVersion: 1;
  version: 1;
  artifactVersion: 1;
  date: string;
  targetDate: string;
  createdAt: string;
  generatedAt: string;
  provider: AiProviderName;
  model?: string;
  activityLevel: ActivitySummary["activityLevel"];
  mood: Mood;
  storyFormat: {
    mood: Mood;
    angle: string;
  };
  projects: {
    id: string;
    name: string;
  }[];
  projectIds: string[];
  status: "draft";
  exported: false;
  published: false;
  files: string[];
  requestedCarouselVisualStyle: CarouselVisualStyleMode;
  carouselVisualStyle: CarouselVisualStyleMode;
};

type DraftMetadata = DraftMetadataBase & {
  exportPolicy: SafetyStatus;
  exportReady: boolean;
  publishable: boolean;
  visualAssets: VisualAssetMetadata[];
  safety: {
    status: SafetyStatus;
    message: string;
    riskCount: number;
  };
};

const usage = "Usage: uncommitted generate today | uncommitted generate --date YYYY-MM-DD";
const providerNames: readonly AiProviderName[] = [
  "none",
  "mock",
  "openai",
  "anthropic",
  "google",
  "ollama",
  "mistral",
  "openrouter"
];
const dirtyStatuses = new Set([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "other"
]);
const baseDraftFiles = [
  "activity-summary.json",
  "story.json",
  "caption.txt",
  "metadata.json",
  "safety-report.json"
];

export async function runGenerateCommand(
  args: string[],
  options: GenerateCommandOptions = {}
): Promise<GenerateCommandResult> {
  const targetDate = parseGenerateDate(args, options.now);
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const config = await readGenerateConfig(paths.configFile, options.homeDir);
  const projectsFile = await readProjectsFile(paths.projectsFile);
  const projects = projectsFile.projects.filter((project) => project.enabled);

  if (projects.length === 0) {
    throw new GenerateCommandError(
      "No registered projects. Run `uncommitted project add .` first.",
      "no-projects"
    );
  }

  const generatedAt = options.now ? options.now() : new Date().toISOString();
  const sourceConfig = await loadSourceConfig(paths.configFile);
  // Tier 2 raw-narrative projection. A projection failure must never break
  // generation — absent archives are already handled gracefully inside, so on
  // any unexpected error we fall back to an empty projection.
  let rawNarrativeProjection;
  try {
    rawNarrativeProjection = await buildRawNarrativeProjection({
      projects: projects.map((project) => ({
        id: project.id,
        root: project.root
      })),
      sourceConfig,
      configFilePath: paths.configFile,
      targetDate
    });
  } catch {
    rawNarrativeProjection = emptyRawNarrativeProjection(
      await readCaptionProjectionTokenBudget(paths.configFile)
    );
  }
  const gitEvents = sourceConfig.git.enabled
    ? await readGitActivityEvents(projects, targetDate)
    : [];
  // Manual notes are project-local user input, not a tracked source — they are
  // loaded unconditionally regardless of per-source enable flags.
  const manualNotes = await readManualNoteEvents(projects, targetDate);
  const claudeSignals = sourceConfig.claude.enabled
    ? await readClaudeActivitySignals(projects, targetDate)
    : [];
  const codexSignals = sourceConfig.codex.enabled
    ? await readCodexActivitySignals(projects, targetDate)
    : [];
  const githubSignals = sourceConfig.github.enabled
    ? await readGitHubActivitySignals(projects, targetDate)
    : [];
  // UNC-222 / T2: reflection runs BEFORE buildActivitySummary so the resulting
  // threads are available for T3's activity-summary injection. Signals are
  // grouped by `projectId` (not by which source produced them — a thread is a
  // per-project concept) and folded into that project's on-disk thread store
  // via `reflectProjectThreads`, which itself re-derives every note through
  // `sanitizeText` + the safety gate (see reflection.ts
  // `deriveSafeThreadNote`) before persisting — no raw/unredacted and no
  // safety-blocked text ever reaches `threads.jsonl`.
  //
  // `memoryThreadsByProject` is kept in scope (rather than discarded) so it
  // can be flattened into a single list and injected into
  // `buildActivitySummary` below (UNC-223 / T3), without re-reading
  // `threads.jsonl` from disk.
  //
  // Memory is aged against the ACTIVITY's day, not the wall-clock run time:
  // on a `--date` backfill the two differ, and stamping `lastSeen` with the
  // run time would make a backfilled thread look freshly seen today and keep
  // it alive long past its decay/expiry window. `reflectionClock` is the run
  // time for a same-day run (targetDate's end-of-day is still ahead) and the
  // end of targetDate for a backfill.
  const reflectionClock = memoryClock(targetDate, generatedAt);
  // Git commits and manual notes are the only MVP-scope sources (Claude /
  // Codex / GitHub collection are all MVP-out-of-scope), so reflection has to
  // consume them or the memory feature is inert for default users.
  // `buildSignalsFromInput` is the same normalizer buildActivitySummary uses,
  // so both paths see byte-identical, already-redacted signals.
  //
  // `dirty-file` signals are deliberately excluded: an uncommitted file is
  // per-day working state, not a recurring topic, and it already reaches the
  // summary through the source-shaped `unfinishedThreads` aggregate. Letting
  // it create threads would spend the top-K budget on "modified: <path>".
  const sourceSignals = buildSignalsFromInput({
    targetDate,
    gitEvents,
    manualNotes
  }).filter((signal) => signal.kind !== "dirty-file");
  const allSignals = [
    ...sourceSignals,
    ...claudeSignals,
    ...codexSignals,
    ...githubSignals
  ];
  const memoryThreadsByProject = new Map<string, MemoryThread[]>();

  for (const project of projects) {
    const projectSignals = allSignals.filter(
      (signal) => signal.projectId === project.id
    );
    // Reflection is a best-effort side-channel. Persisting threads.jsonl does
    // filesystem I/O (mkdir + writeFile) that can fail per project (read-only
    // fs, permissions, disk full). A failure here must never break the core
    // draft/caption/carousel output — generate is what the launchd scheduler
    // runs unattended, so it has to preserve partial output and keep future
    // runs alive. On any failure we fall back to no threads for that project,
    // mirroring the rawNarrativeProjection guard above.
    try {
      const threads = await reflectProjectThreads(
        project.root,
        projectSignals,
        reflectionClock
      );

      memoryThreadsByProject.set(project.id, threads);
    } catch {
      memoryThreadsByProject.set(project.id, []);
    }
  }

  // UNC-223 / T3: flatten the per-project reflected threads into one list and
  // read the durable persona core facts, then inject both into the existing
  // `unfinishedThreads`/`possibleJokes` slots (see activity-summary.ts).
  const memoryThreads = Array.from(memoryThreadsByProject.values()).flat();
  const coreFacts = await readCoreFacts(options.homeDir);

  // UNC-224 / T4: gate reflected threads and core facts through the existing
  // safety pipeline immediately before injection — blocked content is
  // dropped and warning content is redacted, so only safe/redacted memory
  // ever reaches buildActivitySummary.
  const gated = gateMemoryForInjection({ threads: memoryThreads, coreFacts });

  const activitySummary = buildActivitySummary({
    targetDate,
    generatedAt,
    gitEvents,
    manualNotes,
    claudeSignals,
    codexSignals,
    githubSignals,
    memoryThreads: gated.threads,
    coreFacts: gated.coreFacts
  });
  const draftRevision = await runDraftStorageOperation(() =>
    createDraftRevision({
      draftRoot: config.draftRoot,
      targetDate
    })
  );

  await runDraftStorageOperation(() =>
    writeDraftArtifactJson(draftRevision, "activity-summary.json", activitySummary)
  );

  const provider =
    options.aiProvider ?? createAiProvider(toAiProviderConfig(config));
  const recentFormats = await loadRecentStoryFormatHistory({
    homeDir: options.homeDir
  });
  const storyFormatPlan = await generateStoryFormatPlan({
    activitySummary,
    provider,
    persona: config.persona.identity.backstory,
    roastLevel: config.roastLevel,
    recentFormats
  });
  const generatedDraft = await generateDiaryDraft({
    activitySummary,
    storyFormatPlan,
    provider,
    persona: config.persona.identity.backstory,
    roastLevel: config.roastLevel,
    koreanEnglishMix: config.persona.voice.koreanEnglishMix,
    rawNarrativeProjection
  });
  // UNC-265 / T7: 카드 계획을 만든다. 카드 실패는 그날 전체 실패로 승격되지
  // 않는다 — 프로바이더 호출 자체가 실패해도 결정론적 기본값 계획으로
  // 떨어지고 진단만 남긴다. 2026-07-26 exit 4에 대한 구조적 답이다.
  let storyCardGeneration: StoryCardGenerationResult | undefined;
  // 브리프 대비 보강: 호출이 통째로 죽은 경우의 사유를 버리지 않고
  // 진단으로 옮긴다. 그러지 않으면 "카드가 계속 슬롯을 어긴 실행"과
  // "카드 생성 호출이 죽은 실행"이 사후에 구분되지 않는다(부모 AC6).
  let storyCardCallFailure: StoryCardFailureProviderFailure | undefined;

  try {
    storyCardGeneration = await generateStoryCardPlan({
      activitySummary,
      moodPlan: storyFormatPlan,
      provider,
      // UNC-235 리뷰 반영 (PR #138 Codex): 렌더는 계획 카드를 실제
      // 슬라이드에 순서대로 맞춘다. 일기는 suggestedSlideCount를 제안으로만
      // 쓰고 3-8장 범위면 다른 장수도 유효하게 내므로, 카드는 제안값이
      // 아니라 **이미 만들어진 슬라이드 장수**만큼 요청한다.
      cardCount: generatedDraft.slides.length
    });
  } catch (error) {
    storyCardGeneration = undefined;
    // UNC-265 T7 리뷰 반영 (finding 2): AiGenerationError가 아닌 throw
    // (카드 경로를 빠져나온 프로그래밍 오류 등)도 사유를 남긴다. 그러지
    // 않으면 운영자에게 `{ attempts: 0, cards: [] }`뿐인, 아무것도 설명하지
    // 못하는 진단 파일만 남는다(부모 AC6). T6의 타입이 허용하는 코드 중
    // "provider-failed"가 가장 덜 틀린 값이라 그것을 쓰되, 분류되지 않은
    // 예외라는 사실은 message에 명시해 프로바이더 실패와 헷갈리지 않게 한다.
    storyCardCallFailure =
      error instanceof AiGenerationError
        ? { message: error.message, code: error.code }
        : {
            message: `Unclassified story card generation failure: ${
              error instanceof Error ? error.message : String(error)
            }`,
            code: "provider-failed"
          };
  }

  const rawStoryCardPlan = assembleStoryCardPlan({
    outcomes: storyCardGeneration?.outcomes ?? [],
    summary: activitySummary
  });

  // UNC-269 / T5: 카드 슬롯의 secret·토큰·로컬 절대경로·이메일을 **여기서**
  // 마스킹한다. 이 시점 이후로 slots 원문은 어떤 산출물에도 남지 않는다.
  const { plan: maskedStoryCardPlan, findings: preRevalidationFindings } =
    checkStoryCardPlanSafety(rawStoryCardPlan);

  // 마스킹이 실제로 값을 바꿨을 때만 재검증한다. 재조립은 카드의 source
  // 라벨(generated/degraded/fallback)을 잃으므로 필요할 때만 치른다.
  //
  // UNC-269 T5 리뷰 반영 (Critical 1): 재검증의 degrade 경로는 그날의
  // 활동 요약에서 **마스킹을 거치지 않은** 원문(buildDefaultSlots)을 새로
  // 끌어올 수 있다 — 재검증만 하고 끝내면 그 원문이 마스킹 한 번 없이
  // story.json / 렌더 산출물로 나간다. 그래서 재검증한 계획은
  // rescanStoryCardPlanAfterRevalidation으로 **다시** 스캔한다. 이 함수가
  // 최종적으로 내보낼 계획과, 최종 계획 인덱스에 맞춰 재정렬된 발견을
  // 함께 돌려준다(Important 3 — 재검증이 카드를 바꾸거나 떨어뜨리면 1차
  // 발견의 cardIndex가 최종 계획과 어긋난다. 그 발견은 버리지 않는다 —
  // rescanStoryCardPlanAfterRevalidation은 인덱스를 매핑할 수 있으면
  // cardIndex만 갱신해 그대로 들고 가고, 매핑할 수 없으면(카드 내용이
  // 바뀌었거나 사라졌으면) "card replaced during revalidation" 표시를
  // 붙여서까지 findings에 유지한다. 발견을 버리고 그 자리를 2차 스캔
  // 결과로만 채우면, 그날 활동 요약이 깨끗할 때 재검증이 문제의 카드를
  // 흔적 없이 드롭시켜 2차 스캔이 아무 발견도 못 내고 safety-report.json이
  // 다시 safe로 되돌아간다 — 바로 그 결함을 막으려고 이 함수가 존재한다.
  // 자세한 계약은 safety-report.ts:585-621 참고. 이 파일을 고치는 사람에게:
  // 위 문장이 설명하는 "버리고 대체" 동작으로 되돌리는 리팩터는 이 결함을
  // 재도입한다).
  //
  // 아래 guard(`preRevalidationFindings.length > 0`)가 기대는 전제: 이
  // 조건이 참이라는 것은 곧 마스킹이 실제로 슬롯 값을 바꿨다는 뜻이다.
  // checkStoryCardPlanSafety는 슬롯마다 checkDraftSafety를 돌려 그
  // report.risks로부터 findings를 채우는데(safety-report.ts:465-480),
  // checkDraftSafety 안에서는 텍스트를 다시 쓰는 모든 경로(각
  // detectionRule 매치, 스크립트성 콘텐츠 마스킹, 아키텍처 공개 마스킹)가
  // 예외 없이 recordDetection도 함께 호출한다(safety-report.ts:190-226) —
  // risk 없이 텍스트만 바뀌거나, 텍스트가 그대로인데 risk만 기록되는
  // 경로는 없다. 그래서 findings가 비어 있으면 마스킹도 슬롯을 하나도
  // 바꾸지 않았다고 안전하게 가정할 수 있고, 아래 재검증 분기를 건너뛴다.
  let storyCardPlan = rawStoryCardPlan;
  let storyCardSlotFindings = preRevalidationFindings;

  if (preRevalidationFindings.length > 0) {
    const revalidatedStoryCardPlan = revalidateStoryCardPlan({
      plan: maskedStoryCardPlan,
      summary: activitySummary
    });
    const rescanned = rescanStoryCardPlanAfterRevalidation({
      maskedPlan: maskedStoryCardPlan,
      preRevalidationFindings,
      revalidatedPlan: revalidatedStoryCardPlan
    });

    storyCardPlan = rescanned.plan;
    storyCardSlotFindings = rescanned.findings;
  }

  const storyCardFailures = collectStoryCardFailureRecords(
    storyCardGeneration?.outcomes ?? [],
    storyCardPlan
  );
  const storyCardProviderFailure =
    storyCardGeneration?.providerFailure ?? storyCardCallFailure;

  if (storyCardGeneration === undefined || storyCardFailures.length > 0) {
    try {
      await writeStoryCardFailureDiagnostics(draftRevision, {
        failedAt: generatedAt,
        attempts: storyCardGeneration?.attempts ?? 0,
        cards: storyCardFailures,
        rawResponseJson: storyCardGeneration?.rawResponseJson,
        ...(storyCardProviderFailure === undefined
          ? {}
          : { providerFailure: storyCardProviderFailure })
      });
    } catch {
      // 진단 기록 실패가 드래프트 생성을 막아서는 안 된다 — 카드 실패는
      // 결코 그날을 죽이지 않는다는 규칙이 진단 기록에도 그대로 적용된다.
    }
  }

  // UNC-236: 캡션이 카드와 같은 농담을 반복하지 않도록, 안전 검증을 마친
  // 카드 계획의 문구를 캡션 입력에 싣는다. 이 지점의 storyCardPlan은 이미
  // 마스킹·재검증을 통과한 값이다.
  const storyCardGist = buildCaptionCardGist(storyCardPlan);

  let captionResult;

  try {
    captionResult = await generateCaption({
      activitySummary,
      moodPlan: storyFormatPlan,
      provider,
      persona: config.persona,
      roastLevel: config.roastLevel,
      rawNarrativeProjection,
      storyCardGist
    });
  } catch (error) {
    // UNC-253 / T2: 실패 종료 경로가 돌기 전에 미완성 표시를 남긴다.
    // UNC-257 / T6: 재시도가 소진된 형식 위반이면 진단 정보도 함께 남긴다.
    // 마커·진단 기록 자체가 실패하더라도 원래 캡션 에러를 가리지 않는다.
    // 리뷰 후속: 두 기록은 독립된 try/catch에 둔다 — 마커 기록이 (디스크
    // 가득 참, 권한 등으로) 실패해도 진단 기록 시도를 막아서는 안 된다.
    // 포렌식이 가장 필요한 순간이 바로 그런 실패 상황이다.
    try {
      await writeIncompleteDraftMarker(draftRevision, {
        stage: "caption",
        reason: error instanceof Error ? error.message : "Caption generation failed.",
        failedAt: generatedAt,
        targetDate
      });
    } catch {
      // 마커 기록 실패는 무시한다 — 원래 실패 원인을 보존하는 쪽이 중요하다.
    }

    try {
      if (error instanceof AiGenerationError && error.details !== undefined) {
        await writeCaptionFailureDiagnostics(draftRevision, {
          failedAt: generatedAt,
          reason: error.message,
          violations: error.details.violations,
          attempts: CAPTION_MAX_ATTEMPTS,
          rawResponseJson: error.details.rawResponseJson
        });
      }
    } catch {
      // 진단 기록 실패는 무시한다 — 원래 실패 원인을 보존하는 쪽이 중요하다.
    }

    throw error;
  }
  // UNC-206 / T2: redact admin/route-guard/auth-checkpoint/server-side-
  // authorization architecture-disclosure detail in place before the draft
  // and caption reach any written artifact (story.json, caption.txt).
  // Redacting here also means the image prompt (derived from
  // slide.visualMood in carousel-renderer.ts) is redacted at the source,
  // before visual asset generation runs.
  // UNC-265 / T7: 카드 계획을 **redaction 전에** 붙인다. 카드 슬롯도 LLM
  // 자유 텍스트라 title/slides와 같은 redaction을 통과해야 하기 때문이다.
  const preRedactionCaptionText = deriveCaptionText(captionResult);
  const draft = redactArchitectureDisclosureFromDraft({
    ...generatedDraft,
    storyCardPlan
  });
  const caption = redactArchitectureDisclosureFromCaption(
    preRedactionCaptionText
  );
  const baseMetadata: DraftMetadataBase = {
    schemaVersion: 1,
    version: 1,
    artifactVersion: 1,
    date: targetDate,
    targetDate,
    createdAt: generatedAt,
    generatedAt,
    provider: provider.name,
    model: provider.model,
    activityLevel: activitySummary.activityLevel,
    mood: storyFormatPlan.mood,
    storyFormat: {
      mood: storyFormatPlan.mood,
      angle: storyFormatPlan.angle
    },
    projects: activitySummary.projects.map((project) => ({
      id: project.projectId,
      name: project.projectName
    })),
    projectIds: activitySummary.projects.map((project) => project.projectId),
    status: "draft",
    exported: false,
    published: false,
    files: [...baseDraftFiles],
    requestedCarouselVisualStyle: config.carouselVisualStyle,
    carouselVisualStyle: config.carouselVisualStyle
  };
  // UNC-207 / T3: compute the safety report from the PRE-redaction draft
  // and caption text (not the architecture-redacted `draft`/`caption`
  // written to story.json/caption.txt above). If the report were computed
  // on already-redacted text, checkDraftSafety would never see the
  // architecture-disclosure content (it was already scrubbed to
  // "[redacted-architecture]"), so the risk/reason would never be recorded
  // and nothing would ever be blocked (breaking parent AC2/AC4). The
  // written artifacts stay redacted regardless of what the report finds.
  //
  // UNC-265 / T7 — 카드 슬롯은 이 안전 텍스트에서 **의도적으로 제외**한다.
  // 여기 넘기는 `generatedDraft`는 카드 계획을 붙이기 전의 드래프트다.
  //
  // 왜: 이 보고서가 `blocked`로 나오면 아래에서 GenerateCommandError
  // ("safety-blocked", exit 6)를 던져 **그날 드래프트 전체가 죽는다**.
  // 카드 슬롯을 여기 섞으면 카드 한 장의 secret 모양 문자열 하나가 그날을
  // 통째로 날리게 되고, 그건 "한 장이 실패해도 나머지와 드래프트는 계속
  // 된다"(부모 AC4) / "전부 실패해도 최소 한 장으로 완성된다"(AC5)와 정면
  // 충돌한다. 2026-07-26 사고(자유 텍스트 응답 하나가 그날을 죽인 일)를
  // 다른 문으로 다시 들이는 셈이다.
  //
  // UNC-269 / T5 (UNC-235): 위 주석이 "UNC-235에서 렌더 경로를 함께 보고
  // 결정한다"고 미뤄 둔 결정을 이행했다. 결론은 **여기에 붙이지 않는 것**이다.
  // 대신 카드 슬롯은 위쪽 checkStoryCardPlanSafety에서 별도로 검사해
  //   ① 슬롯 원문을 in-place 마스킹하고 (공개 산출물에 secret 금지)
  //   ② 발견을 슬롯 단위 warning으로 기록한다 (export는 계속 허용)
  // 카드 슬롯 발견은 어떤 경우에도 blocked/exit 6으로 승격되지 않는다.
  //
  // 경고: 이 주석을 읽고 "그냥 storyCardPlan을 붙이면 되겠네"라고 고치지 마라.
  // 위의 exit 6 결과를 먼저 이해해야 한다.
  const safetyReport = mergeStoryCardSlotFindings(
    createSafetyReport(
      buildDraftSafetyText({
        draft: generatedDraft,
        caption: preRedactionCaptionText,
        metadata: baseMetadata
      })
    ),
    storyCardSlotFindings
  );
  // UNC-206 follow-up: the safety report is computed from the RAW baseMetadata
  // above so architecture-disclosure detail in the provider-generated
  // storyFormat.angle can still be detected and blocked. The metadata copy
  // that reaches metadata.json must carry the redacted angle instead, so a
  // blocked draft never persists the raw disclosure to disk.
  const writeMetadataBase: DraftMetadataBase = {
    ...baseMetadata,
    storyFormat: {
      ...baseMetadata.storyFormat,
      angle: redactArchitectureDisclosure(baseMetadata.storyFormat.angle).value
    }
  };
  const safetyMetadata = buildDraftMetadata({
    baseMetadata: writeMetadataBase,
    safetyReport,
    visualAssets: {
      schemaVersion: 1,
      files: [],
      assets: []
    }
  });

  await runDraftStorageOperation(async () => {
    await writeDraftArtifactJson(draftRevision, "story.json", draft);
    await writeDraftArtifactText(draftRevision, "caption.txt", caption);
    await writeDraftArtifactJson(
      draftRevision,
      "safety-report.json",
      safetyReport
    );
  });

  if (safetyReport.status === "blocked") {
    await runDraftStorageOperation(async () => {
      await writeDraftArtifactJson(draftRevision, "metadata.json", safetyMetadata);
      await writeLatestDraftPointer(draftRevision, generatedAt);
    });

    throw new GenerateCommandError(
      `Draft blocked by safety checks. ${safetyReport.message}`,
      "safety-blocked",
      draftRevision.outputDir
    );
  }

  const imageAssetProvider = await resolveImageAssetProvider({
    config,
    injectedProvider: options.imageAssetProvider
  });
  const { visualAssets, visualStyle } = await generateVisualAssetsForDraft({
    revision: draftRevision,
    draft,
    requestedVisualStyle: config.carouselVisualStyle,
    provider: imageAssetProvider,
    fallbackProviderName: config.provider,
    outputDir: draftRevision.outputDir
  });
  const metadata = buildDraftMetadata({
    baseMetadata: writeMetadataBase,
    safetyReport,
    visualAssets,
    visualStyle
  });

  await runDraftStorageOperation(async () => {
    await writeDraftArtifactJson(draftRevision, "metadata.json", metadata);
    await writeLatestDraftPointer(draftRevision, generatedAt);
  });

  await recordStoryFormatHistory({
    homeDir: options.homeDir,
    targetDate,
    storyFormatPlan
  });

  return {
    targetDate,
    outputDir: draftRevision.outputDir,
    revision: draftRevision.revision,
    latestPointerPath: draftRevision.latestPointerPath,
    activitySummary,
    storyFormatPlan,
    draft,
    caption,
    safetyReport,
    visualAssets,
    exportPolicy: safetyReport.status,
    exportReady: safetyReport.exportAllowed
  };
}

function buildDraftMetadata(options: {
  baseMetadata: DraftMetadataBase;
  safetyReport: SafetyReport;
  visualAssets: VisualAssetGenerationResult;
  visualStyle?: CarouselVisualStyleMode;
}): DraftMetadata {
  return {
    ...options.baseMetadata,
    carouselVisualStyle:
      options.visualStyle ?? options.baseMetadata.carouselVisualStyle,
    files: [...baseDraftFiles, ...options.visualAssets.files],
    exportPolicy: options.safetyReport.status,
    exportReady: options.safetyReport.exportAllowed,
    publishable: options.safetyReport.exportAllowed,
    visualAssets: options.visualAssets.assets,
    safety: {
      status: options.safetyReport.status,
      message: options.safetyReport.message,
      riskCount: options.safetyReport.risks.length
    }
  };
}

function buildDraftSafetyText(options: {
  draft: DiaryDraft;
  caption: string;
  metadata: unknown;
}): string {
  return [
    options.caption,
    JSON.stringify(options.draft),
    JSON.stringify(options.metadata)
  ].join("\n");
}

async function runDraftStorageOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DraftStorageError) {
      throw new GenerateCommandError(error.message, "invalid-config");
    }

    throw error;
  }
}

async function runVisualAssetGeneration<T>(
  operation: () => Promise<T>,
  outputDir: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof VisualAssetGenerationError) {
      throw new GenerateCommandError(
        error.message,
        "visual-generation-failed",
        outputDir
      );
    }

    throw error;
  }
}

async function resolveImageAssetProvider(options: {
  config: GenerateConfig;
  injectedProvider?: ImageAssetProvider;
}): Promise<ImageAssetProvider | undefined> {
  if (options.config.carouselVisualStyle === "story-card") {
    return undefined;
  }

  if (options.injectedProvider) {
    return options.injectedProvider;
  }

  try {
    return createImageAssetProvider(toAiProviderConfig(options.config));
  } catch (error) {
    if (error instanceof VisualAssetGenerationError) {
      return undefined;
    }

    throw error;
  }
}

async function generateVisualAssetsForDraft(options: {
  revision: Parameters<typeof generateCarouselVisualAssets>[0]["revision"];
  draft: DiaryDraft;
  requestedVisualStyle: CarouselVisualStyleMode;
  provider?: ImageAssetProvider;
  fallbackProviderName: AiProviderName;
  outputDir: string;
}): Promise<{
  visualAssets: VisualAssetGenerationResult;
  visualStyle: CarouselVisualStyleMode;
}> {
  const initialVisualStyle =
    options.requestedVisualStyle === "photo-first" && !options.provider
      ? "story-card"
      : options.requestedVisualStyle;
  const fallbackState =
    initialVisualStyle === "story-card" &&
    options.requestedVisualStyle === "story-card"
      ? "image-generation-disabled"
      : initialVisualStyle === "story-card" &&
          options.requestedVisualStyle === "photo-first"
        ? options.fallbackProviderName === "none"
          ? "no-provider"
          : "provider-unsupported"
        : undefined;

  try {
    const visualAssets = await runVisualAssetGeneration(
      () =>
        generateCarouselVisualAssets({
          revision: options.revision,
          cards: createCarouselHtmlCards(options.draft, {
            visualStyle: initialVisualStyle
          }),
          provider: options.provider,
          fallbackProviderName: options.fallbackProviderName,
          fallbackState
        }),
      options.outputDir
    );

    return {
      visualAssets,
      visualStyle: initialVisualStyle
    };
  } catch (error) {
    if (
      error instanceof GenerateCommandError &&
      error.code === "visual-generation-failed" &&
      options.requestedVisualStyle === "photo-first" &&
      options.provider
    ) {
      const visualAssets = await runVisualAssetGeneration(
        () =>
          generateCarouselVisualAssets({
            revision: options.revision,
            cards: createCarouselHtmlCards(options.draft, {
              visualStyle: "story-card"
            }),
            fallbackProviderName: options.fallbackProviderName,
            fallbackState: "provider-failed"
          }),
        options.outputDir
      );

      return {
        visualAssets,
        visualStyle: "story-card"
      };
    }

    throw error;
  }
}

/**
 * The clock reflection ages memory against: the earlier of the run time and
 * the end of `targetDate`.
 *
 * `generate today` derives `targetDate` from `generatedAt`, so end-of-day is
 * always ahead of the run time and this returns `generatedAt` unchanged. A
 * `--date` backfill of a past day returns that day's end instead, so
 * `lastSeen` and the decay/expiry window follow the activity's date rather
 * than whenever the backfill happened to run.
 */
function memoryClock(targetDate: string, generatedAt: string): Date {
  const runTime = new Date(generatedAt);
  const endOfTargetDate = new Date(`${targetDate}T23:59:59.999Z`);

  return endOfTargetDate.getTime() < runTime.getTime() ? endOfTargetDate : runTime;
}

function parseGenerateDate(
  args: string[],
  now: (() => string) | undefined
): string {
  if (args.length === 1 && args[0] === "today") {
    return (now ? now() : new Date().toISOString()).slice(0, 10);
  }

  if (args.length === 2 && args[0] === "--date") {
    const targetDate = args[1];

    if (!isValidDateString(targetDate)) {
      throw new GenerateCommandError(
        "Date must use YYYY-MM-DD format.",
        "invalid-arguments"
      );
    }

    return targetDate;
  }

  throw new GenerateCommandError(usage, "invalid-arguments");
}

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * UNC-268 A5: 키가 없는 **기존** config는 계속 photo-first로 읽는다.
 * 신규 init만 story-card를 명시적으로 기록한다 (AC1은 쓰기 시점,
 * AC2는 읽기 시점이라 충돌하지 않는다). 사용자 config는 마이그레이션하지
 * 않는다 — 어떤 경로로도 건드리지 않는다.
 */
export function resolveCarouselVisualStyle(value: unknown): CarouselVisualStyleMode {
  return value === "story-card" ? "story-card" : "photo-first";
}

async function readGenerateConfig(
  path: string,
  homeDir: string | undefined
): Promise<GenerateConfig> {
  const outcome = await loadGlobalConfig(path);

  if (outcome.status === "missing") {
    throw new GenerateCommandError(
      "AI config is missing. Run `uncommitted init` first.",
      "invalid-config"
    );
  }

  if (outcome.status !== "ok" || !isGenerateConfigFile(outcome.value)) {
    throw new GenerateCommandError("AI config is invalid.", "invalid-config");
  }

  const parsed = outcome.value;

  return {
    draftRoot: resolveConfigPaths({
      homeDir,
      draftRoot: parsed.draftRoot
    }).defaultDraftRoot,
    provider: parsed.aiProvider,
    carouselVisualStyle: resolveCarouselVisualStyle(parsed.carouselVisualStyle),
    persona: selectPersona(parsed),
    roastLevel: parsed.roastLevel
  };
}

/**
 * Adapt a structured-persona `GenerateConfig` back to the legacy
 * `AiProviderConfig` shape expected at AI-provider construction boundaries
 * (`createAiProvider`, `createImageAssetProvider`), neither of which reads
 * `persona` — only `provider` drives provider selection.
 *
 * TODO(UNC-211): drop this adapter once those provider constructors accept
 * the structured `Persona` directly.
 */
function toAiProviderConfig(config: GenerateConfig): AiProviderConfig {
  return {
    provider: config.provider,
    persona: config.persona.identity.backstory,
    roastLevel: config.roastLevel
  };
}

async function readProjectsFile(path: string): Promise<ProjectsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (isProjectsFile(parsed)) {
      return parsed;
    }

    throw new GenerateCommandError("Invalid projects file.", "invalid-config");
  } catch (error) {
    if (error instanceof GenerateCommandError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      return { schemaVersion: 1, projects: [] };
    }

    throw new GenerateCommandError("Invalid projects file.", "invalid-config");
  }
}

async function readGitActivityEvents(
  projects: ProjectRecord[],
  targetDate: string
): Promise<GitActivityEvent[]> {
  const events: GitActivityEvent[] = [];

  for (const project of projects) {
    const event = await readOptionalJson(
      join(project.root, ".uncommitted", "events", "git", `${targetDate}.json`)
    );

    if (event === undefined) {
      continue;
    }

    if (!isGitActivityEvent(event)) {
      throw new GenerateCommandError(
        "Stored Git activity is malformed. Re-run `uncommitted collect git`.",
        "invalid-data"
      );
    }

    events.push(event);
  }

  return events;
}

async function readManualNoteEvents(
  projects: ProjectRecord[],
  targetDate: string
): Promise<ManualNoteEvent[]> {
  const notes: ManualNoteEvent[] = [];

  for (const project of projects) {
    const content = await readOptionalText(
      join(project.root, ".uncommitted", "events", "manual", `${targetDate}.jsonl`)
    );

    if (content === undefined) {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;

        if (!isManualNoteEvent(parsed)) {
          throw new Error("Invalid manual note.");
        }

        notes.push(parsed);
      } catch {
        throw new GenerateCommandError(
          "Stored manual notes are malformed. Fix or remove the invalid note data.",
          "invalid-data"
        );
      }
    }
  }

  return notes;
}

function readClaudeActivitySignals(
  projects: ProjectRecord[],
  targetDate: string
): Promise<ActivitySignal[]> {
  return readSessionActivitySignals(projects, targetDate, "claude");
}

function readCodexActivitySignals(
  projects: ProjectRecord[],
  targetDate: string
): Promise<ActivitySignal[]> {
  return readSessionActivitySignals(projects, targetDate, "codex");
}

function readGitHubActivitySignals(
  projects: ProjectRecord[],
  targetDate: string
): Promise<ActivitySignal[]> {
  return readSessionActivitySignals(projects, targetDate, "github");
}

async function readSessionActivitySignals(
  projects: ProjectRecord[],
  targetDate: string,
  source: "claude" | "codex" | "github"
): Promise<ActivitySignal[]> {
  const signals: ActivitySignal[] = [];

  for (const project of projects) {
    const content = await readOptionalText(
      join(project.root, ".uncommitted", "events", source, `${targetDate}.jsonl`)
    );

    if (content === undefined) {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      // Session signals are a supplementary, already-redacted input. Skip any
      // malformed line rather than failing the whole diary — a single bad
      // session record should never block generation from Git + notes.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (isActivitySignal(parsed)) {
        signals.push(parsed);
      }
    }
  }

  return signals;
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  const content = await readOptionalText(path);

  if (content === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new GenerateCommandError(
      "Stored Git activity is malformed. Re-run `uncommitted collect git`.",
      "invalid-data"
    );
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw new GenerateCommandError(
      "Could not read stored activity data.",
      "invalid-data"
    );
  }
}

function isGenerateConfigFile(value: unknown): value is GenerateConfigFile {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.draftRoot === "string" &&
    isAiProviderName(value.aiProvider) &&
    (value.carouselVisualStyle === undefined ||
      isCarouselVisualStyleMode(value.carouselVisualStyle)) &&
    (isPersona(value.persona) || typeof value.persona === "string") &&
    isRoastLevel(value.roastLevel)
  );
}

function isCarouselVisualStyleMode(
  value: unknown
): value is CarouselVisualStyleMode {
  return value === "photo-first" || value === "story-card";
}

function isProjectsFile(value: unknown): value is ProjectsFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.projects)) {
    return false;
  }

  return value.projects.every(isProjectRecord);
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.root === "string" &&
    typeof value.gitRoot === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.createdAt === "string"
  );
}

function isGitActivityEvent(value: unknown): value is GitActivityEvent {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.source === "git" &&
    typeof value.targetDate === "string" &&
    typeof value.collectedAt === "string" &&
    isRecord(value.project) &&
    typeof value.project.id === "string" &&
    typeof value.project.name === "string" &&
    isRecord(value.activity) &&
    value.activity.schemaVersion === 1 &&
    typeof value.activity.targetDate === "string" &&
    isRecord(value.activity.repository) &&
    typeof value.activity.repository.rootName === "string" &&
    Array.isArray(value.activity.commits) &&
    value.activity.commits.every(isGitActivityCommit) &&
    isRecord(value.activity.totals) &&
    isGitActivityStats(value.activity.totals) &&
    isFiniteNumber(value.activity.totals.commits) &&
    isRecord(value.activity.dirty) &&
    Array.isArray(value.activity.dirty.files) &&
    value.activity.dirty.files.every(isDirtyFileSummary) &&
    isRecord(value.activity.dirty.totals) &&
    isDirtyStatusTotals(value.activity.dirty.totals)
  );
}

function isGitActivityCommit(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    typeof value.shortHash === "string" &&
    typeof value.authorName === "string" &&
    typeof value.authoredAt === "string" &&
    typeof value.subject === "string" &&
    isRecord(value.stats) &&
    isGitActivityStats(value.stats)
  );
}

function isGitActivityStats(value: Record<string, unknown>): boolean {
  return (
    isFiniteNumber(value.filesChanged) &&
    isFiniteNumber(value.insertions) &&
    isFiniteNumber(value.deletions)
  );
}

function isDirtyFileSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isDirtyStatus(value.status)
  );
}

function isDirtyStatusTotals(value: Record<string, unknown>): boolean {
  return Array.from(dirtyStatuses).every((status) =>
    isFiniteNumber(value[status])
  );
}

function isDirtyStatus(value: unknown): boolean {
  return typeof value === "string" && dirtyStatuses.has(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isManualNoteEvent(value: unknown): value is ManualNoteEvent {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.date === "string" &&
    typeof value.projectId === "string" &&
    typeof value.text === "string" &&
    value.source === "manual"
  );
}

function isAiProviderName(value: unknown): value is AiProviderName {
  return (
    typeof value === "string" &&
    providerNames.includes(value as AiProviderName)
  );
}

/**
 * UNC-265 / T7: 거부된 카드마다 계획에서 실제로 어떻게 끝났는지를 판정한다.
 * 그 종류가 계획에 `degraded`로 남았으면 기본값으로 살아남은 것이고,
 * 없으면 계획에서 빠진 것이다. 이 구분이 사후 추적의 핵심이라 진단에
 * 그대로 남긴다 — 계획 자체는 `source`만 들고 있어서 "왜 그렇게 됐는지"는
 * 여기서만 알 수 있다.
 */
function collectStoryCardFailureRecords(
  outcomes: readonly StoryCardEntryOutcome[],
  plan: StoryCardPlan
): StoryCardFailureCardRecord[] {
  const degradedTypes = new Set(
    plan.cards.filter((card) => card.source === "degraded").map((card) => card.type)
  );

  return outcomes.flatMap((outcome) => {
    if (outcome.status !== "rejected") return [];

    return [
      {
        cardIndex: outcome.cardIndex,
        cardType: outcome.rawType,
        outcome:
          outcome.rawType !== null && degradedTypes.has(outcome.rawType)
            ? ("degraded" as const)
            : ("dropped" as const),
        violations: outcome.violations.map((violation) => violation.code)
      }
    ];
  });
}
