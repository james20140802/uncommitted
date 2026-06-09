import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ActivitySignal, EventSource } from "./event-source.js";

const execFileAsync = promisify(execFile);

export type GitActivityCollectionErrorCode =
  | "path-not-found"
  | "not-git-repository";

export class GitActivityCollectionError extends Error {
  constructor(
    message: string,
    public readonly code: GitActivityCollectionErrorCode
  ) {
    super(message);
    this.name = "GitActivityCollectionError";
  }
}

export type GitActivityStats = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitActivityCommit = {
  hash: string;
  shortHash: string;
  authorName: string;
  authoredAt: string;
  subject: string;
  stats: GitActivityStats;
};

export type DirtyFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "other";

export type DirtyFileSummary = {
  path: string;
  status: DirtyFileStatus;
};

export type DirtyStatusTotals = Record<DirtyFileStatus, number>;

export type GitActivity = {
  schemaVersion: 1;
  targetDate: string;
  repository: {
    rootName: string;
    gitRoot?: never;
  };
  commits: GitActivityCommit[];
  totals: GitActivityStats & {
    commits: number;
  };
  dirty: {
    files: DirtyFileSummary[];
    totals: DirtyStatusTotals;
  };
};

export type CollectGitActivityOptions = {
  projectRoot: string;
  targetDate: string;
};

type ParsedCommit = GitActivityCommit;

export async function collectGitActivity(
  options: CollectGitActivityOptions
): Promise<GitActivity> {
  const gitRoot = await findGitRoot(options.projectRoot);
  const commits = await collectCommits(gitRoot, options.targetDate);
  const dirty = await collectDirtyStatus(gitRoot);
  const totals = commits.reduce(
    (accumulator, commit) => ({
      commits: accumulator.commits + 1,
      filesChanged: accumulator.filesChanged + commit.stats.filesChanged,
      insertions: accumulator.insertions + commit.stats.insertions,
      deletions: accumulator.deletions + commit.stats.deletions
    }),
    { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 }
  );

  return {
    schemaVersion: 1,
    targetDate: options.targetDate,
    repository: {
      rootName: basename(gitRoot)
    },
    commits,
    totals,
    dirty
  };
}

async function findGitRoot(path: string): Promise<string> {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new GitActivityCollectionError(
      "Path does not exist.",
      "path-not-found"
    );
  }

  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "rev-parse",
      "--show-toplevel"
    ]);

    return await realpath(stdout.trim());
  } catch {
    throw new GitActivityCollectionError(
      "Not a Git repository.",
      "not-git-repository"
    );
  }
}

async function collectCommits(
  gitRoot: string,
  targetDate: string
): Promise<ParsedCommit[]> {
  const { start, end } = getDateWindow(targetDate);
  const { stdout } = await execFileAsync("git", [
    "-C",
    gitRoot,
    "log",
    `--since=${start}`,
    `--before=${end}`,
    "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s",
    "--numstat"
  ]);

  return parseGitLog(stdout);
}

function parseGitLog(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let currentCommit: ParsedCommit | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const fields = line.split("\u001f");

    if (fields.length === 5) {
      currentCommit = {
        hash: fields[0],
        shortHash: fields[1],
        authorName: redactSensitiveText(fields[2]).value,
        authoredAt: fields[3],
        subject: redactSensitiveText(fields[4]).value,
        stats: {
          filesChanged: 0,
          insertions: 0,
          deletions: 0
        }
      };
      commits.push(currentCommit);
      continue;
    }

    if (!currentCommit) {
      continue;
    }

    const [insertions, deletions] = line.split("\t");

    currentCommit.stats.filesChanged += 1;
    currentCommit.stats.insertions += parseNumstatValue(insertions);
    currentCommit.stats.deletions += parseNumstatValue(deletions);
  }

  return commits;
}

async function collectDirtyStatus(
  gitRoot: string
): Promise<GitActivity["dirty"]> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    gitRoot,
    "status",
    "--porcelain"
  ]);
  const files = stdout
    .split("\n")
    .filter(Boolean)
    .map(parseDirtyStatusLine);
  const totals = createEmptyDirtyTotals();

  for (const file of files) {
    totals[file.status] += 1;
  }

  return { files, totals };
}

function parseDirtyStatusLine(line: string): DirtyFileSummary {
  const statusCode = line.slice(0, 2);
  const rawPath = line.slice(3);
  const status = mapDirtyStatus(statusCode);
  const path = extractCurrentDirtyPath(rawPath, status);

  return {
    path,
    status
  };
}

function extractCurrentDirtyPath(rawPath: string, status: DirtyFileStatus): string {
  if (status !== "renamed" && status !== "copied") {
    return unquoteGitPath(rawPath);
  }

  const separatorIndex = findRenameSeparator(rawPath);
  const currentPath =
    separatorIndex === -1 ? rawPath : rawPath.slice(separatorIndex + " -> ".length);

  return unquoteGitPath(currentPath);
}

function findRenameSeparator(rawPath: string): number {
  let inQuote = false;
  let escaped = false;
  let separatorIndex = -1;

  for (let index = 0; index < rawPath.length; index += 1) {
    const char = rawPath[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }

    if (!inQuote && rawPath.startsWith(" -> ", index)) {
      separatorIndex = index;
    }
  }

  return separatorIndex;
}

function unquoteGitPath(path: string): string {
  if (!path.startsWith("\"") || !path.endsWith("\"")) {
    return path;
  }

  try {
    return JSON.parse(path) as string;
  } catch {
    return path;
  }
}

function mapDirtyStatus(statusCode: string): DirtyFileStatus {
  if (statusCode === "??") {
    return "untracked";
  }

  if (statusCode.includes("R")) {
    return "renamed";
  }

  if (statusCode.includes("C")) {
    return "copied";
  }

  if (statusCode.includes("A")) {
    return "added";
  }

  if (statusCode.includes("D")) {
    return "deleted";
  }

  if (statusCode.includes("M")) {
    return "modified";
  }

  return "other";
}

function createEmptyDirtyTotals(): DirtyStatusTotals {
  return {
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    untracked: 0,
    other: 0
  };
}

function parseNumstatValue(value: string | undefined): number {
  if (!value || value === "-") {
    return 0;
  }

  return Number.parseInt(value, 10);
}

function getDateWindow(targetDate: string): { start: string; end: string } {
  const startDate = new Date(`${targetDate}T00:00:00.000Z`);
  const endDate = new Date(startDate);
  endDate.setUTCDate(startDate.getUTCDate() + 1);

  return {
    start: startDate.toISOString(),
    end: endDate.toISOString()
  };
}

type RedactionCategory =
  | "emails"
  | "local absolute paths"
  | "private URLs"
  | "raw code snippets";

type RedactionResult = {
  value: string;
  categories: RedactionCategory[];
};

const REDACTION_CATEGORY_ORDER: RedactionCategory[] = [
  "emails",
  "local absolute paths",
  "private URLs",
  "raw code snippets"
];

function redactSensitiveText(value: string): RedactionResult {
  const categories = new Set<RedactionCategory>();
  let sanitized = value;

  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(sanitized)) {
    categories.add("emails");
    sanitized = sanitized.replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      "[redacted-email]"
    );
  }

  if (/\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/.test(sanitized)) {
    categories.add("private URLs");
    sanitized = sanitized.replace(
      /\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/g,
      "[redacted-url]"
    );
  }

  if (/(^|[\s(["'])\/[^\s)"']+/.test(sanitized)) {
    categories.add("local absolute paths");
    sanitized = sanitized.replace(
      /(^|[\s(["'])\/[^\s)"']+/g,
      "$1[redacted-path]"
    );
  }

  return {
    value: sanitized,
    categories: REDACTION_CATEGORY_ORDER.filter((category) => categories.has(category))
  };
}

export type CollectGitActivitySignalsOptions = {
  projectId: string;
  projectRoot: string;
  targetDate: string;
};

export async function collectGitActivitySignals(
  options: CollectGitActivitySignalsOptions
): Promise<ActivitySignal[]> {
  const activity = await collectGitActivity({
    projectRoot: options.projectRoot,
    targetDate: options.targetDate
  });

  const signals: ActivitySignal[] = [];

  for (const commit of activity.commits) {
    // commit.subject was already redacted in parseGitLog; re-run redaction
    // categorization on the SOURCE subject to surface safetyNotes accurately.
    // Since the redacted string is what we ship, derive categories from the
    // mismatch between commit.subject and the redaction markers it now
    // contains. Easier and more precise: keep the original subject around.
    // For simplicity here, we re-derive categories from the redacted subject
    // by detecting the presence of [redacted-*] markers.
    const safetyNotes = deriveSafetyNotesFromRedactedText(commit.subject);

    signals.push({
      projectId: options.projectId,
      timestamp: commit.authoredAt,
      kind: "commit",
      summary: commit.subject,
      safetyNotes
    });
  }

  const dirtyTimestamp = `${options.targetDate}T00:00:00.000Z`;

  for (const file of activity.dirty.files) {
    const { value: redactedPath, categories } = redactSensitiveText(file.path);
    signals.push({
      projectId: options.projectId,
      timestamp: dirtyTimestamp,
      kind: "dirty-file",
      summary: `${file.status}: ${redactedPath}`,
      safetyNotes: categories
    });
  }

  return signals;
}

export class GitActivityEventSource implements EventSource {
  constructor(private readonly options: CollectGitActivitySignalsOptions) {}

  collect(): Promise<ActivitySignal[]> {
    return collectGitActivitySignals(this.options);
  }
}

function deriveSafetyNotesFromRedactedText(value: string): RedactionCategory[] {
  const categories = new Set<RedactionCategory>();
  if (value.includes("[redacted-email]")) {
    categories.add("emails");
  }
  if (value.includes("[redacted-path]")) {
    categories.add("local absolute paths");
  }
  if (value.includes("[redacted-url]")) {
    categories.add("private URLs");
  }
  return REDACTION_CATEGORY_ORDER.filter((category) => categories.has(category));
}
