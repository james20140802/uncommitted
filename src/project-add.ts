import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { resolveConfigPaths } from "./config-paths.js";

const execFileAsync = promisify(execFile);

export type ProjectAddErrorCode =
  | "path-not-found"
  | "not-git-repository"
  | "invalid-projects-file"
  | "project-id-conflict";

export class ProjectAddError extends Error {
  constructor(
    message: string,
    public readonly code: ProjectAddErrorCode
  ) {
    super(message);
    this.name = "ProjectAddError";
  }
}

export type ProjectRecord = {
  schemaVersion: 1;
  id: string;
  name: string;
  root: string;
  gitRoot: string;
  enabled: boolean;
  createdAt: string;
};

export type ProjectsFile = {
  schemaVersion: 1;
  projects: ProjectRecord[];
};

export type AddProjectOptions = {
  cwd?: string;
  homeDir?: string;
  now?: () => string;
};

export type AddProjectResult = {
  status: "added" | "already-registered";
  project: ProjectRecord;
  projectsFile: string;
  projectFile: string;
};

export async function addProject(
  inputPath: string = ".",
  options: AddProjectOptions = {}
): Promise<AddProjectResult> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedInput = resolve(cwd, inputPath);
  const existingInput = await resolveExistingPath(resolvedInput);
  const gitRoot = await findGitRoot(existingInput);
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const projectsFile = await readProjectsFile(paths.projectsFile);
  const existingProject = projectsFile.projects.find(
    (project) => project.gitRoot === gitRoot
  );
  const projectFile = join(gitRoot, ".uncommitted", "project.json");

  if (existingProject) {
    await ensureProjectFile(projectFile, existingProject);

    return {
      status: "already-registered",
      project: existingProject,
      projectsFile: paths.projectsFile,
      projectFile
    };
  }

  const project = createProjectRecord(gitRoot, options.now);
  const idConflict = projectsFile.projects.find(
    (registeredProject) => registeredProject.id === project.id
  );

  if (idConflict) {
    throw new ProjectAddError(
      `Project id conflict: ${project.id} is already used by ${idConflict.gitRoot}`,
      "project-id-conflict"
    );
  }

  const nextProjectsFile: ProjectsFile = {
    schemaVersion: 1,
    projects: [...projectsFile.projects, project]
  };

  await mkdir(join(gitRoot, ".uncommitted"), { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  await writeJson(projectFile, project);
  await writeJson(paths.projectsFile, nextProjectsFile);

  return {
    status: "added",
    project,
    projectsFile: paths.projectsFile,
    projectFile
  };
}

function createProjectRecord(
  gitRoot: string,
  now: (() => string) | undefined
): ProjectRecord {
  const name = basename(gitRoot);

  return {
    schemaVersion: 1,
    id: slugProjectId(name),
    name,
    root: gitRoot,
    gitRoot,
    enabled: true,
    createdAt: now ? now() : new Date().toISOString()
  };
}

async function resolveExistingPath(path: string): Promise<string> {
  try {
    await access(path, constants.F_OK);
    return await realpath(path);
  } catch {
    throw new ProjectAddError(`Path does not exist: ${path}`, "path-not-found");
  }
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
    throw new ProjectAddError(`Not a Git repository: ${path}`, "not-git-repository");
  }
}

async function readProjectsFile(path: string): Promise<ProjectsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (isProjectsFile(parsed)) {
      return parsed;
    }

    throw new ProjectAddError(
      `Invalid projects file: ${path}`,
      "invalid-projects-file"
    );
  } catch (error) {
    if (error instanceof ProjectAddError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      return { schemaVersion: 1, projects: [] };
    }

    throw new ProjectAddError(
      `Invalid projects file: ${path}`,
      "invalid-projects-file"
    );
  }
}

async function ensureProjectFile(
  projectFile: string,
  project: ProjectRecord
): Promise<void> {
  await mkdir(join(project.gitRoot, ".uncommitted"), { recursive: true });
  await writeJson(projectFile, project);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slugProjectId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "project";
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
