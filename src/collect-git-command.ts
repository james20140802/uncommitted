import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectGitActivity,
  GitActivityCollectionError,
  type GitActivity
} from "./git-activity-collector.js";
import { resolveConfigPaths } from "./config-paths.js";
import type { ProjectRecord, ProjectsFile } from "./project-registry.js";

export type CollectGitCommandErrorCode =
  | "invalid-projects-file"
  | "no-projects";

export class CollectGitCommandError extends Error {
  constructor(
    message: string,
    public readonly code: CollectGitCommandErrorCode
  ) {
    super(message);
    this.name = "CollectGitCommandError";
  }
}

export type CollectGitCommandOptions = {
  homeDir?: string;
  now?: () => string;
};

export type GitActivityEvent = {
  schemaVersion: 1;
  source: "git";
  targetDate: string;
  collectedAt: string;
  project: {
    id: string;
    name: string;
  };
  activity: GitActivity;
};

export type CollectGitSuccess = {
  projectId: string;
  outputFile: string;
  activity: GitActivity;
};

export type CollectGitFailure = {
  projectId: string;
  message: string;
};

export type CollectGitCommandResult = {
  targetDate: string;
  successes: CollectGitSuccess[];
  failures: CollectGitFailure[];
};

export async function collectGitForRegisteredProjects(
  options: CollectGitCommandOptions = {}
): Promise<CollectGitCommandResult> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const projectsFile = await readProjectsFile(paths.projectsFile);
  const projects = projectsFile.projects.filter((project) => project.enabled);
  const now = options.now ? options.now() : new Date().toISOString();
  const targetDate = now.slice(0, 10);

  if (projects.length === 0) {
    throw new CollectGitCommandError(
      "No registered projects. Run `uncommitted project add .` first.",
      "no-projects"
    );
  }

  const successes: CollectGitSuccess[] = [];
  const failures: CollectGitFailure[] = [];

  for (const project of projects) {
    try {
      const activity = await collectGitActivity({
        projectRoot: project.gitRoot,
        targetDate
      });
      const event: GitActivityEvent = {
        schemaVersion: 1,
        source: "git",
        targetDate,
        collectedAt: now,
        project: {
          id: project.id,
          name: project.name
        },
        activity
      };
      const outputFile = await writeGitActivityEvent(project, targetDate, event);

      successes.push({
        projectId: project.id,
        outputFile,
        activity
      });
    } catch (error) {
      failures.push({
        projectId: project.id,
        message: formatCollectionError(error)
      });
    }
  }

  return {
    targetDate,
    successes,
    failures
  };
}

async function writeGitActivityEvent(
  project: ProjectRecord,
  targetDate: string,
  event: GitActivityEvent
): Promise<string> {
  const outputDir = join(project.root, ".uncommitted", "events", "git");
  const outputFile = join(outputDir, `${targetDate}.json`);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(event, null, 2)}\n`, "utf8");

  return outputFile;
}

async function readProjectsFile(path: string): Promise<ProjectsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (isProjectsFile(parsed)) {
      return parsed;
    }

    throw new CollectGitCommandError(
      "Invalid projects file.",
      "invalid-projects-file"
    );
  } catch (error) {
    if (error instanceof CollectGitCommandError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      return { schemaVersion: 1, projects: [] };
    }

    throw new CollectGitCommandError(
      "Invalid projects file.",
      "invalid-projects-file"
    );
  }
}

function formatCollectionError(error: unknown): string {
  if (error instanceof GitActivityCollectionError) {
    return error.message;
  }

  return "Collection failed.";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
