import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isDirectRun, runCli } from "../src/cli.js";
import { addProject } from "../src/project-add.js";

const execFileAsync = promisify(execFile);

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    },
    stdout,
    stderr
  };
}

describe("cli", () => {
  it("prints help", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["--", "--help"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: uncommitted <command>");
    expect(stdout.join("\n")).toContain("init");
    expect(stdout.join("\n")).toContain("generate");
  });

  it("routes collect without a source to an actionable message", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect git");
  });

  it("collects today's Git activity for registered projects", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "app.ts"), "const today = true;\n", "utf8");
    await git(repoDir, ["add", "app.ts"]);
    await commit(repoDir, "collect target", "2026-05-06T10:00:00Z");
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir,
      now: () => "2026-05-06T13:30:00.000Z"
    });
    const outputFile = join(
      repoDir,
      ".uncommitted",
      "events",
      "git",
      "2026-05-06.json"
    );
    const output = await readJson(outputFile);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Collected Git activity for 1 project.");
    expect(output).toMatchObject({
      schemaVersion: 1,
      source: "git",
      targetDate: "2026-05-06",
      project: {
        id: "repo",
        name: "repo"
      },
      activity: {
        totals: {
          commits: 1,
          filesChanged: 1
        }
      }
    });
    expect(JSON.stringify(output)).not.toContain(repoDir);
    expect(JSON.stringify(output)).not.toContain("const today = true");
  });

  it("returns collection exit code for missing or empty project registry", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-empty-"));

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir: join(directory, "home"),
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "No registered projects. Run `uncommitted project add .` first."
    );
  });

  it("returns config exit code when collect git finds invalid projects file", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-invalid-"));
    const homeDir = join(directory, "home");

    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "projects.json"), "nope", "utf8");

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir,
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Invalid projects file.");
  });

  it("preserves successful collect output when another project fails", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-partial-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "app.ts"), "const partial = true;\n", "utf8");
    await git(repoDir, ["add", "app.ts"]);
    await commit(repoDir, "partial target", "2026-05-06T10:00:00Z");
    const registered = await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });
    await writeFile(
      join(homeDir, ".uncommitted", "projects.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projects: [
            registered.project,
            {
              schemaVersion: 1,
              id: "missing-repo",
              name: "missing-repo",
              root: join(directory, "missing"),
              gitRoot: join(directory, "missing"),
              enabled: true,
              createdAt: "2026-05-06T00:00:00.000Z"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir,
      now: () => "2026-05-06T13:30:00.000Z"
    });
    const output = await readJson(
      join(repoDir, ".uncommitted", "events", "git", "2026-05-06.json")
    );

    expect(exitCode).toBe(3);
    expect(stdout.join("\n")).toContain("Collected Git activity for 1 project.");
    expect(stderr.join("\n")).toContain("Failed to collect missing-repo");
    expect(output).toMatchObject({
      project: {
        id: "repo"
      },
      activity: {
        totals: {
          commits: 1
        }
      }
    });
  });

  it("routes note to the manual note handler", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-note-"));

    const exitCode = await runCli(["note", "remember this"], io, {
      homeDir: join(directory, "home"),
      cwd: directory
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Run inside a registered project.");
  });

  it("does not save note list as a manual note", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-note-list-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await execFileAsync("git", ["init", repoDir]);
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });

    const exitCode = await runCli(["note", "list"], io, {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-06T10:15:30.000Z"
    });

    await expect(
      access(join(repoDir, ".uncommitted", "events", "manual", "2026-05-06.jsonl"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["No manual notes found."]);
    expect(stderr).toEqual([]);
  });

  it("prints manual notes newest first", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-note-list-output-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await execFileAsync("git", ["init", repoDir]);
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });

    await runCli(["note", "older note"], io, {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-06T10:15:30.000Z"
    });
    await runCli(["note", "newer note"], io, {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-06T11:00:00.000Z"
    });

    stdout.length = 0;
    stderr.length = 0;

    const exitCode = await runCli(["note", "list"], io, {
      cwd: repoDir,
      homeDir
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Manual notes (newest first):",
      "2026-05-06 11:00 newer note",
      "2026-05-06 10:15 older note"
    ]);
  });

  it("rejects note list with extra arguments", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["note", "list", "fix", "tests"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Usage: uncommitted note list"]);
  });

  it("routes project add to the project registration handler", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-add-"));

    const exitCode = await runCli(["project", "add", directory], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Not a Git repository");
  });

  it("routes doctor to the environment report handler", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-doctor-"));

    const exitCode = await runCli(["doctor"], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Uncommitted Doctor");
    expect(stdout.join("\n")).toContain("[fail] Global config");
  });

  it("returns config exit code when project add path is missing", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-add-"));

    const exitCode = await runCli(["project", "add", join(directory, "missing")], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Path does not exist");
  });

  it("returns config exit code when project add finds invalid projects file", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-add-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await execFileAsync("git", ["init", repoDir]);
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "projects.json"), "nope", "utf8");

    const exitCode = await runCli(["project", "add", repoDir], io, { homeDir });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Invalid projects file");
  });

  it("reports unknown commands", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["nope"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown command: nope");
    expect(stderr.join("\n")).toContain("Run `uncommitted --help`.");
  });

  it("detects direct runs through symlinked bin entrypoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-"));
    const realEntrypoint = join(directory, "cli.js");
    const linkedEntrypoint = join(directory, "uncommitted");

    await writeFile(realEntrypoint, "");
    await symlink(realEntrypoint, linkedEntrypoint);

    expect(isDirectRun(linkedEntrypoint, pathToFileURL(realEntrypoint).href)).toBe(true);
  });
});

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init", repoDir]);
  await git(repoDir, ["config", "user.name", "Fixture Dev"]);
  await git(repoDir, ["config", "user.email", "dev@example.com"]);
}

async function commit(
  repoDir: string,
  message: string,
  date: string
): Promise<void> {
  await git(repoDir, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

async function git(
  repoDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args], {
    env: {
      ...process.env,
      ...env
    }
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
