import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { resolveConfigPaths } from "./config-paths.js";
import type { ProjectRecord, ProjectsFile } from "./project-add.js";

const execFileAsync = promisify(execFile);

export type NoteCommandErrorCode =
  | "empty-note"
  | "project-not-registered"
  | "invalid-projects-file"
  | "malformed-note-data";

export class NoteCommandError extends Error {
  constructor(
    message: string,
    public readonly code: NoteCommandErrorCode
  ) {
    super(message);
    this.name = "NoteCommandError";
  }
}

export type ManualNoteEvent = {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  date: string;
  projectId: string;
  text: string;
  source: "manual";
};

export type RecordManualNoteOptions = {
  cwd?: string;
  homeDir?: string;
  now?: () => string;
  createId?: () => string;
};

export type ListManualNotesOptions = {
  cwd?: string;
  homeDir?: string;
  limit?: number;
};

export type RecordManualNoteResult = {
  event: ManualNoteEvent;
  eventFile: string;
};

export type ListManualNotesResult = {
  notes: ManualNoteEvent[];
  limit: number;
};

const DEFAULT_NOTE_LIST_LIMIT = 10;

export async function recordManualNote(
  args: string[],
  options: RecordManualNoteOptions = {}
): Promise<RecordManualNoteResult> {
  const text = args.join(" ").trim();

  if (!text) {
    throw new NoteCommandError(
      'Note is empty. Pass text like: uncommitted note "fixed a bug".',
      "empty-note"
    );
  }

  const project = await resolveCurrentProject(options);
  const timestamp = options.now ? options.now() : new Date().toISOString();
  const date = timestamp.slice(0, 10);
  const event: ManualNoteEvent = {
    schemaVersion: 1,
    id: options.createId ? options.createId() : randomUUID(),
    timestamp,
    date,
    projectId: project.id,
    text,
    source: "manual"
  };
  const eventsDir = join(project.root, ".uncommitted", "events", "manual");
  const eventFile = join(eventsDir, `${date}.jsonl`);

  await mkdir(eventsDir, { recursive: true });
  await appendFile(eventFile, `${JSON.stringify(event)}\n`, "utf8");

  return { event, eventFile };
}

export async function listManualNotes(
  options: ListManualNotesOptions = {}
): Promise<ListManualNotesResult> {
  const project = await resolveCurrentProject(options);
  const limit = options.limit ?? DEFAULT_NOTE_LIST_LIMIT;
  const eventsDir = join(project.root, ".uncommitted", "events", "manual");
  const eventFiles = await readManualNoteEventFiles(eventsDir);
  const notes: ManualNoteEvent[] = [];

  for (const eventFile of eventFiles) {
    notes.push(...(await readManualNoteEvents(join(eventsDir, eventFile))));
  }

  notes.sort(compareManualNoteEventsNewestFirst);

  return {
    notes: notes.slice(0, limit),
    limit
  };
}

async function resolveCurrentProject(
  options: Pick<RecordManualNoteOptions, "cwd" | "homeDir">
): Promise<ProjectRecord> {
  const cwd = options.cwd ?? process.cwd();
  const gitRoot = await findGitRoot(cwd);
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const projectsFile = await readProjectsFile(paths.projectsFile);
  const project = projectsFile.projects.find(
    (registeredProject) => registeredProject.enabled && registeredProject.gitRoot === gitRoot
  );

  if (!project) {
    throw new NoteCommandError(
      "Run inside a registered project.",
      "project-not-registered"
    );
  }

  return project;
}

async function readManualNoteEventFiles(eventsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(eventsDir);

    return entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw new NoteCommandError(
      "Could not read manual notes.",
      "malformed-note-data"
    );
  }
}

async function readManualNoteEvents(eventFile: string): Promise<ManualNoteEvent[]> {
  let content: string;

  try {
    content = await readFile(eventFile, "utf8");
  } catch {
    throw new NoteCommandError(
      "Could not read manual notes.",
      "malformed-note-data"
    );
  }

  const notes: ManualNoteEvent[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;

      if (!isManualNoteEvent(parsed)) {
        throw new Error("Invalid manual note event.");
      }

      notes.push(parsed);
    } catch {
      throw new NoteCommandError(
        "Stored manual notes are malformed. Fix or remove the invalid note data.",
        "malformed-note-data"
      );
    }
  }

  return notes;
}

function compareManualNoteEventsNewestFirst(
  left: ManualNoteEvent,
  right: ManualNoteEvent
): number {
  const timestampOrder = right.timestamp.localeCompare(left.timestamp);

  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  return left.id.localeCompare(right.id);
}

async function findGitRoot(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "rev-parse",
      "--show-toplevel"
    ]);
    return await realpath(stdout.trim());
  } catch {
    throw new NoteCommandError(
      "Run inside a registered project.",
      "project-not-registered"
    );
  }
}

async function readProjectsFile(path: string): Promise<ProjectsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (isProjectsFile(parsed)) {
      return parsed;
    }

    throw new NoteCommandError("Invalid projects file.", "invalid-projects-file");
  } catch (error) {
    if (error instanceof NoteCommandError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      return { schemaVersion: 1, projects: [] };
    }

    throw new NoteCommandError("Invalid projects file.", "invalid-projects-file");
  }
}

function isProjectsFile(value: unknown): value is ProjectsFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.projects)) {
    return false;
  }

  return value.projects.every(isProjectRecord);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
