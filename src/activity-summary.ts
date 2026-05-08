import type { GitActivityEvent } from "./collect-git-command.js";
import type { DirtyFileStatus, DirtyStatusTotals } from "./git-activity-collector.js";
import type { ManualNoteEvent } from "./note-command.js";

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

export type ActivitySummary = {
  schemaVersion: 1;
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
};

type SanitizedText = {
  value: string;
  privateItems: string[];
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

const privateItemOrder = [
  "emails",
  "local absolute paths",
  "private URLs",
  "raw code snippets"
];

export function buildActivitySummary(
  input: ActivitySummaryInput
): ActivitySummary {
  const privateItems = new Set<string>();
  const projects = new Map<string, ProjectAccumulator>();
  const subjects: string[] = [];
  const commitThemes = new Set<Exclude<ActivityTheme, "mixed" | "quiet">>();
  const uncommittedFiles: UncommittedChangeSummary["files"] = [];
  const uncommittedTotals = createEmptyDirtyTotals();
  const manualNotes: ManualContextSummary["notes"] = [];
  const manualThemes = new Set<Exclude<ActivityTheme, "mixed" | "quiet">>();
  const smallWins: string[] = [];
  const blockersOrConfusion: string[] = [];
  const unfinishedThreads: string[] = [];
  let hasManualPrivateItems = false;

  let totalCommits = 0;
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const event of input.gitEvents) {
    const project = getProject(projects, event.project.id, event.project.name);
    project.repositoryName = event.activity.repository.rootName;

    for (const commit of event.activity.commits) {
      const sanitizedSubject = sanitizeText(commit.subject);
      addPrivateItems(privateItems, sanitizedSubject.privateItems);

      totalCommits += 1;
      filesChanged += commit.stats.filesChanged;
      insertions += commit.stats.insertions;
      deletions += commit.stats.deletions;
      project.commitCount += 1;
      project.filesChanged += commit.stats.filesChanged;
      project.insertions += commit.stats.insertions;
      project.deletions += commit.stats.deletions;
      subjects.push(sanitizedSubject.value);
      smallWins.push(sanitizedSubject.value);

      for (const theme of classifyThemes(sanitizedSubject.value)) {
        commitThemes.add(theme);
        project.themes.add(theme);
      }
    }

    for (const file of event.activity.dirty.files) {
      const sanitizedPath = sanitizeText(file.path);
      addPrivateItems(privateItems, sanitizedPath.privateItems);
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

  for (const note of input.manualNotes.filter((note) => note.date === input.targetDate)) {
    const sanitizedNote = sanitizeText(note.text);
    addPrivateItems(privateItems, sanitizedNote.privateItems);
    hasManualPrivateItems ||= sanitizedNote.privateItems.length > 0;

    const project = getProject(projects, note.projectId, note.projectId);
    project.manualNoteCount += 1;
    manualNotes.push({
      projectId: note.projectId,
      timestamp: note.timestamp,
      text: sanitizedNote.value
    });

    const noteThemes = classifyThemes(sanitizedNote.value);
    for (const theme of noteThemes) {
      manualThemes.add(theme);
      project.themes.add(theme);
    }

    if (looksLikeSmallWin(sanitizedNote.value)) {
      smallWins.push(sanitizedNote.value);
    }

    if (looksLikeBlocker(sanitizedNote.value)) {
      blockersOrConfusion.push(sanitizedNote.value);
    }

    if (looksUnfinished(sanitizedNote.value)) {
      unfinishedThreads.push(sanitizedNote.value);
    }
  }

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
    manualNotes.length * 2;
  const activityLevel = classifyActivityLevel(score);
  const allThemes = sortThemes(new Set([...commitThemes, ...manualThemes]));
  const dominantTheme = deriveDominantTheme(activityLevel, allThemes);
  const uncertaintyNotes = buildUncertaintyNotes(input, {
    gitEventCount: input.gitEvents.length,
    totalCommits,
    manualNoteCount: manualNotes.length,
    themeCount: allThemes.length,
    uncommittedChangeCount: uncommittedFiles.length
  });
  const publicSafetyNotes = buildPublicSafetyNotes({
    hasManualPrivateItems,
    hasUncommittedChanges: uncommittedFiles.length > 0
  });

  return {
    schemaVersion: 1,
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
      themes: sortThemes(commitThemes)
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
    smallWins,
    blockersOrConfusion,
    unfinishedThreads,
    possibleJokes: buildPossibleJokes(activityLevel, {
      hasBlockers: blockersOrConfusion.length > 0,
      hasUncommittedChanges: uncommittedFiles.length > 0
    }),
    publicSafetyNotes,
    privateItemsToAvoid: sortPrivateItems(privateItems),
    uncertaintyNotes
  };
}

export function isActivitySummary(value: unknown): value is ActivitySummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === 1 &&
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
    Array.isArray(value.uncertaintyNotes)
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

function classifyThemes(text: string): Exclude<ActivityTheme, "mixed" | "quiet">[] {
  const lowerText = text.toLowerCase();
  const themes = new Set<Exclude<ActivityTheme, "mixed" | "quiet">>();

  if (/\b(refactor|cleanup|rename|restructure|simplify)\b/.test(lowerText)) {
    themes.add("refactoring");
  }

  if (/\b(plan|planned|planning|spec|design|milestone|todo|roadmap)\b/.test(lowerText)) {
    themes.add("planning");
  }

  if (/\b(blocked|bug|debug|error|exception|fail|failed|failing|fix|fixed|flaky|unclear)\b/.test(lowerText)) {
    themes.add("debugging");
  }

  if (/\b(add|build|command|feature|implement|implemented|test|update)\b/.test(lowerText)) {
    themes.add("coding");
  }

  return sortThemes(themes);
}

function looksLikeSmallWin(text: string): boolean {
  return /\b(add|built|fixed|implement|implemented|shipped|solved)\b/i.test(text);
}

function looksLikeBlocker(text: string): boolean {
  return /\b(blocked|confused|confusion|failed|failing|stuck|unclear)\b/i.test(text);
}

function looksUnfinished(text: string): boolean {
  return /\b(follow-up|later|todo|tomorrow|unfinished|wip)\b/i.test(text);
}

function buildUncertaintyNotes(
  input: ActivitySummaryInput,
  signals: {
    gitEventCount: number;
    totalCommits: number;
    manualNoteCount: number;
    themeCount: number;
    uncommittedChangeCount: number;
  }
): string[] {
  const notes: string[] = [];

  if (
    signals.gitEventCount === 0 &&
    signals.manualNoteCount === 0 &&
    signals.uncommittedChangeCount === 0
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

function sanitizeText(value: string): SanitizedText {
  const privateItems = new Set<string>();
  let sanitized = value;

  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(sanitized)) {
    privateItems.add("emails");
    sanitized = sanitized.replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      "[redacted-email]"
    );
  }

  if (/(^|[\s(["'])\/[^\s)"']+/.test(sanitized)) {
    privateItems.add("local absolute paths");
    sanitized = sanitized.replace(
      /(^|[\s(["'])\/[^\s)"']+/g,
      "$1[redacted-path]"
    );
  }

  if (/\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/.test(sanitized)) {
    privateItems.add("private URLs");
    sanitized = sanitized.replace(
      /\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/g,
      "[redacted-url]"
    );
  }

  if (/`[^`]+`/.test(sanitized)) {
    privateItems.add("raw code snippets");
    sanitized = sanitized.replace(/`[^`]+`/g, "[redacted-code]");
  }

  if (/\bdiff --git\b/.test(sanitized)) {
    privateItems.add("raw code snippets");
    sanitized = sanitized.replace(/\bdiff --git\b[^\n]*/g, "[redacted-code]");
  }

  return {
    value: sanitized,
    privateItems: sortPrivateItems(privateItems)
  };
}

function addPrivateItems(target: Set<string>, items: string[]): void {
  for (const item of items) {
    target.add(item);
  }
}

function sortPrivateItems(items: Set<string>): string[] {
  return privateItemOrder.filter((item) => items.has(item));
}

function sortThemes(
  themes: Set<Exclude<ActivityTheme, "mixed" | "quiet">>
): Exclude<ActivityTheme, "mixed" | "quiet">[] {
  return Array.from(themes).sort((left, right) => left.localeCompare(right));
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
