import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listProjects,
  ProjectRegistryError,
  removeProject,
  type ProjectRecord
} from "../src/project-registry.js";

describe("project registry", () => {
  it("lists projects from the global registry", async () => {
    const homeDir = await createHomeWithProjects([projectRecord("alpha")]);

    const result = await listProjects({ homeDir });

    expect(result.projects).toEqual([projectRecord("alpha")]);
  });

  it("lists an initialized empty registry", async () => {
    const homeDir = await createHomeWithProjects([]);

    const result = await listProjects({ homeDir });

    expect(result.projects).toEqual([]);
  });

  it("fails clearly when Uncommitted has not been initialized", async () => {
    const homeDir = join("/tmp", `uncommitted-project-registry-home-${randomUUID()}`);

    await expect(listProjects({ homeDir })).rejects.toMatchObject({
      code: "missing-config",
      message: "Config not found. Run `uncommitted init` first."
    });
  });

  it("removes a matching project from the global registry only", async () => {
    const removableProject = projectRecord("alpha");
    const retainedProject = projectRecord("beta");
    const homeDir = await createHomeWithProjects([removableProject, retainedProject]);
    const localProjectFile = join(removableProject.gitRoot, ".uncommitted", "project.json");
    const localEventLog = join(
      removableProject.gitRoot,
      ".uncommitted",
      "events",
      "manual",
      "2026-06-04.jsonl"
    );
    const draftFile = join(
      homeDir,
      "drafts",
      "2026-06-04",
      "rev-001",
      "caption.txt"
    );

    await mkdir(join(removableProject.gitRoot, ".uncommitted", "events", "manual"), {
      recursive: true
    });
    await mkdir(join(homeDir, "drafts", "2026-06-04", "rev-001"), {
      recursive: true
    });
    await writeJson(localProjectFile, removableProject);
    await writeFile(localEventLog, "{}\n", "utf8");
    await writeFile(draftFile, "draft caption\n", "utf8");

    const result = await removeProject("alpha", { homeDir });

    expect(result.removedProject).toEqual(removableProject);
    expect(await readProjects(homeDir)).toEqual([retainedProject]);
    await expect(stat(localProjectFile)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(localEventLog)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(draftFile)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("fails clearly when removing an unknown project id", async () => {
    const homeDir = await createHomeWithProjects([projectRecord("alpha")]);

    await expect(removeProject("missing", { homeDir })).rejects.toMatchObject({
      code: "unknown-project",
      message: "Unknown project id: missing. Run `uncommitted project list`."
    });
  });

  it("uses a typed registry error for unreadable registry data", async () => {
    const homeDir = await createHomeWithProjects([]);

    await writeFile(join(homeDir, ".uncommitted", "projects.json"), "nope", "utf8");

    await expect(listProjects({ homeDir })).rejects.toBeInstanceOf(
      ProjectRegistryError
    );
  });
});

function projectRecord(id: string): ProjectRecord {
  const gitRoot = join("/tmp", "uncommitted-project-registry", id);

  return {
    schemaVersion: 1,
    id,
    name: id,
    root: gitRoot,
    gitRoot,
    enabled: true,
    createdAt: "2026-06-04T00:00:00.000Z"
  };
}

async function createHomeWithProjects(projects: ProjectRecord[]): Promise<string> {
  const homeDir = join("/tmp", `uncommitted-project-registry-home-${randomUUID()}`);

  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeJson(join(homeDir, ".uncommitted", "config.json"), {
    schemaVersion: 1,
    draftRoot: join(homeDir, "drafts"),
    scheduleTime: "23:30",
    aiProvider: "none",
    persona: "test persona",
    roastLevel: 2
  });
  await writeJson(join(homeDir, ".uncommitted", "projects.json"), {
    schemaVersion: 1,
    projects
  });

  return homeDir;
}

async function readProjects(homeDir: string): Promise<ProjectRecord[]> {
  const parsed = JSON.parse(
    await readFile(join(homeDir, ".uncommitted", "projects.json"), "utf8")
  ) as { projects: ProjectRecord[] };

  return parsed.projects;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
