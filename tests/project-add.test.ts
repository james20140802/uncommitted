import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addProject, ProjectAddError } from "../src/project-add.js";

const execFileAsync = promisify(execFile);

describe("project add", () => {
  it("registers the current Git repository", async () => {
    const { homeDir, repoDir } = await createGitRepoFixture("current-repo");

    const result = await addProject(".", {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-03T00:00:00.000Z"
    });

    expect(result.status).toBe("added");
    expect(result.project).toEqual({
      schemaVersion: 1,
      id: "current-repo",
      name: "current-repo",
      root: repoDir,
      gitRoot: repoDir,
      enabled: true,
      createdAt: "2026-05-03T00:00:00.000Z"
    });

    await expectDirectory(join(repoDir, ".uncommitted"));
    await expectProjectFile(repoDir, result.project);
    await expectProjectsFile(homeDir, [result.project]);
  });

  it("registers an explicit path by its Git root", async () => {
    const { homeDir, repoDir } = await createGitRepoFixture("explicit-repo");
    const nestedDir = join(repoDir, "packages", "cli");
    await mkdir(nestedDir, { recursive: true });

    const result = await addProject(nestedDir, {
      cwd: join(await createTempRoot(), "elsewhere"),
      homeDir,
      now: () => "2026-05-03T00:00:00.000Z"
    });

    expect(result.status).toBe("added");
    expect(result.project.root).toBe(repoDir);
    expect(result.project.gitRoot).toBe(repoDir);
    await expectProjectFile(repoDir, result.project);
    await expectProjectsFile(homeDir, [result.project]);
  });

  it("does not register the same Git root twice", async () => {
    const { homeDir, repoDir } = await createGitRepoFixture("duplicate-repo");

    const first = await addProject(".", {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-03T00:00:00.000Z"
    });
    const second = await addProject(repoDir, {
      cwd: await createTempRoot(),
      homeDir,
      now: () => "2026-05-04T00:00:00.000Z"
    });

    expect(second.status).toBe("already-registered");
    expect(second.project).toEqual(first.project);
    await expectProjectsFile(homeDir, [first.project]);
  });

  it("fails clearly for non-Git directories", async () => {
    const root = await createTempRoot();
    const homeDir = join(root, "home");
    const directory = join(root, "plain-dir");
    await mkdir(directory, { recursive: true });

    await expect(addProject(directory, { homeDir })).rejects.toMatchObject({
      code: "not-git-repository",
      message: expect.stringContaining("Not a Git repository")
    });
  });

  it("fails clearly when another root already owns the generated project id", async () => {
    const root = await createTempRoot();
    const homeDir = join(root, "home");
    const firstRepo = await initGitRepo(join(root, "same-name"));
    const secondRepo = await initGitRepo(join(root, "parent", "same-name"));

    await addProject(firstRepo, {
      homeDir,
      now: () => "2026-05-03T00:00:00.000Z"
    });

    await expect(addProject(secondRepo, { homeDir })).rejects.toMatchObject({
      code: "project-id-conflict",
      message: expect.stringContaining("Project id conflict")
    });
  });

  it("uses a typed project add error", async () => {
    const root = await createTempRoot();

    await expect(addProject(join(root, "missing"))).rejects.toBeInstanceOf(
      ProjectAddError
    );
  });
});

async function createGitRepoFixture(name: string): Promise<{
  homeDir: string;
  repoDir: string;
}> {
  const root = await createTempRoot();
  const repoDir = await initGitRepo(join(root, name));

  return {
    homeDir: join(root, "home"),
    repoDir
  };
}

async function createTempRoot(): Promise<string> {
  const root = join(tmpdir(), `uncommitted-project-add-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function initGitRepo(repoDir: string): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", repoDir]);
  return await realpath(repoDir);
}

async function expectDirectory(path: string): Promise<void> {
  await expect(stat(path).then((stats) => stats.isDirectory())).resolves.toBe(true);
}

async function expectProjectFile(
  repoDir: string,
  expected: Record<string, unknown>
): Promise<void> {
  await expectJsonFile(join(repoDir, ".uncommitted", "project.json"), expected);
}

async function expectProjectsFile(
  homeDir: string,
  projects: Record<string, unknown>[]
): Promise<void> {
  await expectJsonFile(join(homeDir, ".uncommitted", "projects.json"), {
    schemaVersion: 1,
    projects
  });
}

async function expectJsonFile(path: string, expected: unknown): Promise<void> {
  await expect(readJson(path)).resolves.toEqual(expected);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
