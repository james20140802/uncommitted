import type { ActivityLevel, ActivitySummary } from "./activity-summary.js";
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
import type {
  ProjectPersonaHint,
  StoryFormatPlan
} from "./story-format-plan.js";

export type DiarySlide = {
  index: number;
  title: string;
  body: string;
  visualMood: string;
};

export type DiaryDraftMetadata = {
  targetDate: string;
  generatedAt: string;
  activityLevel: ActivityLevel;
  formatName: string;
  storyFormatVoice: string;
  storyFormatTone: string;
  projectIds: string[];
  entryMode: "daily_global";
  slideCount: number;
};

export type DiaryDraft = {
  schemaVersion: 1;
  targetDate: string;
  title: string;
  caption: string;
  slides: DiarySlide[];
  hashtags: string[];
  altText: string;
  metadata: DiaryDraftMetadata;
};

export type DiaryGeneratorOptions = {
  activitySummary: ActivitySummary;
  storyFormatPlan: StoryFormatPlan;
  provider: AiProvider;
  persona: string;
  roastLevel: number;
  projectPersonaHints?: ProjectPersonaHint[];
  entryMode?: "daily_global";
};

type DiaryDraftProviderData = JsonObject & {
  title?: JsonValue;
  caption?: JsonValue;
  slides?: JsonValue;
  hashtags?: JsonValue;
  altText?: JsonValue;
};

const minSlideCount = 3;
const maxSlideCount = 8;
const unsafeOutputKeys = new Set([
  "apikey",
  "api_key",
  "absolutepath",
  "absolute_path",
  "diff",
  "gitroot",
  "git_root",
  "password",
  "patch",
  "rawcode",
  "raw_code",
  "rawdiff",
  "raw_diff",
  "rawtranscript",
  "raw_transcript",
  "remoteurl",
  "remote_url",
  "secret",
  "secrets",
  "token",
  "tokens",
  "transcript"
]);

export async function generateDiaryDraft(
  options: DiaryGeneratorOptions
): Promise<DiaryDraft> {
  const request = createAiGenerationRequest({
    task: "draft",
    instructions: buildDiaryInstructions({
      quiet: options.activitySummary.activityLevel === "none",
      roastLevel: options.roastLevel,
      storyFormatPlan: options.storyFormatPlan
    }),
    summary: buildSafeDiaryInput({
      activitySummary: options.activitySummary,
      storyFormatPlan: options.storyFormatPlan,
      persona: options.persona,
      roastLevel: options.roastLevel,
      projectPersonaHints: options.projectPersonaHints ?? []
    })
  });
  const response = await generateStructured<DiaryDraftProviderData>(
    options.provider,
    request
  );

  return parseDiaryDraft({
    data: response.data,
    activitySummary: options.activitySummary,
    storyFormatPlan: options.storyFormatPlan
  });
}

export function deriveCaptionText(draft: DiaryDraft): string {
  const parts = [draft.caption.trim()];

  if (draft.hashtags.length > 0) {
    parts.push(draft.hashtags.join(" "));
  }

  return `${parts.join("\n\n")}\n`;
}

function buildSafeDiaryInput(options: {
  activitySummary: ActivitySummary;
  storyFormatPlan: StoryFormatPlan;
  persona: string;
  roastLevel: number;
  projectPersonaHints: ProjectPersonaHint[];
}): SafeActivitySummary {
  const summary = options.activitySummary;
  const quiet = summary.activityLevel === "none";

  return {
    schemaVersion: 1,
    targetDate: summary.targetDate,
    quiet,
    overview: `${summary.activityLevel} ${summary.dominantTheme} day with ${summary.projects.length} ${summary.projects.length === 1 ? "project" : "projects"}.`,
    highlights: buildHighlights(summary, quiet),
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
    storyFormatPlan: {
      formatName: options.storyFormatPlan.formatName,
      voice: options.storyFormatPlan.voice,
      tone: options.storyFormatPlan.tone,
      reason: options.storyFormatPlan.reason,
      structure: options.storyFormatPlan.structure.map((part) => ({
        part: part.part,
        purpose: part.purpose
      })),
      suggestedSlideCount: options.storyFormatPlan.suggestedSlideCount,
      captionStyle: options.storyFormatPlan.captionStyle,
      doNotMention: options.storyFormatPlan.doNotMention
    },
    roastPolicy: {
      roastLevel: options.roastLevel,
      allowDirectUserRoast: options.roastLevel >= 3,
      boundaries: [
        "Roast situations, tools, TODOs, bugs, recurring work patterns, or requirement churn only.",
        "Never attack identity, ability, appearance, mental health, personal value, or real life."
      ]
    },
    projectPersonaHints: options.projectPersonaHints,
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

function buildDiaryInstructions(options: {
  quiet: boolean;
  roastLevel: number;
  storyFormatPlan: StoryFormatPlan;
}): string {
  const directRoastPolicy =
    options.roastLevel >= 3
      ? "Light direct roast of work habits is allowed, but never personal attacks."
      : "Keep jokes focused on situations, tools, TODOs, bugs, and requirements.";
  const quietInstruction = options.quiet
    ? "For quiet days, acknowledge no recorded work and pivot to waiting, observation, or an honest quiet-day monologue."
    : "Use only the concrete work signals in the activity summary.";
  const captionMomentInstruction = options.quiet
    ? "For quiet-day captions, mention the absence of recorded work honestly, then add the narrator's reaction to the quiet."
    : "Mention one or two concrete work moments from the activity summary, then add the narrator's reaction.";

  return [
    "Return structured JSON for story.json with title, caption, slides, hashtags, and altText.",
    `Follow the Story Format Plan named ${options.storyFormatPlan.formatName}.`,
    `Use ${options.storyFormatPlan.voice} as the voice and ${options.storyFormatPlan.tone} as the tone.`,
    `Create ${options.storyFormatPlan.suggestedSlideCount} slides when possible, while staying within 3-8 slides.`,
    "Write from the configured AI coworker's point of view; this is the narrator's own off-the-record diary, not the user's diary.",
    "The configured AI coworker persona is the caption narrator, not a topic, tag, or weak style hint.",
    "Do not explain the persona to the reader.",
    "Use the Story Format Plan for slide structure and story flow.",
    "Make the selected genre visible in the title, slide titles, and slide bodies without explaining the genre.",
    "Do not force the selected genre to be visible in the caption; the genre may lightly color the caption, but it must not take over.",
    "Caption must be copyable as an Instagram caption, Korean by default, concise, and not report-like.",
    "Write like a real Instagram caption someone might post after work.",
    "Plain, casual, emotionally specific Korean is better than elegant abstract writing.",
    "Do not try to sound literary, polished, profound, inspirational, or clever.",
    captionMomentInstruction,
    "Use everyday reactions such as frustration, relief, awkwardness, tiredness, doubt, stubbornness, small satisfaction, or mild embarrassment.",
    "Do not write a status report, executive summary, changelog, standup update, task summary, task handoff, or metric-led recap.",
    "Avoid report words and shapes such as summary, snapshot, total commits, files changed, insertions, deletions, next steps, owner, or action items.",
    "Avoid metric-led phrasing such as total commits, files changed, insertion/deletion counts, project-by-project bullets, or next-action owner lines.",
    "Avoid abstract literary lines, polished metaphors, slogan-like sentences, and overly conceptual endings.",
    "Do not claim to know the user's inner feelings; frame emotional language as the narrator's reaction or the atmosphere around the work.",
    "Prefer concrete moments and the narrator's everyday reaction over task lists.",
    "Each slide must include index, title, body, and visualMood.",
    "Prefer 3-5 slides for quiet or low activity days; this is guidance, not a hard validation limit.",
    "Do not invent work, commits, bugs, features, shipped changes, or user activity.",
    quietInstruction,
    "Never include raw code, raw diffs, secrets, private paths, emails, private URLs, or private remote URLs.",
    "Roast policy: jokes may target situations, tools, TODOs, bugs, recurring work patterns, or requirement churn.",
    directRoastPolicy,
    "Never attack the user's identity, ability, appearance, mental health, personal value, or real life.",
    "Do not imply the draft was automatically posted or exported."
  ].join("\n");
}

function parseDiaryDraft(options: {
  data: DiaryDraftProviderData;
  activitySummary: ActivitySummary;
  storyFormatPlan: StoryFormatPlan;
}): DiaryDraft {
  assertSafeProviderData(options.data);

  if (!isDiaryDraftProviderData(options.data)) {
    throwInvalidDiaryDraft();
  }

  const draft: DiaryDraft = {
    schemaVersion: 1,
    targetDate: options.activitySummary.targetDate,
    title: options.data.title.trim(),
    caption: options.data.caption.trim(),
    slides: options.data.slides.map((slide) => ({
      index: slide.index,
      title: slide.title.trim(),
      body: slide.body.trim(),
      visualMood: slide.visualMood.trim()
    })),
    hashtags: options.data.hashtags.map((hashtag) => hashtag.trim()),
    altText: options.data.altText.trim(),
    metadata: {
      targetDate: options.activitySummary.targetDate,
      generatedAt: options.activitySummary.generatedAt,
      activityLevel: options.activitySummary.activityLevel,
      formatName: options.storyFormatPlan.formatName,
      storyFormatVoice: options.storyFormatPlan.voice,
      storyFormatTone: options.storyFormatPlan.tone,
      projectIds: options.activitySummary.projects.map(
        (project) => project.projectId
      ),
      entryMode: "daily_global",
      slideCount: options.data.slides.length
    }
  };

  if (!isDiaryDraft(draft)) {
    throwInvalidDiaryDraft();
  }

  assertSlideCount(draft);
  assertQuietDayHonesty(draft, options.activitySummary);

  return draft;
}

function isDiaryDraftProviderData(
  value: DiaryDraftProviderData
): value is DiaryDraftProviderData & {
  title: string;
  caption: string;
  slides: DiarySlide[];
  hashtags: string[];
  altText: string;
} {
  return (
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.caption === "string" &&
    value.caption.trim().length > 0 &&
    Array.isArray(value.slides) &&
    value.slides.every(isDiarySlide) &&
    Array.isArray(value.hashtags) &&
    value.hashtags.every(isHashtag) &&
    typeof value.altText === "string" &&
    value.altText.trim().length > 0
  );
}

function isDiaryDraft(value: unknown): value is DiaryDraft {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === 1 &&
    typeof value.targetDate === "string" &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.caption === "string" &&
    value.caption.trim().length > 0 &&
    Array.isArray(value.slides) &&
    value.slides.every(isDiarySlide) &&
    Array.isArray(value.hashtags) &&
    value.hashtags.every(isHashtag) &&
    typeof value.altText === "string" &&
    value.altText.trim().length > 0 &&
    isDiaryMetadata(value.metadata)
  );
}

function isDiarySlide(value: unknown): value is DiarySlide {
  return (
    isRecord(value) &&
    Number.isInteger(value.index) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.body === "string" &&
    value.body.trim().length > 0 &&
    typeof value.visualMood === "string" &&
    value.visualMood.trim().length > 0
  );
}

function isDiaryMetadata(value: unknown): value is DiaryDraftMetadata {
  return (
    isRecord(value) &&
    typeof value.targetDate === "string" &&
    typeof value.generatedAt === "string" &&
    typeof value.activityLevel === "string" &&
    typeof value.formatName === "string" &&
    typeof value.storyFormatVoice === "string" &&
    typeof value.storyFormatTone === "string" &&
    Array.isArray(value.projectIds) &&
    value.projectIds.every((projectId) => typeof projectId === "string") &&
    value.entryMode === "daily_global" &&
    Number.isInteger(value.slideCount)
  );
}

function isHashtag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#[^\s#]+$/u.test(value.trim()) &&
    value.trim().length > 1
  );
}

function assertSlideCount(draft: DiaryDraft): void {
  if (
    draft.slides.length < minSlideCount ||
    draft.slides.length > maxSlideCount
  ) {
    throwInvalidDiaryDraft();
  }

  const expectedIndexes = draft.slides.every(
    (slide, index) => slide.index === index + 1
  );

  if (!expectedIndexes) {
    throwInvalidDiaryDraft();
  }
}

function assertQuietDayHonesty(
  draft: DiaryDraft,
  summary: ActivitySummary
): void {
  if (summary.activityLevel !== "none") {
    return;
  }

  const text = collectDraftText(draft).join("\n");

  if (
    /\b(?:\d+\s+commits?|fixed|implemented|shipped|built|released|merged|debugged)\b/i.test(
      text
    )
  ) {
    throw new AiGenerationError(
      "AI provider fabricated quiet-day activity.",
      "malformed-response"
    );
  }
}

function assertSafeProviderData(value: JsonValue): void {
  assertNoUnsafeKeys(value);
  assertNoUnsafeStrings(value);
}

function assertNoUnsafeKeys(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUnsafeKeys(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (isUnsafeKey(key)) {
      throwUnsafeDiaryDraft();
    }

    if (!isJsonValue(child)) {
      throwInvalidDiaryDraft();
    }

    assertNoUnsafeKeys(child);
  }
}

function assertNoUnsafeStrings(value: JsonValue): void {
  if (typeof value === "string") {
    if (containsUnsafeText(value)) {
      throwUnsafeDiaryDraft();
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUnsafeStrings(item);
    }
    return;
  }

  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      if (isJsonValue(child)) {
        assertNoUnsafeStrings(child);
      }
    }
  }
}

function collectDraftText(draft: DiaryDraft): string[] {
  return [
    draft.title,
    draft.caption,
    ...draft.slides.flatMap((slide) => [
      slide.title,
      slide.body,
      slide.visualMood
    ]),
    ...draft.hashtags,
    draft.altText
  ];
}

function containsUnsafeText(value: string): boolean {
  return (
    /\bdiff --git\b/i.test(value) ||
    /`[^`]+`/.test(value) ||
    /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/i.test(
      value
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value) ||
    /\bsk-[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/.test(value) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
    /(^|[\s(["'])\/[^\s)"']+/.test(value)
  );
}

function isUnsafeKey(key: string): boolean {
  return unsafeOutputKeys.has(key.toLowerCase().replace(/[-\s]/g, "_"));
}

function throwInvalidDiaryDraft(): never {
  throw new AiGenerationError(
    "AI provider returned invalid diary draft.",
    "malformed-response"
  );
}

function throwUnsafeDiaryDraft(): never {
  throw new AiGenerationError(
    "AI provider returned unsafe diary draft.",
    "malformed-response"
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    isJsonObject(value)
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
