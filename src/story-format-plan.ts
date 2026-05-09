import { readFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";
import type { ActivitySummary } from "./activity-summary.js";
import {
  AiGenerationError,
  createAiGenerationRequest,
  generateStructured
} from "./ai-provider.js";
import type {
  AiProvider,
  JsonObject,
  JsonValue,
  SafeActivitySummary
} from "./ai-provider.js";

export type StoryFormatStructurePart = {
  part: string;
  purpose: string;
};

export type StoryFormatPlan = {
  schemaVersion: 1;
  formatName: string;
  voice: string;
  tone: string;
  reason: string;
  structure: StoryFormatStructurePart[];
  suggestedSlideCount: number;
  captionStyle: string;
  doNotMention: string[];
};

export type RecentStoryFormat = {
  date: string;
  formatName: string;
  voice?: string;
  tone?: string;
};

export type ProjectPersonaHint = {
  projectId: string;
  projectName: string;
  personaHint: string;
};

export type StoryFormatPlanOptions = {
  activitySummary: ActivitySummary;
  provider: AiProvider;
  persona: string;
  roastLevel: number;
  projectPersonaHints?: ProjectPersonaHint[];
  entryMode?: "daily_global";
  recentFormats?: RecentStoryFormat[];
};

export type LoadRecentStoryFormatHistoryOptions = {
  homeDir?: string;
  limit?: number;
};

type StoryFormatHistoryFile = {
  schemaVersion?: 1;
  formats?: unknown[];
  recent?: unknown[];
};

type StoryFormatPlanProviderData = JsonObject & {
  formatName?: JsonValue;
  voice?: JsonValue;
  tone?: JsonValue;
  reason?: JsonValue;
  structure?: JsonValue;
  suggestedSlideCount?: JsonValue;
  captionStyle?: JsonValue;
  doNotMention?: JsonValue;
};

const defaultHistoryLimit = 7;
const minSlideCount = 3;
const maxSlideCount = 8;

export async function generateStoryFormatPlan(
  options: StoryFormatPlanOptions
): Promise<StoryFormatPlan> {
  const recentFormats = options.recentFormats ?? [];
  const request = createAiGenerationRequest({
    task: "story-plan",
    instructions: buildStoryFormatInstructions({
      roastLevel: options.roastLevel,
      entryMode: "daily_global",
      hasRecentFormats: recentFormats.length > 0,
      quiet: options.activitySummary.activityLevel === "none"
    }),
    summary: buildSafeStoryFormatInput({
      activitySummary: options.activitySummary,
      persona: options.persona,
      roastLevel: options.roastLevel,
      projectPersonaHints: options.projectPersonaHints ?? [],
      recentFormats
    })
  });
  const response = await generateStructured<StoryFormatPlanProviderData>(
    options.provider,
    request
  );

  return parseStoryFormatPlan(response.data);
}

export async function loadRecentStoryFormatHistory(
  options: LoadRecentStoryFormatHistoryOptions = {}
): Promise<RecentStoryFormat[]> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const limit = options.limit ?? defaultHistoryLimit;

  try {
    const parsed = JSON.parse(
      await readFile(paths.formatHistoryFile, "utf8")
    ) as unknown;

    if (!isRecord(parsed)) {
      return [];
    }

    const historyFile = parsed as StoryFormatHistoryFile;
    const entries = Array.isArray(historyFile.recent)
      ? historyFile.recent
      : Array.isArray(historyFile.formats)
        ? historyFile.formats
        : [];

    return entries
      .filter(isRecentStoryFormat)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw new AiGenerationError(
      "Format history is invalid. Re-run `uncommitted init`.",
      "invalid-config"
    );
  }
}

function buildSafeStoryFormatInput(options: {
  activitySummary: ActivitySummary;
  persona: string;
  roastLevel: number;
  projectPersonaHints: ProjectPersonaHint[];
  recentFormats: RecentStoryFormat[];
}): SafeActivitySummary {
  const summary = options.activitySummary;
  const quiet = summary.activityLevel === "none";
  const highlights = buildHighlights(summary, quiet);

  return {
    schemaVersion: 1,
    targetDate: summary.targetDate,
    quiet,
    overview: `${summary.activityLevel} ${summary.dominantTheme} day with ${summary.projects.length} ${summary.projects.length === 1 ? "project" : "projects"}.`,
    highlights,
    projectSummaries: summary.projects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      summary: project.summary,
      stats: {
        commits: project.commitCount,
        filesChanged: project.filesChanged,
        insertions: project.insertions,
        deletions: project.deletions,
        dirtyFiles: project.uncommittedChangeCount
      }
    })),
    entryMode: "daily_global",
    persona: options.persona,
    roastPolicy: {
      roastLevel: options.roastLevel,
      allowDirectUserRoast: options.roastLevel >= 3,
      boundaries: [
        "Roast situations, tools, TODOs, bugs, and recurring work patterns only.",
        "Never attack identity, ability, appearance, mental health, personal value, or real life."
      ]
    },
    projectPersonaHints: options.projectPersonaHints,
    recentFormats: options.recentFormats,
    activitySignals: {
      activityLevel: summary.activityLevel,
      dominantTheme: summary.dominantTheme,
      commitSubjects: summary.commitSignals.subjects,
      unfinishedThreads: summary.unfinishedThreads,
      possibleJokes: summary.possibleJokes,
      publicSafetyNotes: summary.publicSafetyNotes,
      privateItemsToAvoid: summary.privateItemsToAvoid,
      uncertaintyNotes: summary.uncertaintyNotes
    }
  };
}

function buildHighlights(summary: ActivitySummary, quiet: boolean): string[] {
  if (quiet) {
    return [
      "No recorded Git activity or manual notes; keep the draft honest.",
      ...summary.possibleJokes,
      ...summary.uncertaintyNotes
    ];
  }

  return [
    ...summary.smallWins,
    ...summary.blockersOrConfusion,
    ...summary.unfinishedThreads,
    ...summary.possibleJokes
  ];
}

function buildStoryFormatInstructions(options: {
  roastLevel: number;
  entryMode: "daily_global";
  hasRecentFormats: boolean;
  quiet: boolean;
}): string {
  const directRoastPolicy =
    options.roastLevel >= 3
      ? "Light direct roast of work habits is allowed, but never personal attacks."
      : "Keep jokes focused on situations, tools, TODOs, bugs, and requirements.";

  return [
    "Design a Story Format Plan for an Uncommitted diary draft.",
    `Entry mode is ${options.entryMode}; create one global diary plan across all projects.`,
    "Return structured JSON with formatName, voice, tone, reason, structure, suggestedSlideCount, captionStyle, and doNotMention.",
    "Do not invent work, commits, bugs, features, or user activity.",
    "For quiet days, acknowledge low or no recorded work and make the format about waiting, observation, or honest quiet.",
    "Avoid near-duplicates of recentFormats when they are provided.",
    "Keep the structure readable as an Instagram carousel.",
    "Roast policy: light jokes may target situations, tools, TODOs, bugs, recurring work patterns, or requirement churn.",
    directRoastPolicy,
    "Never attack the user's identity, ability, appearance, mental health, personal value, or real life.",
    `Suggested slide count must be ${minSlideCount}-${maxSlideCount}; prefer 3-5 for quiet/low days and 5-8 for high days.`
  ].join("\n");
}

function parseStoryFormatPlan(data: StoryFormatPlanProviderData): StoryFormatPlan {
  if (!isStoryFormatPlanProviderData(data)) {
    throwInvalidStoryFormatPlan();
  }

  const plan: StoryFormatPlan = {
    schemaVersion: 1,
    formatName: data.formatName,
    voice: data.voice,
    tone: data.tone,
    reason: data.reason,
    structure: data.structure,
    suggestedSlideCount: data.suggestedSlideCount,
    captionStyle: data.captionStyle,
    doNotMention: data.doNotMention
  };

  if (!isStoryFormatPlan(plan)) {
    throwInvalidStoryFormatPlan();
  }

  return plan;
}

function isStoryFormatPlan(value: unknown): value is StoryFormatPlan {
  if (!isRecord(value)) {
    return false;
  }

  const suggestedSlideCount = value.suggestedSlideCount;

  return (
    value.schemaVersion === 1 &&
    typeof value.formatName === "string" &&
    value.formatName.trim().length > 0 &&
    typeof value.voice === "string" &&
    value.voice.trim().length > 0 &&
    typeof value.tone === "string" &&
    value.tone.trim().length > 0 &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    Array.isArray(value.structure) &&
    value.structure.length > 0 &&
    value.structure.every(isStoryFormatStructurePart) &&
    Number.isInteger(suggestedSlideCount) &&
    typeof suggestedSlideCount === "number" &&
    suggestedSlideCount >= minSlideCount &&
    suggestedSlideCount <= maxSlideCount &&
    typeof value.captionStyle === "string" &&
    value.captionStyle.trim().length > 0 &&
    Array.isArray(value.doNotMention) &&
    value.doNotMention.every((item) => typeof item === "string")
  );
}

function isStoryFormatPlanProviderData(
  value: StoryFormatPlanProviderData
): value is StoryFormatPlanProviderData & Omit<StoryFormatPlan, "schemaVersion"> {
  return (
    typeof value.formatName === "string" &&
    typeof value.voice === "string" &&
    typeof value.tone === "string" &&
    typeof value.reason === "string" &&
    Array.isArray(value.structure) &&
    value.structure.every(isStoryFormatStructurePart) &&
    Number.isInteger(value.suggestedSlideCount) &&
    typeof value.captionStyle === "string" &&
    Array.isArray(value.doNotMention) &&
    value.doNotMention.every((item) => typeof item === "string")
  );
}

function isStoryFormatStructurePart(
  value: unknown
): value is StoryFormatStructurePart {
  return (
    isRecord(value) &&
    typeof value.part === "string" &&
    value.part.trim().length > 0 &&
    typeof value.purpose === "string" &&
    value.purpose.trim().length > 0
  );
}

function isRecentStoryFormat(value: unknown): value is RecentStoryFormat {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    typeof value.formatName === "string" &&
    (value.voice === undefined || typeof value.voice === "string") &&
    (value.tone === undefined || typeof value.tone === "string")
  );
}

function throwInvalidStoryFormatPlan(): never {
  throw new AiGenerationError(
    "AI provider returned invalid story format plan.",
    "malformed-response"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
