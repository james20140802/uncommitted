import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";

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

export type ProjectRegistryErrorCode =
  | "missing-config"
  | "invalid-projects-file"
  | "unknown-project";

export class ProjectRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: ProjectRegistryErrorCode
  ) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

export type ProjectRegistryOptions = {
  homeDir?: string;
};

export type ListProjectsResult = {
  projects: ProjectRecord[];
  projectsFile: string;
};

export type RemoveProjectResult = {
  removedProject: ProjectRecord;
  projectsFile: string;
};

export async function listProjects(
  options: ProjectRegistryOptions = {}
): Promise<ListProjectsResult> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });

  await ensureInitialized(paths.configFile);

  return {
    projects: (await readProjectsFile(paths.projectsFile)).projects,
    projectsFile: paths.projectsFile
  };
}

export async function removeProject(
  projectId: string,
  options: ProjectRegistryOptions = {}
): Promise<RemoveProjectResult> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });

  await ensureInitialized(paths.configFile);

  const projectsFile = await readProjectsFile(paths.projectsFile);
  const removedProject = projectsFile.projects.find(
    (project) => project.id === projectId
  );

  if (!removedProject) {
    throw new ProjectRegistryError(
      `Unknown project id: ${projectId}. Run \`uncommitted project list\`.`,
      "unknown-project"
    );
  }

  await writeProjectsFile(paths.projectsFile, {
    schemaVersion: 1,
    projects: projectsFile.projects.filter((project) => project.id !== projectId)
  });

  return {
    removedProject,
    projectsFile: paths.projectsFile
  };
}

export async function readProjectsFile(
  path: string,
  options: { missingAsEmpty?: boolean } = {}
): Promise<ProjectsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (isProjectsFile(parsed)) {
      return parsed;
    }

    throw invalidProjectsFile(path);
  } catch (error) {
    if (error instanceof ProjectRegistryError) {
      throw error;
    }

    if (
      options.missingAsEmpty === true &&
      isNodeError(error) &&
      error.code === "ENOENT"
    ) {
      return { schemaVersion: 1, projects: [] };
    }

    throw invalidProjectsFile(path);
  }
}

export async function writeProjectsFile(
  path: string,
  projectsFile: ProjectsFile
): Promise<void> {
  await writeFile(path, `${JSON.stringify(projectsFile, null, 2)}\n`, "utf8");
}

function invalidProjectsFile(path: string): ProjectRegistryError {
  return new ProjectRegistryError(
    `Invalid projects file: ${path}`,
    "invalid-projects-file"
  );
}

async function ensureInitialized(configFile: string): Promise<void> {
  try {
    await access(configFile, constants.F_OK);
  } catch {
    throw new ProjectRegistryError(
      "Config not found. Run `uncommitted init` first.",
      "missing-config"
    );
  }
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
