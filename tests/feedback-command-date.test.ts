import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFeedbackCommand,
  type FeedbackPrompter
} from "../src/feedback-command.js";
import {
  createDraftRevision,
  writeLatestDraftPointer,
  writeDraftArtifactJson
} from "../src/draft-storage.js";
import { readFeedback } from "../src/feedback-storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `unc-feedback-date-test-${randomUUID()}`);
}

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

function makePrompter(): FeedbackPrompter {
  return {
    askScores: async () => ({ fun: 4, share: 3, accuracy: 5 }),
    askBooleans: async () => ({ safetyConcern: false, wouldPost: false }),
    askReasons: async () => ["weak-caption"],
    askNote: async () => "test note",
    confirmOverwrite: async () => true
  };
}

async function setupDraftForDate(
  draftRoot: string,
  targetDate: string,
  formatName = "테스트 포맷"
): Promise<string> {
  const revision = await createDraftRevision({ draftRoot, targetDate });
  await writeDraftArtifactJson(revision, "story.json", {
    schemaVersion: 1,
    formatName,
    activityLevel: "medium"
  });
  await writeLatestDraftPointer(revision, new Date().toISOString());
  return revision.outputDir;
}

// ---------------------------------------------------------------------------
// Tests: --date option
// ---------------------------------------------------------------------------

describe("runFeedbackCommand with targetDate", () => {
  it("targets the specified date's draft when --date is passed", async () => {
    const { io } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    // Create drafts for two dates
    const outputDir1 = await setupDraftForDate(draftRoot, "2026-05-17", "Older Format");
    await setupDraftForDate(draftRoot, "2026-05-19", "Latest Format");

    // Target the older date explicitly
    const exitCode = await runFeedbackCommand(
      { subcommand: "latest", targetDate: "2026-05-17" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);

    const saved = await readFeedback(outputDir1);
    expect(saved).not.toBeNull();
    expect(saved!.date).toBe("2026-05-17");
    expect(saved!.mood).toBe("Older Format");
  });

  it("returns exit code 1 when specified date has no draft", async () => {
    const { io, stderr } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    await setupDraftForDate(draftRoot, "2026-05-19");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest", targetDate: "2026-05-01" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/no.*draft|not found|2026-05-01/i);
  });

  it("displays the targeted date in output header", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    await setupDraftForDate(draftRoot, "2026-05-17", "Old Format");

    await runFeedbackCommand(
      { subcommand: "latest", targetDate: "2026-05-17" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(stdout.join("\n")).toContain("2026-05-17");
  });
});

// ---------------------------------------------------------------------------
// Tests: non-interactive flags
// ---------------------------------------------------------------------------

describe("runFeedbackCommand non-interactive mode", () => {
  it("saves record from flags without calling prompter", async () => {
    const { io } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    const outputDir = await setupDraftForDate(draftRoot, "2026-05-19", "AI의 퇴근일지");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      {
        draftRoot,
        evalsDir,
        prompter: makePrompter(),
        nonInteractive: {
          fun: 5,
          share: 4,
          accuracy: 3,
          safetyConcern: false,
          wouldPost: true,
          reasons: ["too-generic", "weak-caption"],
          note: "auto note",
          yes: true
        }
      }
    );

    expect(exitCode).toBe(0);

    const saved = await readFeedback(outputDir);
    expect(saved).not.toBeNull();
    expect(saved!.fun).toBe(5);
    expect(saved!.share).toBe(4);
    expect(saved!.accuracy).toBe(3);
    expect(saved!.safetyConcern).toBe(false);
    expect(saved!.wouldPost).toBe(true);
    expect(saved!.reasons).toEqual(["too-generic", "weak-caption"]);
    expect(saved!.note).toBe("auto note");
  });

  it("returns exit code 1 when non-interactive flags have missing required fields", async () => {
    const { io, stderr } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    await setupDraftForDate(draftRoot, "2026-05-19");

    // Missing fun score
    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      {
        draftRoot,
        evalsDir,
        prompter: makePrompter(),
        nonInteractive: {
          // fun is missing
          share: 3,
          accuracy: 5,
          safetyConcern: false,
          wouldPost: false,
          reasons: [],
          note: "",
          yes: true
        } as Parameters<typeof runFeedbackCommand>[2]["nonInteractive"]
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/fun|missing|required/i);
  });

  it("returns exit code 1 when non-interactive flags contain invalid score", async () => {
    const { io, stderr } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    await setupDraftForDate(draftRoot, "2026-05-19");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      {
        draftRoot,
        evalsDir,
        prompter: makePrompter(),
        nonInteractive: {
          fun: 9,  // out of range
          share: 3,
          accuracy: 5,
          safetyConcern: false,
          wouldPost: false,
          reasons: [],
          note: "",
          yes: true
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/fun|score|1.5|valid|range/i);
  });

  it("returns exit code 1 when non-interactive reasons contain invalid enum value", async () => {
    const { io, stderr } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    await setupDraftForDate(draftRoot, "2026-05-19");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      {
        draftRoot,
        evalsDir,
        prompter: makePrompter(),
        nonInteractive: {
          fun: 4,
          share: 3,
          accuracy: 5,
          safetyConcern: false,
          wouldPost: false,
          reasons: ["not-a-valid-reason"],
          note: "",
          yes: true
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/reason|invalid|not-a-valid-reason/i);
  });

  it("auto-confirms overwrite when yes flag is true", async () => {
    const { io } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    const outputDir = await setupDraftForDate(draftRoot, "2026-05-19");

    // First save
    await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      {
        draftRoot,
        evalsDir,
        prompter: makePrompter(),
        nonInteractive: {
          fun: 3,
          share: 3,
          accuracy: 3,
          safetyConcern: false,
          wouldPost: false,
          reasons: [],
          note: "first",
          yes: true
        }
      }
    );

    // Second save should overwrite without prompt
    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      {
        draftRoot,
        evalsDir,
        prompter: makePrompter(),
        nonInteractive: {
          fun: 5,
          share: 5,
          accuracy: 5,
          safetyConcern: false,
          wouldPost: true,
          reasons: [],
          note: "second",
          yes: true
        }
      }
    );

    expect(exitCode).toBe(0);
    const saved = await readFeedback(outputDir);
    expect(saved!.fun).toBe(5);
    expect(saved!.note).toBe("second");
  });
});
