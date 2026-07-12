import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildActivitySummary,
  type ActivitySummary
} from "./activity-summary.js";
import {
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
import { isActivitySignal, type ActivitySignal } from "./event-source.js";
import { resolveConfigPaths } from "./config-paths.js";
import {
  isRoastLevel,
  loadGlobalConfig,
  type GlobalConfig
} from "./global-config.js";
import { isPersona, selectPersona, type Persona } from "./persona.js";
import { isNodeError, isRecord } from "./type-guards.js";
import {
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
  writeDraftArtifactJson,
  writeDraftArtifactText,
  writeLatestDraftPointer
} from "./draft-storage.js";
import type { ManualNoteEvent } from "./note-command.js";
import type { ProjectRecord, ProjectsFile } from "./project-add.js";
import { loadSourceConfig } from "./source-config.js";
import { buildRawNarrativeProjection } from "./raw-narrative-archive.js";
import {
  emptyRawNarrativeProjection,
  readCaptionProjectionTokenBudget
} from "./raw-narrative-projection.js";
import {
  createSafetyReport,
  type SafetyReport,
  type SafetyStatus
} from "./safety-report.js";
import {
  generateStoryFormatPlan,
  loadRecentStoryFormatHistory,
  recordStoryFormatHistory,
  type StoryFormatPlan
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
  storyFormatPlan: StoryFormatPlan;
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
  formatName: string;
  storyFormat: {
    formatName: string;
    voice: string;
    tone: string;
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
  const activitySummary = buildActivitySummary({
    targetDate,
    generatedAt,
    gitEvents,
    manualNotes,
    claudeSignals,
    codexSignals,
    githubSignals
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
    rawNarrativeProjection
  });
  const captionResult = await generateCaption({
    activitySummary,
    provider,
    persona: config.persona,
    roastLevel: config.roastLevel,
    rawNarrativeProjection
  });
  // UNC-206 / T2: redact admin/route-guard/auth-checkpoint/server-side-
  // authorization architecture-disclosure detail in place before the draft
  // and caption reach any written artifact (story.json, caption.txt) or the
  // safety-report text. Redacting here also means the image prompt (derived
  // from slide.visualMood in carousel-renderer.ts) is redacted at the
  // source, before visual asset generation runs.
  const draft = redactArchitectureDisclosureFromDraft(generatedDraft);
  const caption = redactArchitectureDisclosureFromCaption(
    deriveCaptionText(captionResult)
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
    formatName: storyFormatPlan.formatName,
    storyFormat: {
      formatName: storyFormatPlan.formatName,
      voice: storyFormatPlan.voice,
      tone: storyFormatPlan.tone
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
  const safetyReport = createSafetyReport(
    buildDraftSafetyText({ draft, caption, metadata: baseMetadata })
  );
  const safetyMetadata = buildDraftMetadata({
    baseMetadata,
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
    baseMetadata,
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
    carouselVisualStyle: parsed.carouselVisualStyle ?? "photo-first",
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
