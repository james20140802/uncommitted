import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addProject } from "../src/project-add.js";
import {
  listManualNotes,
  NoteCommandError,
  recordManualNote
} from "../src/note-command.js";

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

  it("lists recent manual notes newest first with a small default limit", async () => {
    const { homeDir, repoDir } = await createRegisteredProject("note-list-success");
    const nestedDir = join(repoDir, "packages", "cli");
    await mkdir(nestedDir, { recursive: true });

    for (let index = 0; index < 11; index += 1) {
      const minute = String(index).padStart(2, "0");

      await recordManualNote([`note ${index}`], {
        cwd: repoDir,
        homeDir,
        now: () => `2026-05-06T10:${minute}:00.000Z`,
        createId: () => `note-${index}`
      });
    }

    const result = await listManualNotes({
      cwd: nestedDir,
      homeDir
    });

    expect(result.limit).toBe(10);
    expect(result.notes).toHaveLength(10);
    expect(result.notes.map((note) => note.text)).toEqual([
      "note 10",
      "note 9",
      "note 8",
      "note 7",
      "note 6",
      "note 5",
      "note 4",
      "note 3",
      "note 2",
      "note 1"
    ]);
  });

  it("treats missing manual note files as an empty list", async () => {
    const { homeDir, repoDir } = await createRegisteredProject("note-list-empty");

    await expect(
      listManualNotes({
        cwd: repoDir,
        homeDir
      })
    ).resolves.toEqual({
      notes: [],
      limit: 10
    });
  });

  it("fails clearly outside a registered project when listing notes", async () => {
    const root = await createTempRoot("note-list-unregistered");
    const repoDir = await initGitRepo(join(root, "repo"));

    await expect(
      listManualNotes({
        cwd: repoDir,
        homeDir: join(root, "home")
      })
    ).rejects.toMatchObject({
      code: "project-not-registered",
      message: "Run inside a registered project."
    });
  });

  it("reports malformed stored manual note data without private paths", async () => {
    const { homeDir, repoDir } = await createRegisteredProject("note-list-malformed");
    const eventsDir = join(repoDir, ".uncommitted", "events", "manual");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "2026-05-06.jsonl"), "{nope}\n", "utf8");

    await expect(
      listManualNotes({
        cwd: repoDir,
        homeDir
      })
    ).rejects.toMatchObject({
      code: "malformed-note-data",
      message: "Stored manual notes are malformed. Fix or remove the invalid note data."
    });

    await expect(
      listManualNotes({
        cwd: repoDir,
        homeDir
      })
    ).rejects.not.toThrow(repoDir);
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
