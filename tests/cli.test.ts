import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isDirectRun, runCli } from "../src/cli.js";

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

  it("routes known commands to placeholder handlers", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["note"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Command not implemented yet: note");
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

    expect(exitCode).toBe(1);
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
