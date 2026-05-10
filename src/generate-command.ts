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
import type { GitActivityEvent } from "./collect-git-command.js";
import { resolveConfigPaths } from "./config-paths.js";
import {
  deriveCaptionText,
  generateDiaryDraft,
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
import {
  createSafetyReport,
  type SafetyReport
} from "./safety-report.js";
import {
  generateStoryFormatPlan,
  loadRecentStoryFormatHistory,
  recordStoryFormatHistory,
  type StoryFormatPlan
} from "./story-format-plan.js";

export type GenerateCommandErrorCode =
  | "invalid-arguments"
  | "invalid-config"
  | "invalid-data"
  | "no-projects";

export class GenerateCommandError extends Error {
  constructor(
    message: string,
    public readonly code: GenerateCommandErrorCode
  ) {
    super(message);
    this.name = "GenerateCommandError";
  }
}

export type GenerateCommandOptions = {
  homeDir?: string;
  now?: () => string;
  aiProvider?: AiProvider;
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
};

type GenerateConfig = AiProviderConfig & {
  draftRoot: string;
};

type GenerateConfigFile = {
  schemaVersion: 1;
  draftRoot: string;
  aiProvider: AiProviderName;
  persona: string;
  roastLevel: number;
};

type DraftMetadata = {
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
  const gitEvents = await readGitActivityEvents(projects, targetDate);
  const manualNotes = await readManualNoteEvents(projects, targetDate);
  const activitySummary = buildActivitySummary({
    targetDate,
    generatedAt,
    gitEvents,
    manualNotes
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

  const provider = options.aiProvider ?? createAiProvider(config);
  const recentFormats = await loadRecentStoryFormatHistory({
    homeDir: options.homeDir
  });
  const storyFormatPlan = await generateStoryFormatPlan({
    activitySummary,
    provider,
    persona: config.persona,
    roastLevel: config.roastLevel,
    recentFormats
  });
  const draft = await generateDiaryDraft({
    activitySummary,
    storyFormatPlan,
    provider,
    persona: config.persona,
    roastLevel: config.roastLevel
  });
  const caption = deriveCaptionText(draft);
  const metadata: DraftMetadata = {
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
    files: [
      "activity-summary.json",
      "story.json",
      "caption.txt",
      "metadata.json",
      "safety-report.json"
    ]
  };
  const safetyReport = createSafetyReport(
    buildDraftSafetyText({ draft, caption, metadata })
  );

  await runDraftStorageOperation(async () => {
    await writeDraftArtifactJson(draftRevision, "story.json", draft);
    await writeDraftArtifactText(draftRevision, "caption.txt", caption);
    await writeDraftArtifactJson(draftRevision, "metadata.json", metadata);
    await writeDraftArtifactJson(
      draftRevision,
      "safety-report.json",
      safetyReport
    );
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
    safetyReport
  };
}

function buildDraftSafetyText(options: {
  draft: DiaryDraft;
  caption: string;
  metadata: DraftMetadata;
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
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (!isGenerateConfigFile(parsed)) {
      throw new GenerateCommandError("AI config is invalid.", "invalid-config");
    }

    return {
      draftRoot: resolveConfigPaths({
        homeDir,
        draftRoot: parsed.draftRoot
      }).defaultDraftRoot,
      provider: parsed.aiProvider,
      persona: parsed.persona,
      roastLevel: parsed.roastLevel
    };
  } catch (error) {
    if (error instanceof GenerateCommandError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      throw new GenerateCommandError(
        "AI config is missing. Run `uncommitted init` first.",
        "invalid-config"
      );
    }

    throw new GenerateCommandError("AI config is invalid.", "invalid-config");
  }
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
    typeof value.persona === "string" &&
    typeof value.roastLevel === "number" &&
    Number.isInteger(value.roastLevel) &&
    value.roastLevel >= 0 &&
    value.roastLevel <= 5
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
