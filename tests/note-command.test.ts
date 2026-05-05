import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addProject } from "../src/project-add.js";
import { NoteCommandError, recordManualNote } from "../src/note-command.js";

const execFileAsync = promisify(execFile);

describe("note command", () => {
  it("appends a manual note JSONL event for the current registered project", async () => {
    const { homeDir, repoDir } = await createRegisteredProject("note-success");
    const nestedDir = join(repoDir, "packages", "cli");
    await mkdir(nestedDir, { recursive: true });

    const result = await recordManualNote(["fixed the flaky setup"], {
      cwd: nestedDir,
      homeDir,
      now: () => "2026-05-06T10:15:30.000Z",
      createId: () => "note-1"
    });

    expect(result).toEqual({
      eventFile: join(repoDir, ".uncommitted", "events", "manual", "2026-05-06.jsonl"),
      event: {
        schemaVersion: 1,
        id: "note-1",
        timestamp: "2026-05-06T10:15:30.000Z",
        date: "2026-05-06",
        projectId: "note-success",
        text: "fixed the flaky setup",
        source: "manual"
      }
    });

    const lines = (
      await readFile(result.eventFile, "utf8")
    ).trimEnd().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]) as unknown).toEqual(result.event);
    expect(lines[0]).not.toContain(repoDir);
    expect(lines[0]).not.toContain(homeDir);
  });

  it("rejects empty or whitespace-only notes", async () => {
    await expect(recordManualNote(["  \t "], {})).rejects.toMatchObject({
      code: "empty-note",
      message: "Note is empty. Pass text like: uncommitted note \"fixed a bug\"."
    });
  });

  it("fails clearly outside a registered project", async () => {
    const root = await createTempRoot("note-unregistered");
    const repoDir = await initGitRepo(join(root, "repo"));

    await expect(
      recordManualNote(["worked on tests"], {
        cwd: repoDir,
        homeDir: join(root, "home")
      })
    ).rejects.toMatchObject({
      code: "project-not-registered",
      message: "Run inside a registered project."
    });
  });

  it("uses a typed note command error", async () => {
    await expect(recordManualNote([], {})).rejects.toBeInstanceOf(NoteCommandError);
  });
});

async function createRegisteredProject(name: string): Promise<{
  homeDir: string;
  repoDir: string;
}> {
  const root = await createTempRoot(name);
  const repoDir = await initGitRepo(join(root, name));
  const homeDir = join(root, "home");

  await addProject(repoDir, {
    homeDir,
    now: () => "2026-05-06T00:00:00.000Z"
  });

  return { homeDir, repoDir };
}

async function createTempRoot(name: string): Promise<string> {
  const root = join(tmpdir(), `uncommitted-${name}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function initGitRepo(repoDir: string): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", repoDir]);
  return await realpath(repoDir);
}
