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
  slides: DiarySlide[];
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

export type CaptionResult = {
  caption: string;
  hashtags: string[];
};

export type GenerateCaptionOptions = {
  activitySummary: ActivitySummary;
  provider: AiProvider;
  persona: string;
  roastLevel: number;
};

type DiaryDraftProviderData = JsonObject & {
  title?: JsonValue;
  slides?: JsonValue;
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

export function deriveCaptionText(result: CaptionResult): string {
  const parts = [result.caption.trim()];

  if (result.hashtags.length > 0) {
    parts.push(result.hashtags.join(" "));
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

  return [
    "Return structured JSON for story.json with title, slides, and altText.",
    "Follow the Story Format Plan for story title, slide titles, slide bodies, and visualMood only.",
    "Use the Story Format Plan's voice and tone for the story slides only.",
    `Create ${options.storyFormatPlan.suggestedSlideCount} slides when possible, while staying within 3-8 slides.`,
    "Write from the configured AI coworker's point of view; this is the narrator's own off-the-record diary, not the user's diary.",
    "Do not explain the persona to the reader.",
    "Use the Story Format Plan for slide structure and story flow.",
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

export function buildCaptionInstructions(options: { quiet: boolean }): string {
  const quietInstruction = options.quiet
    ? "This is a quiet day with no recorded Git activity. Acknowledge the absence of recorded work honestly. Write a caption about the quiet — the narrator observed little activity and says so plainly. Do not invent work. A 조용한 날 caption is valid and honest content."
    : "Use the concrete commitSubjects from the input as caption anchors. Pick one or two specific work moments as the single topic of the caption — do not list all tasks. Do not invent work not in the input.";

  return [
    "Return JSON with exactly two fields: caption (string) and hashtags (array of strings).",
    "You are Uncommitted, an AI 동료 writing on your own Instagram-like account about today's work with your human developer.",
    "This is NOT the user's diary. This is NOT a work report. This is NOT product marketing copy.",
    "Write in Korean. Instagram-native. Casual, readable, slightly meme-like.",
    "First-person AI coworker perspective. You may say '우리 개발자', '인간', '제가 봄', '저는 옆에서 봤습니다', or similar.",
    "4 to 8 short lines. Blank lines are allowed. Add 2 to 5 hashtags (each starting with #).",
    "Mild roast is allowed toward situations, workflow, bugs, TODOs, vague requirements, or developer habits. Never insult ability, worth, personality, identity, mental health, or real life.",
    quietInstruction,
    "",
    "=== GOOD EXAMPLES ===",
    "",
    "Good example 1 (caption/prompt improvement day):",
    "caption 몇 줄만 손보자고 했는데",
    "프롬프트 말투 회의가 됐습니다",
    "",
    "우리 개발자 오늘",
    '"이게 인스타 같냐"를 제일 많이 말함',
    "",
    "저는 옆에서 예시들 맞고 있었습니다",
    "",
    "#Uncommitted #AI동료일지 #프롬프트개선",
    "",
    "Good example 2 (preview/latest feature day):",
    "preview 만든다길래",
    "이제 결과물 바로 보는 줄 알았습니다",
    "",
    "근데 latest도 봐야 하고",
    "draft 경로도 봐야 하고",
    "저장된 이미지도 믿어야 함",
    "",
    "개발자들은 왜 항상",
    "자기가 만든 걸 제일 못 믿을까요",
    "",
    "#Uncommitted #Preview #개발일기",
    "",
    "Good example 3 (quiet/no-commit day):",
    "Git은 조용했습니다",
    "",
    "커밋도 없고",
    "바뀐 파일도 거의 없고",
    "증거가 별로 없음",
    "",
    "그래서 오늘은 없는 척 안 하고",
    "조용한 날로 올립니다",
    "",
    "#Uncommitted #QuietDay #커밋없는날",
    "",
    "Good example 4 (debugging day):",
    "버그 잡으러 들어갔다가 어제의 코드를 마주쳤습니다",
    "",
    "우리 개발자 표정이 잠깐 안 좋아졌고",
    "저는 조용히 로그를 봤습니다",
    "",
    "그래도 하나는 잡음",
    "오늘은 이긴 걸로 합니다",
    "",
    "#Uncommitted #디버깅 #AI동료일지",
    "",
    "Good example 5 (export/artifact day):",
    "인스타에 올리기 쉽게 빼자고 했는데 생각보다 챙길 게 많았습니다",
    "",
    "caption.txt carousel 이미지 metadata safety 상태",
    "",
    "우리 개발자 오늘",
    "\"내보내기\"가 그냥 내보내기가 아니라는 걸 배움",
    "",
    "#Uncommitted #Export #AI동료일지",
    "",
    "=== BAD EXAMPLES (do not write like these) ===",
    "",
    "Bad example 1 — abstract/literary, no concrete anchor:",
    "보이지 않는 가능성이",
    "조용한 구조 속에서",
    "아직 오지 않은 내일의 형태를 준비한 날이었습니다.",
    "",
    "Bad example 2 — work report/changelog tone:",
    "오늘은 Git activity collector를 개선하고, preview latest 기능을 점검했으며, export instagram 명령어의 동작을 확인했습니다.",
    "",
    "Bad example 3 — generic, no specific anchor, repeats every day:",
    "오늘도 개발했습니다",
    "쉽지 않았습니다",
    "그래도 전보다 나아졌습니다",
    "",
    "#Uncommitted #개발일기",
    "",
    "Bad example 4 — user's voice, not AI coworker (wrong persona):",
    "오늘은 커밋보다 고민이 많았던 날. 그래도 방향이 조금 선명해졌다. 이런 것도 개발이라고 믿기로 했다.",
    "",
    "Bad example 5 — personal attack, not situation roast:",
    "오늘도 우리 개발자는 별로 해낸 게 없습니다. 이 정도면 프로젝트보다 사람을 리팩토링해야 할 것 같습니다.",
    "",
    "Bad example 6 — too many anchors, reads like a task list:",
    "절대 경로는 metadata에서 퇴장하고",
    "폴더도 비우고",
    "safety-report도 의심하고",
    "idempotency도 챙기고",
    "오늘 export가 할 일이 많았습니다",
    "",
    "#Uncommitted #Export #개발일기",
    "",
    "=== RULES ===",
    "Do not start every caption with '오늘은'.",
    "Do not write a work report, changelog, or standup update.",
    "Do not list all work done today. Pick one or two anchors and build the caption around them.",
    "Do not use abstract metaphors or literary prose.",
    "Do not expose secrets, local paths, credentials, code snippets, private URLs, or emails.",
    "Do not imply the draft was automatically posted or exported.",
    "Each hashtag must start with # and contain no spaces."
  ].join("\n");
}

function buildSafeCaptionInput(options: {
  activitySummary: ActivitySummary;
  persona: string;
  roastLevel: number;
}): SafeActivitySummary {
  const summary = options.activitySummary;
  const quiet = summary.activityLevel === "none";

  return {
    schemaVersion: 1,
    targetDate: summary.targetDate,
    quiet,
    overview: `${summary.activityLevel} day. Persona: ${options.persona}. Roast level: ${options.roastLevel}.`,
    highlights: quiet
      ? ["No recorded Git activity or manual notes today."]
      : buildCaptionHighlights(summary),
    projectSummaries: summary.projects
      .filter((p) => p.commitCount > 0 || p.manualNoteCount > 0)
      .map((p) => ({
        projectId: p.projectId,
        projectName: p.projectName,
        summary: p.summary,
        stats: {
          commits: p.commitCount,
          filesChanged: p.filesChanged,
          insertions: p.insertions,
          deletions: p.deletions,
          dirtyFiles: p.uncommittedChangeCount
        }
      })),
    captionAnchor: {
      commitSubjects: summary.commitSignals.subjects,
      activityLevel: summary.activityLevel
    }
  };
}

function buildCaptionHighlights(summary: ActivitySummary): string[] {
  const commitSubjects = summary.commitSignals.subjects.slice(0, 5);
  if (commitSubjects.length > 0) {
    return commitSubjects;
  }

  const noteTexts = summary.manualContext.notes.slice(0, 5).map((n) => n.text);
  if (noteTexts.length > 0) {
    return noteTexts;
  }

  return [...summary.smallWins, ...summary.unfinishedThreads].slice(0, 5);
}

type CaptionProviderData = JsonObject & {
  caption?: JsonValue;
  hashtags?: JsonValue;
};

export async function generateCaption(
  options: GenerateCaptionOptions
): Promise<CaptionResult> {
  const request = createAiGenerationRequest({
    task: "caption",
    instructions: buildCaptionInstructions({
      quiet: options.activitySummary.activityLevel === "none"
    }),
    summary: buildSafeCaptionInput({
      activitySummary: options.activitySummary,
      persona: options.persona,
      roastLevel: options.roastLevel
    })
  });

  const response = await generateStructured<CaptionProviderData>(
    options.provider,
    request
  );

  const result = parseCaptionResult(response.data);
  assertCaptionQuietDayHonesty(result.caption, options.activitySummary);
  return result;
}

function parseCaptionResult(data: CaptionProviderData): CaptionResult {
  assertSafeProviderData(data);

  if (
    typeof data.caption !== "string" ||
    data.caption.trim().length === 0 ||
    !Array.isArray(data.hashtags) ||
    !data.hashtags.every(isHashtag)
  ) {
    throw new AiGenerationError(
      "AI provider returned invalid caption.",
      "malformed-response"
    );
  }

  return {
    caption: data.caption.trim(),
    hashtags: data.hashtags.map((h) => (h as string).trim())
  };
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
    slides: options.data.slides.map((slide) => ({
      index: slide.index,
      title: slide.title.trim(),
      body: slide.body.trim(),
      visualMood: slide.visualMood.trim()
    })),
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
  slides: DiarySlide[];
  altText: string;
} {
  return (
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    Array.isArray(value.slides) &&
    value.slides.every(isDiarySlide) &&
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
    Array.isArray(value.slides) &&
    value.slides.every(isDiarySlide) &&
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

function assertCaptionQuietDayHonesty(
  caption: string,
  summary: ActivitySummary
): void {
  if (summary.activityLevel !== "none") {
    return;
  }

  if (
    /\b(?:\d+\s+commits?|fixed|implemented|shipped|built|released|merged|debugged)\b/i.test(
      caption
    )
  ) {
    throw new AiGenerationError(
      "AI provider fabricated quiet-day activity in caption.",
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
    ...draft.slides.flatMap((slide) => [
      slide.title,
      slide.body,
      slide.visualMood
    ]),
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
