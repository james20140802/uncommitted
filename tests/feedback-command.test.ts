import { mkdir, writeFile } from "node:fs/promises";
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
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `unc-feedback-cmd-test-${randomUUID()}`);
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

const defaultPrompterAnswers = {
  fun: 4,
  share: 3,
  accuracy: 5,
  safetyConcern: false,
  wouldPost: false,
  reasons: ["weak-caption"] as string[],
  note: "캡션이 너무 담백함"
};

function makePrompter(overrides: Partial<typeof defaultPrompterAnswers> = {}): FeedbackPrompter {
  const answers = { ...defaultPrompterAnswers, ...overrides };

  return {
    askScores: async () => ({
      fun: answers.fun,
      share: answers.share,
      accuracy: answers.accuracy
    }),
    askBooleans: async () => ({
      safetyConcern: answers.safetyConcern,
      wouldPost: answers.wouldPost
    }),
    askReasons: async () => answers.reasons,
    askNote: async () => answers.note,
    confirmOverwrite: async () => true
  };
}

async function setupDraft(
  draftRoot: string,
  targetDate = "2026-05-19",
  formatName = "AI의 퇴근일지",
  activityLevel = "low"
): Promise<string> {
  const revision = await createDraftRevision({ draftRoot, targetDate });
  await writeDraftArtifactJson(revision, "story.json", {
    schemaVersion: 1,
    formatName,
    activityLevel
  });
  await writeLatestDraftPointer(revision, new Date().toISOString());
  return revision.outputDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runFeedbackCommand (feedback latest)", () => {
  it("returns exit code 1 and actionable error when no latest draft exists", async () => {
    const { io, stderr } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/no.*draft|run.*generate/i);
  });

  it("displays draft metadata before prompting", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    await setupDraft(draftRoot, "2026-05-19", "AI의 퇴근일지", "low");

    await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    const output = stdout.join("\n");
    expect(output).toContain("2026-05-19");
    expect(output).toContain("rev-001");
    expect(output).toContain("AI의 퇴근일지");
    expect(output).toContain("low");
  });

  it("saves feedback.json and appends to JSONL on success", async () => {
    const { io } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    const outputDir = await setupDraft(draftRoot, "2026-05-19", "AI의 퇴근일지", "low");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);

    const saved = await readFeedback(outputDir);
    expect(saved).not.toBeNull();
    expect(saved!.fun).toBe(4);
    expect(saved!.share).toBe(3);
    expect(saved!.accuracy).toBe(5);
    expect(saved!.wouldPost).toBe(false);
    expect(saved!.reasons).toEqual(["weak-caption"]);
    expect(saved!.note).toBe("캡션이 너무 담백함");
    expect(saved!.date).toBe("2026-05-19");
    expect(saved!.revision).toBe("rev-001");
    expect(saved!.mood).toBe("AI의 퇴근일지");
  });

  it("returns exit code 0 on success and prints confirmation", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    await setupDraft(draftRoot, "2026-05-19");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(/saved|feedback/i);
  });

  it("passes confirmOverwrite from prompter to saveFeedback on re-run", async () => {
    const { io } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });
    await setupDraft(draftRoot, "2026-05-19", "AI의 퇴근일지", "low");

    const prompter = makePrompter();
    // First run
    await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter }
    );

    // Second run with updated scores — confirmOverwrite returns true
    const updatedPrompter: FeedbackPrompter = {
      ...makePrompter({ fun: 2 }),
      confirmOverwrite: async () => true
    };

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: updatedPrompter }
    );

    expect(exitCode).toBe(0);

    // Re-read pointer to get dir again
    const outputDir = join(draftRoot, "2026-05-19", "rev-001");
    const saved = await readFeedback(outputDir);
    expect(saved!.fun).toBe(2);
  });

  it("displays Mood and Activity Level when story.json stores them under metadata.*", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    const revision = await createDraftRevision({ draftRoot, targetDate: "2026-05-20" });
    // IMPORTANT: nested-only — mood/activityLevel exclusively under `metadata.*`
    await writeDraftArtifactJson(revision, "story.json", {
      schemaVersion: 1,
      metadata: {
        mood: "grind",
        activityLevel: "high"
      }
    });
    await writeLatestDraftPointer(revision, new Date().toISOString());

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);
    expect(stdout.some((line) => line.includes("Mood: grind"))).toBe(true);
    expect(stdout.some((line) => line.includes("Activity Level: high"))).toBe(true);
  });

  it("falls back to legacy metadata.formatName when mood is absent (UNC-215)", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    const revision = await createDraftRevision({ draftRoot, targetDate: "2026-05-20" });
    await writeDraftArtifactJson(revision, "story.json", {
      schemaVersion: 1,
      metadata: {
        formatName: "Backstage Cue Book",
        activityLevel: "high"
      }
    });
    await writeLatestDraftPointer(revision, new Date().toISOString());

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);
    expect(stdout.some((line) => line.includes("Mood: Backstage Cue Book"))).toBe(true);
    expect(stdout.some((line) => line.includes("Activity Level: high"))).toBe(true);
  });

  it("renders caption.txt verbatim when it fits under the preview limit", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    const outputDir = await setupDraft(draftRoot);
    await writeFile(join(outputDir, "caption.txt"), "마이페이지에 프로필 편집을 추가했다.", "utf8");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);
    expect(stdout.some((line) => line === "Caption:")).toBe(true);
    expect(stdout.some((line) => line.includes("마이페이지에 프로필 편집을 추가했다."))).toBe(true);
  });

  it("truncates a long caption with an ellipsis", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    const outputDir = await setupDraft(draftRoot);
    const longCaption = "가".repeat(400);
    await writeFile(join(outputDir, "caption.txt"), longCaption, "utf8");

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);
    const captionLine = stdout.find((line) => line.startsWith("가"));
    expect(captionLine).toBeDefined();
    expect(captionLine!.endsWith("…")).toBe(true);
    // 280 chars + the ellipsis character
    expect(Array.from(captionLine!).length).toBe(281);
  });

  it("omits the Caption section when caption.txt is missing or empty", async () => {
    const { io, stdout } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();
    await mkdir(draftRoot, { recursive: true });

    await setupDraft(draftRoot);

    const exitCode = await runFeedbackCommand(
      { subcommand: "latest" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(0);
    expect(stdout.some((line) => line === "Caption:")).toBe(false);

    // Also: empty/whitespace file → still no Caption section
    const { io: io2, stdout: stdout2 } = createIo();
    const draftRoot2 = makeTmpDir();
    const evalsDir2 = makeTmpDir();
    await mkdir(draftRoot2, { recursive: true });
    const outputDir2 = await setupDraft(draftRoot2);
    await writeFile(join(outputDir2, "caption.txt"), "   \n  \n", "utf8");

    const exitCode2 = await runFeedbackCommand(
      { subcommand: "latest" },
      io2,
      { draftRoot: draftRoot2, evalsDir: evalsDir2, prompter: makePrompter() }
    );

    expect(exitCode2).toBe(0);
    expect(stdout2.some((line) => line === "Caption:")).toBe(false);
  });

  it("returns exit code 1 for unknown subcommand", async () => {
    const { io, stderr } = createIo();
    const draftRoot = makeTmpDir();
    const evalsDir = makeTmpDir();

    const exitCode = await runFeedbackCommand(
      { subcommand: "unknown" },
      io,
      { draftRoot, evalsDir, prompter: makePrompter() }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/usage/i);
  });
});
