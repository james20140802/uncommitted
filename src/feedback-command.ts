import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { FEEDBACK_REASONS, type FeedbackReason, type FeedbackRecord } from "./feedback-types.js";
import { saveFeedback } from "./feedback-storage.js";
import { readLatestDraftPointer, DraftStorageError } from "./draft-storage.js";
import type { CliIo } from "./cli.js";

// ---------------------------------------------------------------------------
// FeedbackPrompter abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export type FeedbackScoreAnswers = {
  fun: number;
  share: number;
  accuracy: number;
};

export type FeedbackBooleanAnswers = {
  safetyConcern: boolean;
  wouldPost: boolean;
};

export type FeedbackPrompter = {
  askScores: () => Promise<FeedbackScoreAnswers>;
  askBooleans: () => Promise<FeedbackBooleanAnswers>;
  askReasons: () => Promise<string[]>;
  askNote: () => Promise<string>;
  confirmOverwrite: () => Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Readline-backed default prompter
// ---------------------------------------------------------------------------

export function createReadlinePrompter(): FeedbackPrompter {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  }

  async function askScore(name: string): Promise<number> {
    while (true) {
      const raw = await ask(`${name} (1-5): `);
      const value = parseInt(raw, 10);

      if (Number.isInteger(value) && value >= 1 && value <= 5) {
        return value;
      }

      process.stdout.write("Enter an integer between 1 and 5.\n");
    }
  }

  async function askYesNo(question: string): Promise<boolean> {
    while (true) {
      const raw = await ask(`${question} (y/n): `);
      const lower = raw.toLowerCase();

      if (lower === "y" || lower === "yes") return true;
      if (lower === "n" || lower === "no") return false;

      process.stdout.write("Enter y or n.\n");
    }
  }

  return {
    async askScores(): Promise<FeedbackScoreAnswers> {
      const fun = await askScore("Fun score");
      const share = await askScore("Share score");
      const accuracy = await askScore("Accuracy score");

      rl.close();
      return { fun, share, accuracy };
    },

    async askBooleans(): Promise<FeedbackBooleanAnswers> {
      const safetyConcern = await askYesNo("Safety concern?");
      const wouldPost = await askYesNo("Would post to Instagram?");

      return { safetyConcern, wouldPost };
    },

    async askReasons(): Promise<string[]> {
      process.stdout.write("\nWhat was wrong? (comma-separated numbers, or blank for none)\n");
      FEEDBACK_REASONS.forEach((r, i) => {
        process.stdout.write(`  ${String(i + 1).padStart(2)}. ${r}\n`);
      });

      const raw = await ask("Select: ");

      if (!raw) return [];

      const selected: FeedbackReason[] = [];

      for (const part of raw.split(",")) {
        const idx = parseInt(part.trim(), 10) - 1;

        if (idx >= 0 && idx < FEEDBACK_REASONS.length) {
          selected.push(FEEDBACK_REASONS[idx]);
        }
      }

      return selected;
    },

    async askNote(): Promise<string> {
      return ask("Note (optional): ");
    },

    async confirmOverwrite(): Promise<boolean> {
      return askYesNo("Feedback already exists. Overwrite?");
    }
  };
}

// ---------------------------------------------------------------------------
// runFeedbackCommand options
// ---------------------------------------------------------------------------

export type FeedbackCommandInput = {
  subcommand: string;
  targetDate?: string;
};

export type FeedbackCommandOptions = {
  draftRoot: string;
  evalsDir: string;
  prompter: FeedbackPrompter;
  now?: () => string;
};

// ---------------------------------------------------------------------------
// Core command logic
// ---------------------------------------------------------------------------

export async function runFeedbackCommand(
  input: FeedbackCommandInput,
  io: CliIo,
  options: FeedbackCommandOptions
): Promise<number> {
  if (input.subcommand === "latest") {
    return runFeedbackLatest(io, options);
  }

  io.stderr(
    `Usage: uncommitted feedback <latest|report> [options]`
  );
  return 1;
}

async function runFeedbackLatest(
  io: CliIo,
  options: FeedbackCommandOptions
): Promise<number> {
  // 1. Resolve latest draft pointer
  let targetDate: string;
  let revision: string;
  let outputDir: string;

  try {
    const pointer = await readLatestDraftPointer(options.draftRoot);
    targetDate = pointer.targetDate;
    revision = pointer.revision;
    outputDir = pointer.path;
  } catch (error) {
    if (error instanceof DraftStorageError) {
      io.stderr(
        "No latest draft found. Run `uncommitted generate today` first."
      );
      return 1;
    }

    throw error;
  }

  // 2. Read story.json for formatName / activityLevel
  const storyMeta = await readStoryMeta(outputDir);

  // 3. Display draft metadata
  io.stdout(`Draft: ${targetDate} / ${revision}`);

  if (storyMeta.formatName) {
    io.stdout(`Format: ${storyMeta.formatName}`);
  }

  if (storyMeta.activityLevel) {
    io.stdout(`Activity Level: ${storyMeta.activityLevel}`);
  }

  io.stdout("");

  // 4. Collect feedback interactively
  const scores = await options.prompter.askScores();
  const booleans = await options.prompter.askBooleans();
  const reasons = await options.prompter.askReasons();
  const note = await options.prompter.askNote();

  const createdAt = options.now ? options.now() : new Date().toISOString();

  const record: FeedbackRecord = {
    date: targetDate,
    revision,
    formatName: storyMeta.formatName ?? "",
    fun: clampScore(scores.fun),
    share: clampScore(scores.share),
    accuracy: clampScore(scores.accuracy),
    safetyConcern: booleans.safetyConcern,
    wouldPost: booleans.wouldPost,
    reasons: reasons.filter(isFeedbackReason),
    note,
    createdAt
  };

  // 5. Save
  await saveFeedback(record, outputDir, options.evalsDir, {
    confirmOverwrite: options.prompter.confirmOverwrite
  });

  io.stdout(`\nFeedback saved for ${targetDate} / ${revision}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StoryMeta = {
  formatName?: string;
  activityLevel?: string;
};

async function readStoryMeta(outputDir: string): Promise<StoryMeta> {
  try {
    const raw = await readFile(join(outputDir, "story.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (isRecord(parsed)) {
      return {
        formatName: typeof parsed.formatName === "string" ? parsed.formatName : undefined,
        activityLevel:
          typeof parsed.activityLevel === "string" ? parsed.activityLevel : undefined
      };
    }
  } catch {
    // story.json missing or unparseable — non-fatal, proceed without metadata
  }

  return {};
}

function clampScore(value: number): 1 | 2 | 3 | 4 | 5 {
  const clamped = Math.max(1, Math.min(5, Math.round(value)));
  return clamped as 1 | 2 | 3 | 4 | 5;
}

function isFeedbackReason(value: string): value is FeedbackReason {
  return (FEEDBACK_REASONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
