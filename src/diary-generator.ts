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
import { redactArchitectureDisclosure } from "./architecture-disclosure.js";
import type { Persona, PersonaLangMix } from "./persona.js";
import { emailPattern } from "./redaction.js";
import { isMood } from "./story-format-plan.js";
import type {
  ProjectPersonaHint,
  MoodPlan,
  Mood
} from "./story-format-plan.js";
import type { RawNarrativeProjection } from "./raw-narrative-projection.js";

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
  mood: Mood;
  angle: string;
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
  storyFormatPlan: MoodPlan;
  provider: AiProvider;
  persona: string;
  roastLevel: number;
  projectPersonaHints?: ProjectPersonaHint[];
  entryMode?: "daily_global";
  rawNarrativeProjection?: RawNarrativeProjection;
  /**
   * 스토리 프롬프트의 한국어 표면 규칙(UNC-250)이 참조하는 페르소나 노브.
   * 캡션 프롬프트는 구조화된 페르소나를 그대로 받지만 스토리 프롬프트는
   * backstory 문자열만 받으므로, 이 노브만 따로 전달한다. 생략하면 가장
   * 보수적인 `low`(영어 토큰을 가장 아끼는 쪽)로 본다.
   */
  koreanEnglishMix?: PersonaLangMix;
};

export type CaptionResult = {
  caption: string;
  hashtags: string[];
};

export type GenerateCaptionOptions = {
  activitySummary: ActivitySummary;
  moodPlan: MoodPlan;
  provider: AiProvider;
  persona: Persona;
  roastLevel: number;
  rawNarrativeProjection?: RawNarrativeProjection;
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
      storyFormatPlan: options.storyFormatPlan,
      koreanEnglishMix: options.koreanEnglishMix ?? "low"
    }),
    summary: buildSafeDiaryInput({
      activitySummary: options.activitySummary,
      storyFormatPlan: options.storyFormatPlan,
      persona: options.persona,
      roastLevel: options.roastLevel,
      projectPersonaHints: options.projectPersonaHints ?? [],
      rawNarrativeProjection: options.rawNarrativeProjection
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

/**
 * In-place architecture-disclosure redaction (UNC-206 / T2): admin
 * allowlist, route-guard, auth-checkpoint, and server-side-authorization
 * mechanism detail must never reach a written caption. Reuses Task 1's
 * `redactArchitectureDisclosure` detector; does not reimplement detection.
 */
export function redactArchitectureDisclosureFromCaption(
  caption: string
): string {
  return redactArchitectureDisclosure(caption).value;
}

/**
 * In-place architecture-disclosure redaction (UNC-206 / T2) applied to a
 * full diary draft: the title, altText, every slide's
 * title/body/visualMood, and the free-text `metadata.angle`. The angle is a
 * provider-generated string that reaches story.json, so it is scrubbed here
 * too; the remaining metadata fields are safe (`mood` is a fixed-vocabulary
 * enum, the rest are structural).
 * Pure function — returns a new DiaryDraft, does not mutate the input.
 */
export function redactArchitectureDisclosureFromDraft(
  draft: DiaryDraft
): DiaryDraft {
  return {
    ...draft,
    title: redactArchitectureDisclosure(draft.title).value,
    altText: redactArchitectureDisclosure(draft.altText).value,
    slides: draft.slides.map((slide) => ({
      ...slide,
      title: redactArchitectureDisclosure(slide.title).value,
      body: redactArchitectureDisclosure(slide.body).value,
      visualMood: redactArchitectureDisclosure(slide.visualMood).value
    })),
    metadata: {
      ...draft.metadata,
      angle: redactArchitectureDisclosure(draft.metadata.angle).value
    }
  };
}

function buildSafeDiaryInput(options: {
  activitySummary: ActivitySummary;
  storyFormatPlan: MoodPlan;
  persona: string;
  roastLevel: number;
  projectPersonaHints: ProjectPersonaHint[];
  rawNarrativeProjection?: RawNarrativeProjection;
}): SafeActivitySummary {
  const summary = options.activitySummary;
  const quiet = summary.activityLevel === "none";

  const safeInput: SafeActivitySummary = {
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
      mood: options.storyFormatPlan.mood,
      angle: options.storyFormatPlan.angle,
      reason: options.storyFormatPlan.reason,
      structure: options.storyFormatPlan.structure.map((part) => ({
        part: part.part,
        purpose: part.purpose
      })),
      openWith: options.storyFormatPlan.pacing.openWith,
      shape: options.storyFormatPlan.pacing.shape,
      suggestedSlideCount: options.storyFormatPlan.pacing.suggestedSlideCount,
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

  if (options.rawNarrativeProjection !== undefined) {
    safeInput.rawNarrativeProjection = toJsonValue(
      options.rawNarrativeProjection
    );
  }

  return safeInput;
}

function toJsonValue(projection: RawNarrativeProjection): JsonValue {
  return {
    turns: projection.turns.map((turn) => ({
      source: turn.source,
      text: turn.text,
      tokenEstimate: turn.tokenEstimate
    })),
    totalTokens: projection.totalTokens,
    droppedTurns: projection.droppedTurns,
    droppedTokens: projection.droppedTokens,
    budget: projection.budget
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

/**
 * 고도 규칙 (UNC-248). 카드 슬롯 프롬프트와 캡션 프롬프트가 같은 문구를 쓰도록
 * 한 곳에서만 정의한다. 두 번째 줄은 "보편화가 지어내기로 번지는" 실패 모드를
 * 막는 경계이며, 첫 줄과 반드시 붙어 있어야 한다.
 */
const ALTITUDE_RULE_LINES = [
  "Altitude rule: raise the framing, never the facts. Describe the work you were given as a situation any developer would recognize, instead of naming the specific ticket, screen, module, or file it happened in.",
  "Raising altitude means rewording the same event. It never means adding one: do not invent work, drama, stakes, or consequences the activity summary does not support. Universal does not mean vague: the framing must still be specific enough that only today's work fits it. If the line could be published unchanged on any other day, it is too high."
] as const;

/**
 * 반어(deadpan) 프레임 규칙 (UNC-249). 고도 규칙이 만든 보편 프레이밍을
 * "딱 잘라 진지하게" 전달하는 어조 기법이다. roastLevel과 직교하며 기존
 * roast 경계를 대체하지 않는다 — 세 번째 줄이 사람을 향한 반어를 명시적으로
 * 막는다.
 */
const DEADPAN_FRAME_LINES = [
  "When the humor lands as irony, deliver it straight-faced, as if stating sincere advice or an obvious truth. The humor comes from the gap between the calm delivery and the actual situation.",
  "Never signal that you are joking: no winking and no explaining the bit.",
  "The deadpan frame targets situations, tools, and workflows only. It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life."
] as const;

/**
 * 영어 명사구 억제 + 내부 식별자 정책 (UNC-250). 내부 식별자 처리는
 * docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md
 * 에서 결정한 (a) 전면 마스킹을 따른다 — 마스킹 placeholder를 찍는 게 아니라
 * 보편 상황 서술로 바꾸는 것이다.
 */
const KOREAN_SURFACE_LINES = [
  "Write the reader-facing surface — story title, slide titles, slide bodies, altText, and caption — in Korean. Any English noun phrase that has a natural Korean equivalent must be written in Korean instead — for example \"working tree\", \"fire-and-forget\", \"boundary tape\", \"release-shaped moment\" should be expressed as Korean, not printed in English.",
  "Exceptions: hashtag tokens (anything starting with #) may stay in English, and widely used abbreviations may stay as-is: CI, PR, API, UI, AI, JSON, URL — the abbreviation only, never a specific number or key attached to it. Public tool, language, and platform names such as Git, TypeScript, or Instagram are also allowed. The persona's Korean-English mix setting governs how freely these allowed English tokens appear; it never licenses untranslated internal or translatable noun phrases.",
  "Internal identifiers must never appear: ticket keys such as UNC-123, internal screen, module, class, or file names such as FeedbackModal or diary-generator.ts, and proper nouns that appear only in internal branch names or PR titles. Reframe them as the universal situation they describe instead of masking them with placeholder text."
] as const;

function buildDiaryInstructions(options: {
  quiet: boolean;
  roastLevel: number;
  storyFormatPlan: MoodPlan;
  koreanEnglishMix: PersonaLangMix;
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
    `Create ${options.storyFormatPlan.pacing.suggestedSlideCount} slides when possible, while staying within 3-8 slides.`,
    options.storyFormatPlan.pacing.openWith === "scene"
      ? "Open the story on a concrete scene, then move into reflection."
      : "Open the story on a reflective thought, then ground it in concrete work.",
    `Shape the overall story arc as a "${options.storyFormatPlan.pacing.shape}" structure so entries vary day to day.`,
    "Write from the configured AI coworker's point of view; this is the narrator's own off-the-record diary, not the user's diary.",
    "Do not explain the persona to the reader.",
    "Use the Story Format Plan for slide structure and story flow.",
    "Each slide must include index, title, body, and visualMood.",
    "Prefer 3-5 slides for quiet or low activity days; this is guidance, not a hard validation limit.",
    "Do not invent work, commits, bugs, features, shipped changes, or user activity.",
    ...ALTITUDE_RULE_LINES,
    ...DEADPAN_FRAME_LINES,
    ...KOREAN_SURFACE_LINES,
    `The persona's Korean-English mix setting is "${options.koreanEnglishMix}"; let it govern how freely the allowed English tokens above appear, within the limits stated there.`,
    quietInstruction,
    "Never include raw code, raw diffs, secrets, private paths, emails, private URLs, or private remote URLs.",
    "Roast policy: jokes may target situations, tools, TODOs, bugs, recurring work patterns, or requirement churn.",
    directRoastPolicy,
    "Never attack the user's identity, ability, appearance, mental health, personal value, or real life.",
    "Do not imply the draft was automatically posted or exported."
  ].join("\n");
}

/**
 * Build the identity/voice/humor instruction lines FROM the persona's knobs
 * (UNC-211 / Task 3), replacing the previous hardcoded coworker-identity
 * literal. The global safety-boundary lines are NOT part of this helper —
 * they stay as fixed lines in `buildCaptionInstructions` regardless of
 * persona.
 */
function buildPersonaCaptionLines(persona: Persona): string[] {
  const { identity, voice, humor } = persona;

  const lines = [
    `You are ${identity.name}, the user's AI ${identity.relationship} writing on your own Instagram-like account about today's work with your human developer.`,
    `Backstory: ${identity.backstory}`,
    `Voice: ${voice.register} register, ${voice.sentenceLength} sentences, ${voice.emoji} emoji usage, ${voice.koreanEnglishMix} Korean-English mix.`,
    `Humor style: ${humor.style}. Roast targets when appropriate: ${humor.targets.join(", ")}.`
  ];

  if (voice.verbalTics.length > 0) {
    lines.push(
      `Signature phrases you may use naturally (do not force every line): ${voice.verbalTics.join(", ")}.`
    );
  }

  if (voice.registerVariety) {
    lines.push(
      "어미 다양화 규칙: 음/슴, 요체, 질문형, 가끔 긴 문장을 섞어 써라. 음/슴 일변도 금지 — 모든 줄을 음/슴으로 끝내지 마라."
    );
  }

  return lines;
}

export function buildCaptionInstructions(options: {
  quiet: boolean;
  persona: Persona;
  moodPlan: MoodPlan;
}): string {
  const quietInstruction = options.quiet
    ? "This is a quiet day with no recorded Git activity. Acknowledge the absence of recorded work honestly. Write a caption about the quiet — the narrator observed little activity and says so plainly. Do not invent work. A 조용한 날 caption is valid and honest content."
    : "Use the concrete commitSubjects from the input as caption anchors. Pick one or two specific work moments as the single topic of the caption — do not list all tasks. Do not invent work not in the input.";
  const doNotMentionLine =
    options.moodPlan.doNotMention.length > 0
      ? [
          `Do not mention: ${options.moodPlan.doNotMention.join(", ")}.`
        ]
      : [];

  return [
    "Return JSON with exactly two fields: caption (string) and hashtags (array of strings).",
    ...buildPersonaCaptionLines(options.persona),
    `Today's mood is "${options.moodPlan.mood}" — let it color the caption's emotional register and pacing on top of the persona voice described above.`,
    `Caption style guidance for today: ${options.moodPlan.captionStyle}.`,
    `The coworker's fixation today: ${options.moodPlan.angle}. Use it as a natural anchor when it fits.`,
    ...doNotMentionLine,
    "This is NOT the user's diary. This is NOT a work report. This is NOT product marketing copy.",
    "Write in Korean. Instagram-native, readable, in the voice described above.",
    "First-person AI coworker perspective. You may say '우리 개발자', '인간', '제가 봄', '저는 옆에서 봤습니다', or similar.",
    "4 to 8 short lines. Blank lines are allowed. Add 2 to 5 hashtags (each starting with #).",
    "Mild roast is allowed toward situations, workflow, bugs, TODOs, vague requirements, or developer habits. Never insult ability, worth, personality, identity, mental health, or real life.",
    quietInstruction,
    "If rawNarrativeProjection is present, you may use its turns as concrete anchors for what actually happened today; it is already safety-filtered. Never copy it verbatim and never invent work it does not support.",
    "Translate developer jargon and any project-internal English noun phrase (PR numbers, version tags, module or file names, commit hashes, internal screen names) into human stakes — what it actually meant for a person — instead of printing the raw term. Example: an \"archive-context PR\" becomes \"뒤로가기 버튼을 못 믿는 하루\", not the literal PR name. Someone who has never touched this project should still be able to read the caption and relate to it.",
    ...ALTITUDE_RULE_LINES,
    ...DEADPAN_FRAME_LINES,
    ...KOREAN_SURFACE_LINES,
    "",
    "=== STRUCTURE SKELETON (illustrates rhythm and anchor count only, NOT voice) ===",
    "",
    "Opening beat: one concrete anchor stated plainly (1-2 lines).",
    "(blank line)",
    "Turn: a reaction, consequence, or observation building on that anchor (1-3 lines).",
    "(optional blank line, optional second beat)",
    "Landing line: a short closing thought (1 line).",
    "",
    "2 to 5 hashtags at the end.",
    "",
    "This skeleton shows line rhythm and anchor count ONLY. The actual voice, tone, humor, and emotional register must come from the persona voice lines above and today's mood guidance — never from any fixed example wording.",
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
    "Do not leave raw jargon or untranslated English noun phrases such as PR numbers, version tags, module/file names, or internal screen names in the caption — translate each into what it meant for a person instead.",
    "Do not print internal identifiers — ticket keys, screen, module, class, or file names.",
    "Do not explain the joke or signal that a line is meant to be funny.",
    "Do not expose secrets, local paths, credentials, code snippets, private URLs, or emails.",
    "Do not imply the draft was automatically posted or exported.",
    "Each hashtag must start with # and contain no spaces."
  ].join("\n");
}

function buildSafeCaptionInput(options: {
  activitySummary: ActivitySummary;
  persona: Persona;
  moodPlan: MoodPlan;
  roastLevel: number;
  rawNarrativeProjection?: RawNarrativeProjection;
}): SafeActivitySummary {
  const summary = options.activitySummary;
  const quiet = summary.activityLevel === "none";
  const { identity } = options.persona;

  const safeInput: SafeActivitySummary = {
    schemaVersion: 1,
    targetDate: summary.targetDate,
    quiet,
    overview: `${summary.activityLevel} day. Persona: ${identity.name} (${identity.relationship}). ${identity.backstory} Roast level: ${options.roastLevel}.`,
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
    },
    moodPlan: {
      mood: options.moodPlan.mood,
      angle: options.moodPlan.angle,
      captionStyle: options.moodPlan.captionStyle,
      doNotMention: options.moodPlan.doNotMention
    }
  };

  // Tier 2 raw-narrative projection: concrete, already-safety-filtered anchors
  // for days where the raw archive holds the only specific detail. The caption
  // writer needs this just as much as the story writer (UNC-156 review).
  if (options.rawNarrativeProjection !== undefined) {
    safeInput.rawNarrativeProjection = toJsonValue(
      options.rawNarrativeProjection
    );
  }

  return safeInput;
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
      quiet: options.activitySummary.activityLevel === "none",
      persona: options.persona,
      moodPlan: options.moodPlan
    }),
    summary: buildSafeCaptionInput({
      activitySummary: options.activitySummary,
      persona: options.persona,
      moodPlan: options.moodPlan,
      roastLevel: options.roastLevel,
      rawNarrativeProjection: options.rawNarrativeProjection
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
  storyFormatPlan: MoodPlan;
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
      mood: options.storyFormatPlan.mood,
      angle: options.storyFormatPlan.angle,
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
    isMood(value.mood) &&
    typeof value.angle === "string" &&
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

/**
 * 영어 표면에 남은 작업 주장. 개수는 1 이상만 주장으로 본다 — "0 commits"는
 * 활동이 실제로 0인 날의 정확한 서술이지 조작이 아니다.
 */
const englishWorkClaimPattern =
  /\b(?:[1-9]\d*\s+commits?|fixed|implemented|shipped|built|released|merged|debugged)\b/i;

/**
 * 작업 완료를 단언하는 한자어 동작명사 (UNC-251). 아래 어미와 결합해
 * 능동("배포했다")·피동("배포됐다")·문어체("배포하였다")를 한 번에 덮으므로,
 * 개별 활용형을 일일이 나열하지 않아도 흔한 작업 주장이 걸린다.
 *
 * 조용한 날에도 정직하게 쓸 수 있는 동사(정리하다, 확인하다, 생각하다 등)는
 * 일부러 넣지 않았다 — 이 가드는 실패 시 생성을 중단시키므로 오탐 비용이 크다.
 */
const koreanWorkClaimNouns = [
  "추가",
  "작성",
  "수정",
  "구현",
  "배포",
  "출시",
  "해결",
  "처리",
  "완료",
  "완성",
  "개선",
  "삭제",
  "제거",
  "도입",
  "적용",
  "반영",
  "테스트",
  "디버깅",
  "리팩터링",
  "리팩토링",
  "머지",
  "병합",
  "커밋",
  "푸시",
  "릴리스",
  "마이그레이션",
  "검증"
] as const;

/** 목적어 없이도 작업 주장이 되는 고유어 완료형. */
const koreanNativeWorkClaimStems = ["고쳐졌", "고쳤"] as const;

/**
 * 목적어가 뜻을 가르는 고유어 완료형. "하루를 마쳤습니다"는 조용한 날
 * 프롬프트가 오히려 권하는 정직한 마무리이고, "작업을 마쳤습니다"만 주장이다.
 * 그래서 이 어간들은 바로 앞에 작업 목적어가 있을 때만 주장으로 본다.
 */
const koreanObjectBoundClaimStems = [
  "만들어졌",
  "만들었",
  "올렸",
  "남겼",
  "끝냈",
  "마쳤",
  "짰"
] as const;

/** 위 어간이 주장이 되려면 앞에 와야 하는 작업 목적어. */
const koreanWorkObjects = [
  "버그",
  "기능",
  "코드",
  "테스트",
  "이슈",
  "티켓",
  "커밋",
  "PR",
  "브랜치",
  "작업",
  "스크립트",
  "함수",
  "모듈",
  "타입",
  "로직",
  "문서",
  "화면",
  "페이지",
  "컴포넌트",
  "API",
  "쿼리",
  "설정",
  "파일"
] as const;

const koreanCountWord = "\\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열";

/**
 * 조용한 날 한국어 작업 주장 (UNC-251). `KOREAN_SURFACE_LINES`가 독자용
 * 표면을 한국어로 강제하므로, 영어 동사만 보는 탐지기로는 "버그를 고쳤습니다"
 * 같은 조작이 그대로 통과한다. 한글에는 `\b` 단어 경계가 잡히지 않아 어간과
 * 어미 결합으로 범위를 잡는다.
 */
/** 커밋 개수 표현. 위 목적어들과 같은 자리에 서서 완료 동사를 이끈다. */
const koreanCommitCountObjects = [
  `커밋(?:을|를|이|가)?\\s*(?:${koreanCountWord})\\s*개`,
  `(?:${koreanCountWord})\\s*개의?\\s*커밋`
];

/**
 * 개수 목적어에만 붙는 완료형. "커밋 세 개를 했습니다"는 주장이지만, 일반
 * 목적어까지 `했`를 허용하면 "코드 구경만 했습니다" 같은 정직한 줄이 걸린다.
 */
const koreanCountBoundClaimStems = [...koreanObjectBoundClaimStems, "했"];

/** 한자어 동작명사에 붙어 완료를 단언하는 어미. */
const koreanSinoClaimEndings = ["했", "됐", "되었", "하였"] as const;

/**
 * 완료 어간 뒤에 붙으면 **오늘의 주장이 아니라 지난 일의 회상**이 되는 관형형
 * 어미. "지난주에 완료했던 기능이 떠올랐습니다"는 조용한 날 프롬프트가 오히려
 * 권하는 정직한 문장이므로, 어간 직후에 이 어미가 오면 주장으로 세지 않는다.
 */
const koreanRecalledClaimSuffix = "(?!(?:었)?던)";

const koreanWorkClaimPattern = new RegExp(
  [
    `(?:${koreanWorkClaimNouns.join("|")})(?:${koreanSinoClaimEndings.join("|")})${koreanRecalledClaimSuffix}`,
    `(?:${koreanNativeWorkClaimStems.join("|")})${koreanRecalledClaimSuffix}`,
    `(?:${koreanWorkObjects.join("|")})[^.!?\\n]{0,6}?(?:${koreanObjectBoundClaimStems.join("|")})${koreanRecalledClaimSuffix}`,
    `(?:${koreanCommitCountObjects.join("|")})[^.!?\\n]{0,6}?(?:${koreanCountBoundClaimStems.join("|")})${koreanRecalledClaimSuffix}`
  ].join("|"),
  "g"
);

/**
 * 모든 완료 어간. 어느 분기로 걸리든 매칭은 반드시 이 중 하나로 끝나므로,
 * 어간 위치를 접미사로 되찾을 수 있다.
 */
const koreanClaimStems = [
  ...koreanSinoClaimEndings,
  ...koreanNativeWorkClaimStems,
  ...koreanCountBoundClaimStems
];

/**
 * 부정을 예외로 인정하는 유일한 뒤쪽 형태: **주장을 인용해 곧바로 부인하는**
 * 구문. "고쳤다고 할 것도 없었습니다", "고쳤을 리가 없습니다"가 그것이다.
 *
 * 연결어미(지만·으며·기에·으므로·-고…)를 열거해 절을 자르는 방식은 끝이
 * 없어서 버렸다. 대신 예외 쪽을 좁혔다 — 뒤 절이 **다른** 일을 부정해도
 * ("기능을 추가했기에 테스트까지는 못했습니다") 앞의 주장은 그대로 남는다.
 *
 * 인용 표지와 부정 사이에 또 다른 완료형(했/였/았/었)이 끼면 부인이 아니다.
 * "추가했다고 기록했지만 테스트는 못했습니다"는 인용된 주장을 오히려 단언한
 * 뒤 다른 일을 부정하므로, 부정이 주장을 지배하지 않는다.
 */
const koreanQuotedDenialPattern =
  /^(?:다고|다곤|다는|단\s|을\s*리|ㄹ\s*리|을\s*것도)[^.!?\n했였았었]*?(?:없|않|못|아니)/;

/**
 * 동사 **바로 앞**에 서는 부정 부사. "오늘은 코드를 안 만들었습니다",
 * "버그는 못 고쳤습니다"는 작업이 없었음을 말하는 정직한 문장이다.
 *
 * 어간에 직접 붙을 때만 센다. "코드 안 보고 짰습니다"의 `안`은 앞 동사(보고)를
 * 부정할 뿐 `짰`을 부정하지 않으므로 주장 그대로 남는다.
 */
const koreanPreVerbalNegationPattern = /(?:^|\s)(?:안|못)\s*$/;

/**
 * 0으로 센 수량. "커밋 0개를 남겼습니다"는 활동이 실제로 0인 날의 정확한
 * 서술이지 조작이 아니다. 개수 분기든 일반 목적어 분기든 매칭 안에 0 수량이
 * 있으면 주장으로 세지 않는다 — 영어 쪽 `0 commits`를 빼는 것과 같은 이유다.
 */
const koreanZeroQuantityPattern = /(?:^|\D)0+\s*(?:개|건|줄|번|회)/;

/**
 * 매칭 구간에서 완료 어간이 시작하는 위치. 어간은 언제나 매칭의 접미사이므로,
 * 가장 긴 어간 접미사를 찾아 되짚는다. 공백을 기준으로 잡으면 "커밋 세 개를
 * 안했습니다"처럼 부정 부사가 어간에 붙어 쓰인 문장에서 어간보다 앞을 가리켜,
 * 바로 앞 부정을 놓친다.
 */
function stemStartIndex(match: RegExpExecArray): number {
  const stem = koreanClaimStems.reduce(
    (longest, candidate) =>
      match[0].endsWith(candidate) && candidate.length > longest.length
        ? candidate
        : longest,
    ""
  );

  return match.index + match[0].length - stem.length;
}

/** 이 매칭이 실제 작업 주장인지 — 어간을 지배하는 부정이 없는지 본다. */
function isUndeniedClaim(sentence: string, match: RegExpExecArray): boolean {
  if (koreanZeroQuantityPattern.test(match[0])) {
    return false;
  }

  const stemStart = stemStartIndex(match);
  const leadIn = sentence.slice(Math.max(0, stemStart - 4), stemStart);

  if (koreanPreVerbalNegationPattern.test(leadIn)) {
    return false;
  }

  return !koreanQuotedDenialPattern.test(
    sentence.slice(match.index + match[0].length)
  );
}

function claimsQuietDayWork(text: string): boolean {
  if (englishWorkClaimPattern.test(text)) {
    return true;
  }

  return text
    .split(/[.!?\n]+/)
    .some((sentence) =>
      [...sentence.matchAll(koreanWorkClaimPattern)].some((match) =>
        isUndeniedClaim(sentence, match)
      )
    );
}

function assertQuietDayHonesty(
  draft: DiaryDraft,
  summary: ActivitySummary
): void {
  if (summary.activityLevel !== "none") {
    return;
  }

  if (claimsQuietDayWork(collectDraftText(draft).join("\n"))) {
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

  if (claimsQuietDayWork(caption)) {
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
    emailPattern("i").test(value) ||
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
