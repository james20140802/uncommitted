import {
  classifyThemes,
  deriveSynthesisFromSignals,
  sortThemes,
  type ActivitySynthesis
} from "./activity-synthesis.js";

export type { ActivitySynthesis };
// Preserve the pre-refactor deep-import path: `deriveSynthesisFromSignals` was a
// public export of this module before its move to ./activity-synthesis.js.
export { deriveSynthesisFromSignals };
import type { GitActivityEvent } from "./collect-git-command.js";
import type { ActivitySignal } from "./event-source.js";
import type { DirtyFileStatus, DirtyStatusTotals } from "./git-activity-collector.js";
import { recencyDecay, THREAD_TOP_K, type MemoryThread } from "./memory-store.js";
import type { ManualNoteEvent } from "./note-command.js";
import {
  categorizeRedactedSubject,
  REDACTION_CATEGORY_ORDER,
  sanitizeText
} from "./redaction.js";

export type ActivityLevel = "none" | "low" | "medium" | "high";

export type ActivityTheme =
  | "coding"
  | "debugging"
  | "mixed"
  | "planning"
  | "quiet"
  | "refactoring";

export type ActivitySummaryInput = {
  targetDate: string;
  generatedAt: string;
  gitEvents: GitActivityEvent[];
  manualNotes: ManualNoteEvent[];
  // Already-redacted Claude session signals (from `uncommitted collect claude`).
  // Optional and source-agnostic: they feed the synthesis stream and the
  // activity score so the diary reflects Claude work, not just Git + notes.
  claudeSignals?: ActivitySignal[];
  // Already-redacted Codex session signals (from `uncommitted collect codex`).
  // Treated identically to Claude signals so a Codex-only day isn't quiet.
  codexSignals?: ActivitySignal[];
  // Already-redacted GitHub activity signals (from `uncommitted collect github`).
  // Treated identically to session signals so a day of merged PRs / closed
  // issues / reviews isn't quiet.
  githubSignals?: ActivitySignal[];
  // Cross-day recurring threads (bug/refactor/running-joke/blocker/win/other)
  // reflected by `reflectProjectThreads` (see reflection.ts). Optional and
  // additive: when present, the top `THREAD_TOP_K` active threads (ranked by
  // `recencyDecay` against `generatedAt`) are injected into the existing
  // `unfinishedThreads`/`possibleJokes` slots alongside the single-day content.
  memoryThreads?: MemoryThread[];
  // Durable, always-present persona facts (e.g. "prefers TDD") read from
  // `persona.json` via `readCoreFacts`. When present, prepended to
  // `unfinishedThreads` ahead of everything else.
  coreFacts?: string[];
};

export type ActivityProjectSummary = {
  projectId: string;
  projectName: string;
  repositoryName?: string;
  commitCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  uncommittedChangeCount: number;
  manualNoteCount: number;
  themes: Exclude<ActivityTheme, "mixed" | "quiet">[];
  summary: string;
};

export type CommitSignals = {
  totalCommits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  subjects: string[];
  themes: Exclude<ActivityTheme, "mixed" | "quiet">[];
};

export type UncommittedChangeSummary = {
  totalFiles: number;
  byStatus: DirtyStatusTotals;
  files: {
    projectId: string;
    projectName: string;
    path: string;
    status: DirtyFileStatus;
  }[];
};

export type ManualContextSummary = {
  noteCount: number;
  notes: {
    projectId: string;
    timestamp: string;
    text: string;
  }[];
};

/**
 * UNC-229 / T3: 반복 중인 스레드의 **누적 사실**만 담는다. 표현 계약은
 * "누적 N번 + 최근 등장일"이며 "연속 N일"은 계약에서 영구 제외다.
 */
export type RecurringThreadSummary = {
  note: string;
  occurrenceCount: number;
  lastSeenDate: string;
};

/** 이 값 이상 등장한 스레드만 "반복 중"으로 본다 (AC2 판정 기준). */
export const RECURRING_THREAD_MIN_OCCURRENCES = 2;

/** 노출 상한. 전부 노출하면 다시 태스크 나열로 돌아간다. */
export const RECURRING_THREAD_MAX = 2;

export type ActivitySummary = {
  // v1 파일도 계속 읽히므로 `2` 리터럴이 아니라 `1 | 2`다. 새로 만드는 요약은 항상 2.
  schemaVersion: 1 | 2;
  targetDate: string;
  generatedAt: string;
  activityLevel: ActivityLevel;
  dominantTheme: ActivityTheme;
  projects: ActivityProjectSummary[];
  commitSignals: CommitSignals;
  uncommittedChanges: UncommittedChangeSummary;
  manualContext: ManualContextSummary;
  smallWins: string[];
  blockersOrConfusion: string[];
  unfinishedThreads: string[];
  possibleJokes: string[];
  publicSafetyNotes: string[];
  privateItemsToAvoid: string[];
  uncertaintyNotes: string[];
  /** UNC-229 / T3: 반복 중인 top-K 부분집합 (최대 `RECURRING_THREAD_MAX`개). */
  recurringThreads?: RecurringThreadSummary[];
};

type ProjectAccumulator = {
  projectId: string;
  projectName: string;
  repositoryName?: string;
  commitCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  uncommittedChangeCount: number;
  manualNoteCount: number;
  githubSignalCount: number;
  themes: Set<Exclude<ActivityTheme, "mixed" | "quiet">>;
};

const dirtyStatuses: DirtyFileStatus[] = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "other"
];

export function buildActivitySummary(
  input: ActivitySummaryInput
): ActivitySummary {
  const gitEvents = input.gitEvents.filter(
    (event) =>
      event.targetDate === input.targetDate &&
      event.activity.targetDate === input.targetDate
  );
  const manualNotesForDate = input.manualNotes.filter(
    (note) => note.date === input.targetDate
  );
  const privateItems = new Set<string>();
  const projects = new Map<string, ProjectAccumulator>();
  const subjects: string[] = [];
  const uncommittedFiles: UncommittedChangeSummary["files"] = [];
  const uncommittedTotals = createEmptyDirtyTotals();
  const manualNotes: ManualContextSummary["notes"] = [];
  let hasManualPrivateItems = false;

  let totalCommits = 0;
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const event of gitEvents) {
    const project = getProject(projects, event.project.id, event.project.name);
    project.repositoryName = event.activity.repository.rootName;

    for (const commit of event.activity.commits) {
      const sanitizedSubject = sanitizeText(commit.subject);
      addPrivateItems(privateItems, sanitizedSubject.categories);

      totalCommits += 1;
      filesChanged += commit.stats.filesChanged;
      insertions += commit.stats.insertions;
      deletions += commit.stats.deletions;
      project.commitCount += 1;
      project.filesChanged += commit.stats.filesChanged;
      project.insertions += commit.stats.insertions;
      project.deletions += commit.stats.deletions;
      subjects.push(sanitizedSubject.value);

      for (const theme of classifyThemes(sanitizedSubject.value)) {
        project.themes.add(theme);
      }
    }

    for (const file of event.activity.dirty.files) {
      const sanitizedPath = sanitizeText(file.path);
      addPrivateItems(privateItems, sanitizedPath.categories);
      project.uncommittedChangeCount += 1;
      uncommittedTotals[file.status] += 1;
      uncommittedFiles.push({
        projectId: event.project.id,
        projectName: event.project.name,
        path: sanitizedPath.value,
        status: file.status
      });
    }
  }

  for (const note of manualNotesForDate) {
    const sanitizedNote = sanitizeText(note.text);
    addPrivateItems(privateItems, sanitizedNote.categories);
    hasManualPrivateItems ||= sanitizedNote.categories.length > 0;

    const project = getProject(projects, note.projectId, note.projectId);
    project.manualNoteCount += 1;
    manualNotes.push({
      projectId: note.projectId,
      timestamp: note.timestamp,
      text: sanitizedNote.value
    });

    for (const theme of classifyThemes(sanitizedNote.value)) {
      project.themes.add(theme);
    }
  }

  // Claude and Codex session signals arrive already redacted and normalized;
  // keep only the ones that belong to the target date (undated entries are
  // treated as current). Both sources are handled identically.
  const sessionSignals = [
    ...(input.claudeSignals ?? []),
    ...(input.codexSignals ?? []),
    ...(input.githubSignals ?? [])
  ].filter(
    (signal) =>
      signal.timestamp === "" ||
      signal.timestamp.slice(0, 10) === input.targetDate
  );

  // GitHub signals carry a registered projectId but never create a git event or
  // manual note, so a PR/review-only day would leave `projects` empty and the
  // diary would claim zero projects on an active day. Seed a project
  // accumulator per GitHub signal so PR-only days keep their project
  // attribution (name falls back to the id, as manual-note-only projects do).
  for (const signal of input.githubSignals ?? []) {
    if (signal.timestamp !== "" && signal.timestamp.slice(0, 10) !== input.targetDate) {
      continue;
    }
    getProject(projects, signal.projectId, signal.projectId).githubSignalCount += 1;
  }

  // Build a normalized signal stream from the source-shaped inputs and append
  // the session signals, then derive the 4 source-agnostic synthesis fields
  // generically. Session signals are opaque kinds, so they are pattern-classified
  // for themes / small wins / blockers / unfinished threads.
  const signals = [
    ...buildSignalsFromInput({
      targetDate: input.targetDate,
      gitEvents,
      manualNotes: manualNotesForDate
    }),
    ...sessionSignals
  ];
  const synthesis = deriveSynthesisFromSignals(signals);

  // The uncommitted-files unfinished thread is a source-shaped aggregate
  // (count + project name), so it stays sourced from the per-project
  // accumulator and is prepended to the signal-derived list (matches the
  // legacy `unshift` ordering: uncommitted entries appear first).
  const unfinishedThreads = [...synthesis.unfinishedThreads];
  for (const project of projects.values()) {
    if (project.uncommittedChangeCount === 0) {
      continue;
    }
    unfinishedThreads.unshift(
      `${project.uncommittedChangeCount} ${project.uncommittedChangeCount === 1 ? "uncommitted file remains" : "uncommitted files remain"} in ${project.projectName}.`
    );
  }

  const score =
    totalCommits * 2 +
    filesChanged +
    uncommittedFiles.length +
    manualNotes.length * 2 +
    sessionSignals.length;
  const activityLevel = classifyActivityLevel(score);
  const dominantTheme = deriveDominantTheme(activityLevel, synthesis.themes);

  // commitSignals.themes is a git-only rollup — re-classify just the
  // accumulated commit subjects (synthesis.themes mixes commit + note themes).
  const commitOnlyThemeSet = new Set<Exclude<ActivityTheme, "mixed" | "quiet">>();
  for (const subject of subjects) {
    for (const theme of classifyThemes(subject)) {
      commitOnlyThemeSet.add(theme);
    }
  }

  const uncertaintyNotes = buildUncertaintyNotes(input, {
    gitEventCount: gitEvents.length,
    totalCommits,
    manualNoteCount: manualNotes.length,
    themeCount: synthesis.themes.length,
    uncommittedChangeCount: uncommittedFiles.length,
    sessionSignalCount: sessionSignals.length
  });
  const publicSafetyNotes = buildPublicSafetyNotes({
    hasManualPrivateItems,
    hasUncommittedChanges: uncommittedFiles.length > 0
  });

  const { unfinishedThreadNotes, jokeNotes, recurringThreads } = selectTopMemoryThreads(
    input.memoryThreads,
    new Date(input.generatedAt)
  );
  const possibleJokes = [
    ...buildPossibleJokes(activityLevel, {
      hasBlockers: synthesis.blockersOrConfusion.length > 0,
      hasUncommittedChanges: uncommittedFiles.length > 0
    }),
    ...jokeNotes
  ];
  const unfinishedThreadsWithMemory = [
    ...(input.coreFacts ?? []),
    ...unfinishedThreads,
    ...unfinishedThreadNotes
  ];

  return {
    schemaVersion: 2,
    targetDate: input.targetDate,
    generatedAt: input.generatedAt,
    activityLevel,
    dominantTheme,
    projects: Array.from(projects.values(), toProjectSummary),
    commitSignals: {
      totalCommits,
      filesChanged,
      insertions,
      deletions,
      subjects,
      themes: sortThemes(commitOnlyThemeSet)
    },
    uncommittedChanges: {
      totalFiles: uncommittedFiles.length,
      byStatus: uncommittedTotals,
      files: uncommittedFiles
    },
    manualContext: {
      noteCount: manualNotes.length,
      notes: manualNotes
    },
    smallWins: synthesis.smallWins,
    blockersOrConfusion: synthesis.blockersOrConfusion,
    unfinishedThreads: unfinishedThreadsWithMemory,
    possibleJokes,
    publicSafetyNotes,
    privateItemsToAvoid: sortPrivateItems(privateItems),
    uncertaintyNotes,
    recurringThreads
  };
}

/**
 * Normalize source-shaped inputs (git events + manual notes) into the
 * ActivitySignal stream consumed by deriveSynthesisFromSignals. Commit
 * signals are built with the same shared redaction path as
 * collectGitActivitySignals, so the two git producers stay equivalent.
 */
export function buildSignalsFromInput(input: {
  targetDate: string;
  gitEvents: GitActivityEvent[];
  manualNotes: ManualNoteEvent[];
}): ActivitySignal[] {
  const signals: ActivitySignal[] = [];
  const dirtyTimestamp = `${input.targetDate}T00:00:00.000Z`;

  for (const event of input.gitEvents) {
    for (const commit of event.activity.commits) {
      // commit.subject already went through collectGitActivity's 3-rule
      // redaction; recover those categories from markers and strip any raw
      // code the collector left intact. Mirrors collectGitActivitySignals so
      // both producers emit identical commit signals.
      const sanitized = categorizeRedactedSubject(commit.subject);
      signals.push({
        projectId: event.project.id,
        timestamp: commit.authoredAt,
        kind: "commit",
        summary: sanitized.value,
        safetyNotes: sanitized.categories
      });
    }

    for (const file of event.activity.dirty.files) {
      const sanitized = sanitizeText(file.path);
      signals.push({
        projectId: event.project.id,
        timestamp: dirtyTimestamp,
        kind: "dirty-file",
        summary: `${file.status}: ${sanitized.value}`,
        safetyNotes: sanitized.categories
      });
    }
  }

  for (const note of input.manualNotes) {
    const sanitized = sanitizeText(note.text);
    signals.push({
      projectId: note.projectId,
      timestamp: note.timestamp,
      kind: "note",
      summary: sanitized.value,
      safetyNotes: sanitized.categories
    });
  }

  return signals;
}

export function isActivitySummary(value: unknown): value is ActivitySummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    // v1 파일 읽기 경로를 살려 둔다 — 저장된 드래프트를 재생성 대상으로 만들지 않는다.
    (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    typeof value.targetDate === "string" &&
    typeof value.generatedAt === "string" &&
    isActivityLevel(value.activityLevel) &&
    isActivityTheme(value.dominantTheme) &&
    Array.isArray(value.projects) &&
    isRecord(value.commitSignals) &&
    isRecord(value.uncommittedChanges) &&
    isRecord(value.manualContext) &&
    Array.isArray(value.smallWins) &&
    Array.isArray(value.blockersOrConfusion) &&
    Array.isArray(value.unfinishedThreads) &&
    Array.isArray(value.possibleJokes) &&
    Array.isArray(value.publicSafetyNotes) &&
    Array.isArray(value.privateItemsToAvoid) &&
    Array.isArray(value.uncertaintyNotes) &&
    (value.recurringThreads === undefined || Array.isArray(value.recurringThreads))
  );
}

function getProject(
  projects: Map<string, ProjectAccumulator>,
  projectId: string,
  projectName: string
): ProjectAccumulator {
  const existingProject = projects.get(projectId);

  if (existingProject) {
    if (existingProject.projectName === projectId && projectName !== projectId) {
      existingProject.projectName = projectName;
    }

    return existingProject;
  }

  const project: ProjectAccumulator = {
    projectId,
    projectName,
    commitCount: 0,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    uncommittedChangeCount: 0,
    manualNoteCount: 0,
    githubSignalCount: 0,
    themes: new Set()
  };

  projects.set(projectId, project);
  return project;
}

function toProjectSummary(project: ProjectAccumulator): ActivityProjectSummary {
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    repositoryName: project.repositoryName,
    commitCount: project.commitCount,
    filesChanged: project.filesChanged,
    insertions: project.insertions,
    deletions: project.deletions,
    uncommittedChangeCount: project.uncommittedChangeCount,
    manualNoteCount: project.manualNoteCount,
    themes: sortThemes(project.themes),
    summary: summarizeProject(project)
  };
}

function summarizeProject(project: ProjectAccumulator): string {
  const parts: string[] = [];

  if (project.commitCount > 0) {
    parts.push(`${project.commitCount} ${project.commitCount === 1 ? "commit" : "commits"}`);
  }

  if (project.manualNoteCount > 0) {
    parts.push(`${project.manualNoteCount} manual ${project.manualNoteCount === 1 ? "note" : "notes"}`);
  }

  if (project.uncommittedChangeCount > 0) {
    parts.push(`${project.uncommittedChangeCount} uncommitted ${project.uncommittedChangeCount === 1 ? "file" : "files"}`);
  }

  if (project.githubSignalCount > 0) {
    parts.push(`${project.githubSignalCount} GitHub ${project.githubSignalCount === 1 ? "event" : "events"}`);
  }

  return parts.length > 0 ? parts.join(", ") : "No activity signals.";
}

function classifyActivityLevel(score: number): ActivityLevel {
  if (score === 0) {
    return "none";
  }

  if (score <= 4) {
    return "low";
  }

  if (score <= 11) {
    return "medium";
  }

  return "high";
}

function deriveDominantTheme(
  activityLevel: ActivityLevel,
  themes: Exclude<ActivityTheme, "mixed" | "quiet">[]
): ActivityTheme {
  if (activityLevel === "none") {
    return "quiet";
  }

  return themes.length === 1 ? themes[0] : "mixed";
}

function buildUncertaintyNotes(
  input: ActivitySummaryInput,
  signals: {
    gitEventCount: number;
    totalCommits: number;
    manualNoteCount: number;
    themeCount: number;
    uncommittedChangeCount: number;
    sessionSignalCount: number;
  }
): string[] {
  const notes: string[] = [];

  if (
    signals.gitEventCount === 0 &&
    signals.manualNoteCount === 0 &&
    signals.uncommittedChangeCount === 0 &&
    signals.sessionSignalCount === 0
  ) {
    notes.push(`No Git activity or manual notes were found for ${input.targetDate}.`);
  }

  if (signals.gitEventCount === 0 && signals.manualNoteCount > 0) {
    notes.push("Git activity was not provided; summary relies on manual notes.");
  }

  if (
    signals.themeCount === 0 &&
    (signals.totalCommits > 0 || signals.manualNoteCount > 0)
  ) {
    notes.push("Activity existed, but theme signals were insufficient.");
  }

  if (signals.uncommittedChangeCount > 0) {
    notes.push("Uncommitted changes show file status only, not intent.");
  }

  return notes;
}

/**
 * Select the top `THREAD_TOP_K` active memory threads ranked by
 * `recencyDecay(thread, now)` descending, then split their notes by kind:
 * `running-joke`/`win` go to the joke slot, everything else goes to the
 * unfinished-thread slot. Threads with `status !== "active"` are excluded
 * before ranking. The same recency-ranked scan (no re-sort) also picks out
 * up to `RECURRING_THREAD_MAX` threads with `occurrenceCount >=
 * RECURRING_THREAD_MIN_OCCURRENCES` for `recurringThreads` (UNC-229 / T3).
 */
function selectTopMemoryThreads(
  memoryThreads: MemoryThread[] | undefined,
  now: Date
): {
  unfinishedThreadNotes: string[];
  jokeNotes: string[];
  recurringThreads: RecurringThreadSummary[];
} {
  if (!memoryThreads || memoryThreads.length === 0) {
    return { unfinishedThreadNotes: [], jokeNotes: [], recurringThreads: [] };
  }

  const topThreads = memoryThreads
    .filter((thread) => thread.status === "active")
    .sort((a, b) => recencyDecay(b, now) - recencyDecay(a, now))
    .slice(0, THREAD_TOP_K);

  const unfinishedThreadNotes: string[] = [];
  const jokeNotes: string[] = [];
  // 결정 ④ 랭킹 제약: recencyDecay 정렬을 그대로 두고 앞에서부터 훑는다.
  // occurrenceCount로 재정렬하면 top-K 밖 스레드가 recurringThreads에만 등장해
  // "평탄화 슬롯에 없는 새 소재"가 되어 중복 금지 지시문이 무력화된다.
  const recurringThreads: RecurringThreadSummary[] = [];

  for (const thread of topThreads) {
    if (thread.kind === "running-joke" || thread.kind === "win") {
      jokeNotes.push(thread.note);
    } else {
      unfinishedThreadNotes.push(thread.note);
    }

    const occurrenceCount = thread.occurrenceCount ?? 1;

    if (
      recurringThreads.length < RECURRING_THREAD_MAX &&
      occurrenceCount >= RECURRING_THREAD_MIN_OCCURRENCES
    ) {
      recurringThreads.push({
        // note는 unfinishedThreadNotes/jokeNotes와 같은 출처다 —
        // 기존 memory-safety-gate 처리를 그대로 물려받는다.
        note: thread.note,
        occurrenceCount,
        lastSeenDate: thread.lastSeen.slice(0, 10)
      });
    }
  }

  return { unfinishedThreadNotes, jokeNotes, recurringThreads };
}

function buildPossibleJokes(
  activityLevel: ActivityLevel,
  options: {
    hasBlockers: boolean;
    hasUncommittedChanges: boolean;
  }
): string[] {
  if (activityLevel === "none") {
    return ["Quiet day, but the draft still has to admit nothing exploded."];
  }

  const jokes: string[] = [];

  if (options.hasUncommittedChanges) {
    jokes.push("The working tree kept a few tabs open for tomorrow.");
  }

  if (options.hasBlockers) {
    jokes.push("The day left a breadcrumb trail of blockers instead of a victory lap.");
  }

  return jokes;
}

function buildPublicSafetyNotes(options: {
  hasManualPrivateItems: boolean;
  hasUncommittedChanges: boolean;
}): string[] {
  const notes = ["Summary excludes raw diffs and raw code."];

  if (options.hasManualPrivateItems) {
    notes.push("Manual notes were sanitized for private details.");
  }

  if (options.hasUncommittedChanges) {
    notes.push("Review uncommitted file names before sharing.");
  }

  return notes;
}

function addPrivateItems(target: Set<string>, items: string[]): void {
  for (const item of items) {
    target.add(item);
  }
}

function sortPrivateItems(items: Set<string>): string[] {
  return REDACTION_CATEGORY_ORDER.filter((item) => items.has(item));
}

function createEmptyDirtyTotals(): DirtyStatusTotals {
  return Object.fromEntries(
    dirtyStatuses.map((status) => [status, 0])
  ) as DirtyStatusTotals;
}

function isActivityLevel(value: unknown): value is ActivityLevel {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function isActivityTheme(value: unknown): value is ActivityTheme {
  return (
    value === "coding" ||
    value === "debugging" ||
    value === "mixed" ||
    value === "planning" ||
    value === "quiet" ||
    value === "refactoring"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
