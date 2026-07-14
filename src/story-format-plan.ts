import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * Fixed mood vocabulary for the mood/angle/pacing engine (UNC-200/UNC-212).
 * Deliberately small and closed: these are moods, not invented genres.
 * Vocabulary tuning is explicit out-of-scope follow-up work.
 */
export const MOOD_VOCABULARY = [
  "release",
  "firefight",
  "quiet",
  "grind",
  "breakthrough",
  "cleanup"
] as const;

export type Mood = (typeof MOOD_VOCABULARY)[number];

export function isMood(value: unknown): value is Mood {
  return (
    typeof value === "string" &&
    (MOOD_VOCABULARY as readonly string[]).includes(value)
  );
}

export type StoryPacing = {
  // structural variation that does NOT announce a genre
  openWith: "scene" | "thought";
  shape: "hook-turn-landing" | "list" | "single-beat" | "spiral";
  suggestedSlideCount: number; // 3-8
};

export type MoodPlan = {
  schemaVersion: 2;
  mood: Mood;
  angle: string; // what the coworker fixated on today (free text, safe)
  pacing: StoryPacing;
  voice: string;
  tone: string;
  reason: string;
  structure: StoryFormatStructurePart[];
  captionStyle: string;
  doNotMention: string[];
};

export function isMoodPlan(value: unknown): value is MoodPlan {
  if (!isRecord(value)) {
    return false;
  }

  const pacing = value.pacing;

  return (
    value.schemaVersion === 2 &&
    isMood(value.mood) &&
    typeof value.angle === "string" &&
    value.angle.trim().length > 0 &&
    isStoryPacing(pacing) &&
    typeof value.voice === "string" &&
    value.voice.trim().length > 0 &&
    typeof value.tone === "string" &&
    value.tone.trim().length > 0 &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    Array.isArray(value.structure) &&
    value.structure.length > 0 &&
    value.structure.every(isStoryFormatStructurePart) &&
    typeof value.captionStyle === "string" &&
    value.captionStyle.trim().length > 0 &&
    Array.isArray(value.doNotMention) &&
    value.doNotMention.every((item) => typeof item === "string")
  );
}

function isStoryPacing(value: unknown): value is StoryPacing {
  if (!isRecord(value)) {
    return false;
  }

  const suggestedSlideCount = value.suggestedSlideCount;

  return (
    (value.openWith === "scene" || value.openWith === "thought") &&
    (value.shape === "hook-turn-landing" ||
      value.shape === "list" ||
      value.shape === "single-beat" ||
      value.shape === "spiral") &&
    typeof suggestedSlideCount === "number" &&
    Number.isInteger(suggestedSlideCount) &&
    suggestedSlideCount >= minSlideCount &&
    suggestedSlideCount <= maxSlideCount
  );
}

export type RecentStoryFormat = {
  date: string;
  mood?: Mood;
  angle?: string;
  voice?: string;
  tone?: string;
  /**
   * Legacy-tolerant read only: pre-mood-engine records carried a free-text
   * `formatName` instead of `mood`. Never written for new entries (UNC-214).
   */
  formatName?: string;
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

export type RecordStoryFormatHistoryOptions = {
  homeDir?: string;
  targetDate: string;
  storyFormatPlan: MoodPlan;
  limit?: number;
};

type StoryFormatHistoryFile = {
  // Accept both the legacy schemaVersion (1) and any future value; the
  // top-level container shape ({schemaVersion, formats}) is unchanged, only
  // the entry shape evolved (UNC-214).
  schemaVersion?: number;
  formats?: unknown[];
  recent?: unknown[];
};

type MoodPlanProviderData = JsonObject & {
  mood?: JsonValue;
  angle?: JsonValue;
  pacing?: JsonValue;
  voice?: JsonValue;
  tone?: JsonValue;
  reason?: JsonValue;
  structure?: JsonValue;
  captionStyle?: JsonValue;
  doNotMention?: JsonValue;
};

const defaultHistoryLimit = 7;
const minSlideCount = 3;
const maxSlideCount = 8;

export async function generateStoryFormatPlan(
  options: StoryFormatPlanOptions
): Promise<MoodPlan> {
  const recentFormats = options.recentFormats ?? [];
  const request = createAiGenerationRequest({
    task: "story-plan",
    instructions: buildStoryFormatInstructions({
      roastLevel: options.roastLevel,
      entryMode: "daily_global",
      recentFormats,
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
  const response = await generateStructured<MoodPlanProviderData>(
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
      .map(migrateLegacyRecentStoryFormat)
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

export async function recordStoryFormatHistory(
  options: RecordStoryFormatHistoryOptions
): Promise<void> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const limit = options.limit ?? 30;
  const existingFormats = await loadRecentStoryFormatHistory({
    homeDir: options.homeDir,
    limit
  });
  const nextFormat: RecentStoryFormat = {
    date: options.targetDate,
    mood: options.storyFormatPlan.mood,
    angle: options.storyFormatPlan.angle,
    voice: options.storyFormatPlan.voice,
    tone: options.storyFormatPlan.tone
  };
  const formats = [nextFormat, ...existingFormats]
    .filter((format, index, allFormats) => {
      return (
        allFormats.findIndex(
          (candidate) =>
            candidate.date === format.date &&
            candidate.mood === format.mood &&
            candidate.angle === format.angle &&
            candidate.voice === format.voice &&
            candidate.tone === format.tone
        ) === index
      );
    })
    .slice(0, limit);

  await mkdir(paths.historyDir, { recursive: true });
  await writeJson(paths.formatHistoryFile, {
    schemaVersion: 1,
    formats
  });
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
      // Mood/angle derivation signals (UNC-213): already-safe, already
      // surfaced in `highlights` above, exposed here as structured fields too
      // so the AI can ground mood/angle choices in specific signals rather
      // than a flattened highlights list.
      smallWins: summary.smallWins,
      blockersOrConfusion: summary.blockersOrConfusion,
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
  recentFormats: RecentStoryFormat[];
  quiet: boolean;
}): string {
  const directRoastPolicy =
    options.roastLevel >= 3
      ? "Light direct roast of work habits is allowed, but never personal attacks."
      : "Keep jokes focused on situations, tools, TODOs, bugs, and requirements.";

  const quietBiasInstruction = options.quiet
    ? [
        "This is a quiet day: bias mood toward quiet, keep suggestedSlideCount small (around 3), and make angle an honest waiting/observation angle. Never invent work to fill the plan."
      ]
    : [];

  return [
    "Design a Mood Plan for an Uncommitted diary draft.",
    `Entry mode is ${options.entryMode}; create one global diary plan across all projects.`,
    "Return structured JSON with mood, angle, pacing, voice, tone, reason, structure, captionStyle, and doNotMention.",
    "Classify today into exactly ONE mood from the fixed vocabulary: release, firefight, quiet, grind, breakthrough, cleanup. Do not invent a new mood label or a fictional genre.",
    "Choose an angle: the one thing the coworker actually noticed today, such as an irritating bug, work the user avoided, an unnoticed small win, or a tool that betrayed everyone. Ground the angle in the real activity signals only, never invented ones.",
    "Vary pacing (openWith, shape, suggestedSlideCount) structurally so entries feel different day to day, without announcing a genre or costume.",
    "This is not the user's diary. It is the AI coworker's own off-the-record account of what it noticed while working alongside the user.",
    "Choose a format that supports a felt diary, not a project status recap.",
    "Do not make the plan a report, changelog, sprint update, or metrics summary.",
    "Do not default to generic coworker essay mode; use a distinct narrative device such as a case file, field note, broadcast, trial, forecast, object monologue, letter, patrol log, or a newly invented equivalent structure, while staying inside the chosen mood rather than a separate genre.",
    "Use concrete work signals only as emotional context: tension, relief, confusion, momentum, fatigue, or tiny satisfaction.",
    "Do not claim to know the user's private feelings; describe the narrator's observations, suspicions, reactions, and workplace atmosphere.",
    "Do not invent work, commits, bugs, features, or user activity.",
    "For quiet days, acknowledge low or no recorded work and make the plan about waiting, observation, or honest quiet.",
    ...quietBiasInstruction,
    "Avoid near-duplicates of recentFormats when they are provided.",
    ...buildRecentFormatsDiversityInstructions(options.recentFormats),
    "Keep the structure readable as an Instagram carousel.",
    "Roast policy: light jokes may target situations, tools, TODOs, bugs, recurring work patterns, or requirement churn.",
    directRoastPolicy,
    "Never attack the user's identity, ability, appearance, mental health, personal value, or real life.",
    `Suggested slide count must be ${minSlideCount}-${maxSlideCount}; prefer 3-5 for quiet/low days and 5-8 for high days.`
  ].join("\n");
}

/**
 * Turns recent history into concrete anti-repetition guidance (UNC-214):
 * bias each day's plan away from the specific moods/angles/voices that were
 * just used, instead of a generic "avoid duplicates" instruction.
 */
function buildRecentFormatsDiversityInstructions(
  recentFormats: RecentStoryFormat[]
): string[] {
  if (recentFormats.length === 0) {
    return [];
  }

  const recentMoods = uniqueDefinedStrings(
    recentFormats.map((format) => format.mood)
  );
  const recentAngles = uniqueDefinedStrings(
    recentFormats.map((format) => format.angle)
  );
  const recentVoices = uniqueDefinedStrings(
    recentFormats.map((format) => format.voice)
  );

  const instructions: string[] = [];

  if (recentMoods.length > 0) {
    instructions.push(
      `Recently used moods: ${recentMoods.join(", ")}. Prefer a different mood today when the real activity signals support it; never force a mismatched mood just for variety.`
    );
  }

  if (recentAngles.length > 0) {
    instructions.push(
      `Recently used angles: ${recentAngles.join("; ")}. Choose a distinct angle instead of repeating one of these framings.`
    );
  }

  if (recentVoices.length > 0) {
    instructions.push(
      `Recently used voices/narrator devices: ${recentVoices.join(", ")}. Prefer a different voice today for structural variety.`
    );
  }

  return instructions;
}

function uniqueDefinedStrings(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (value !== undefined && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }

  return result;
}

/**
 * Maps a legacy `{date, formatName, voice, tone}` history entry onto the new
 * shape: `formatName` is mapped to `mood` only when it matches the fixed
 * mood vocabulary, otherwise `mood` is left undefined without discarding
 * `voice`/`tone` (UNC-214).
 */
function migrateLegacyRecentStoryFormat(
  entry: RecentStoryFormat
): RecentStoryFormat {
  if (entry.mood !== undefined) {
    return entry;
  }

  if (entry.formatName !== undefined && isMood(entry.formatName)) {
    return { ...entry, mood: entry.formatName };
  }

  return entry;
}

function parseStoryFormatPlan(data: MoodPlanProviderData): MoodPlan {
  if (!isMoodPlanProviderData(data)) {
    throwInvalidStoryFormatPlan();
  }

  const plan: MoodPlan = {
    schemaVersion: 2,
    mood: data.mood,
    angle: data.angle,
    pacing: data.pacing,
    voice: data.voice,
    tone: data.tone,
    reason: data.reason,
    structure: data.structure,
    captionStyle: data.captionStyle,
    doNotMention: data.doNotMention
  };

  if (!isMoodPlan(plan)) {
    throwInvalidStoryFormatPlan();
  }

  return plan;
}

function isMoodPlanProviderData(
  value: MoodPlanProviderData
): value is MoodPlanProviderData & Omit<MoodPlan, "schemaVersion"> {
  return (
    isMood(value.mood) &&
    typeof value.angle === "string" &&
    isStoryPacing(value.pacing) &&
    typeof value.voice === "string" &&
    typeof value.tone === "string" &&
    typeof value.reason === "string" &&
    Array.isArray(value.structure) &&
    value.structure.every(isStoryFormatStructurePart) &&
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
  if (!isRecord(value) || typeof value.date !== "string") {
    return false;
  }

  const hasValidMood = value.mood === undefined || isMood(value.mood);
  const hasValidAngle =
    value.angle === undefined || typeof value.angle === "string";
  const hasValidVoice =
    value.voice === undefined || typeof value.voice === "string";
  const hasValidTone =
    value.tone === undefined || typeof value.tone === "string";
  const hasValidFormatName =
    value.formatName === undefined || typeof value.formatName === "string";

  if (
    !hasValidMood ||
    !hasValidAngle ||
    !hasValidVoice ||
    !hasValidTone ||
    !hasValidFormatName
  ) {
    return false;
  }

  // A usable entry carries a diversity key: the new mood/angle shape or the
  // legacy formatName (mapped to mood on load when it matches the
  // vocabulary; see migrateLegacyRecentStoryFormat).
  return value.mood !== undefined || value.formatName !== undefined;
}

function throwInvalidStoryFormatPlan(): never {
  throw new AiGenerationError(
    "AI provider returned invalid story format plan.",
    "malformed-response"
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
