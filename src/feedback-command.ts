import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  FEEDBACK_REASONS,
  isFeedbackReason,
  isValidScore,
  type FeedbackReason,
  type FeedbackRecord
} from "./feedback-types.js";
import { saveFeedback } from "./feedback-storage.js";
import { readLatestDraftPointer, DraftStorageError } from "./draft-storage.js";
import { aggregateFeedback, formatFeedbackReport } from "./feedback-report.js";
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
  close?: () => void;
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
    },

    close(): void {
      rl.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Non-interactive input type (all flags from CLI)
// ---------------------------------------------------------------------------

export type NonInteractiveInput = {
  fun?: number;
  share?: number;
  accuracy?: number;
  safetyConcern?: boolean;
  wouldPost?: boolean;
  reasons?: string[];
  note?: string;
  /** When true, automatically confirm overwrite without prompting */
  yes?: boolean;
};

// ---------------------------------------------------------------------------
// runFeedbackCommand options
// ---------------------------------------------------------------------------

export type FeedbackCommandInput = {
  subcommand: string;
  targetDate?: string;
  /** For `report` subcommand: number of days to aggregate */
  days?: number;
};

export type FeedbackCommandOptions = {
  draftRoot: string;
  evalsDir: string;
  prompter: FeedbackPrompter;
  now?: () => string;
  /** When provided, skip interactive prompts and use these values */
  nonInteractive?: NonInteractiveInput;
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
    return runFeedbackLatest(input, io, options);
  }

  if (input.subcommand === "report") {
    return runFeedbackReport(input, io, options);
  }

  io.stderr(
    `Usage: uncommitted feedback <latest|report> [options]`
  );
  return 1;
}

async function runFeedbackReport(
  input: FeedbackCommandInput,
  io: CliIo,
  options: FeedbackCommandOptions
): Promise<number> {
  const days = input.days ?? 7;
  const agg = await aggregateFeedback(options.evalsDir, days);
  io.stdout(formatFeedbackReport(agg));
  return 0;
}

async function runFeedbackLatest(
  input: FeedbackCommandInput,
  io: CliIo,
  options: FeedbackCommandOptions
): Promise<number> {
  // 1. Validate non-interactive input early (before hitting the filesystem)
  if (options.nonInteractive) {
    const validationError = validateNonInteractiveInput(options.nonInteractive);
    if (validationError) {
      io.stderr(validationError);
      return 1;
    }
  }

  // 2. Resolve draft directory
  let targetDate: string;
  let revision: string;
  let outputDir: string;

  if (input.targetDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) {
      io.stderr(`--date must be in YYYY-MM-DD format, got: ${input.targetDate}`);
      return 1;
    }

    // Resolve the latest revision for the specific date
    const result = await resolveLatestRevForDate(
      options.draftRoot,
      input.targetDate
    );

    if (!result) {
      io.stderr(
        `No draft found for ${input.targetDate}. Run \`uncommitted generate --date ${input.targetDate}\` first.`
      );
      return 1;
    }

    targetDate = input.targetDate;
    revision = result.revision;
    outputDir = result.outputDir;
  } else {
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
  }

  // 3. Read story.json for formatName / activityLevel
  const storyMeta = await readStoryMeta(outputDir);

  // 4. Display draft metadata
  io.stdout(`Draft: ${targetDate} / ${revision}`);

  if (storyMeta.formatName) {
    io.stdout(`Format: ${storyMeta.formatName}`);
  }

  if (storyMeta.activityLevel) {
    io.stdout(`Activity Level: ${storyMeta.activityLevel}`);
  }

  io.stdout("");

  // 5. Collect feedback — either non-interactive or interactive
  let record: FeedbackRecord;
  const createdAt = options.now ? options.now() : new Date().toISOString();

  if (options.nonInteractive) {
    const ni = options.nonInteractive;
    record = {
      date: targetDate,
      revision,
      formatName: storyMeta.formatName ?? "",
      fun: clampScore(ni.fun!),
      share: clampScore(ni.share!),
      accuracy: clampScore(ni.accuracy!),
      safetyConcern: ni.safetyConcern ?? false,
      wouldPost: ni.wouldPost ?? false,
      reasons: (ni.reasons ?? []).filter(isFeedbackReason) as FeedbackReason[],
      note: ni.note ?? "",
      createdAt
    };

    const confirmOverwrite = ni.yes ? async () => true : options.prompter.confirmOverwrite;
    await saveFeedback(record, outputDir, options.evalsDir, { confirmOverwrite });
  } else {
    const scores = await options.prompter.askScores();
    const booleans = await options.prompter.askBooleans();
    const reasons = await options.prompter.askReasons();
    const note = await options.prompter.askNote();

    record = {
      date: targetDate,
      revision,
      formatName: storyMeta.formatName ?? "",
      fun: clampScore(scores.fun),
      share: clampScore(scores.share),
      accuracy: clampScore(scores.accuracy),
      safetyConcern: booleans.safetyConcern,
      wouldPost: booleans.wouldPost,
      reasons: reasons.filter(isFeedbackReason) as FeedbackReason[],
      note,
      createdAt
    };

    await saveFeedback(record, outputDir, options.evalsDir, {
      confirmOverwrite: options.prompter.confirmOverwrite
    });
  }

  io.stdout(`\nFeedback saved for ${targetDate} / ${revision}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate non-interactive input. Returns an error string if invalid, else null.
 */
function validateNonInteractiveInput(ni: NonInteractiveInput): string | null {
  if (ni.fun === undefined || ni.fun === null) {
    return "--fun is required in non-interactive mode. Pass --fun 1-5.";
  }

  if (!isValidScore(ni.fun)) {
    return `--fun must be an integer between 1 and 5, got: ${String(ni.fun)}`;
  }

  if (ni.share === undefined || ni.share === null) {
    return "--share is required in non-interactive mode. Pass --share 1-5.";
  }

  if (!isValidScore(ni.share)) {
    return `--share must be an integer between 1 and 5, got: ${String(ni.share)}`;
  }

  if (ni.accuracy === undefined || ni.accuracy === null) {
    return "--accuracy is required in non-interactive mode. Pass --accuracy 1-5.";
  }

  if (!isValidScore(ni.accuracy)) {
    return `--accuracy must be an integer between 1 and 5, got: ${String(ni.accuracy)}`;
  }

  if (ni.reasons) {
    for (const reason of ni.reasons) {
      if (!isFeedbackReason(reason)) {
        return `Invalid reason: "${reason}". Valid reasons: ${FEEDBACK_REASONS.join(", ")}`;
      }
    }
  }

  return null;
}

type RevisionResult = {
  revision: string;
  outputDir: string;
};

/**
 * Find the highest revision under draftRoot/targetDate/.
 * Returns null if no revisions exist.
 */
async function resolveLatestRevForDate(
  draftRoot: string,
  targetDate: string
): Promise<RevisionResult | null> {
  const dateDir = join(draftRoot, targetDate);

  try {
    const entries = await readdir(dateDir);
    const revisions = entries
      .filter((e) => /^rev-\d{3}$/.test(e))
      .sort((a, b) => b.localeCompare(a)); // descending

    if (revisions.length === 0) {
      return null;
    }

    const revision = revisions[0];
    return { revision, outputDir: join(dateDir, revision) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
