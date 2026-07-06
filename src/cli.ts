#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectGitForRegisteredProjects,
  CollectGitCommandError
} from "./collect-git-command.js";
import {
  collectClaudeForRegisteredProjects,
  CollectClaudeCommandError
} from "./collect-claude-command.js";
import {
  collectCodexForRegisteredProjects,
  CollectCodexCommandError
} from "./collect-codex-command.js";
import {
  collectGitHubForRegisteredProjects,
  CollectGitHubCommandError
} from "./collect-github-command.js";
import { AiGenerationError, type AiProvider } from "./ai-provider.js";
import { commands, isKnownCommand } from "./commands.js";
import { formatDoctorReport, runDoctorCommand } from "./doctor-command.js";
import {
  GenerateCommandError,
  runGenerateCommand
} from "./generate-command.js";
import { runInitCommand } from "./init-command.js";
import {
  listManualNotes,
  type ManualNoteEvent,
  NoteCommandError,
  recordManualNote
} from "./note-command.js";
import { addProject, ProjectAddError } from "./project-add.js";
import {
  listProjects,
  ProjectRegistryError,
  removeProject,
  type ProjectRecord
} from "./project-registry.js";
import { resolveConfigPaths } from "./config-paths.js";
import {
  loadGlobalConfig,
  selectDraftRoot,
  selectScheduleTime
} from "./global-config.js";
import {
  loadSourceConfig,
  SourceConfigError,
  type SourceName
} from "./source-config.js";
import {
  runCollectAll,
  type CollectInvokerMap
} from "./collect-all.js";
import {
  ExportCommandError,
  runExportCommand
} from "./export-command.js";
import {
  RenderCommandError,
  runRenderCommand
} from "./render-command.js";
import {
  loadDraftPreviewForRevision,
  loadLatestDraftPreview
} from "./preview-loader.js";
import { formatPreview } from "./preview-formatter.js";
import {
  RevisionFormatError,
  resolveLatestRevForDate,
  resolveSpecificRev
} from "./draft-revision-resolver.js";
import {
  buildLaunchAgentPlist,
  captureProviderEnv,
  installScheduler,
  SchedulerExecutablePathError,
  type LaunchctlExecutor,
  type LaunchctlRawRunner
} from "./scheduler.js";
import { runScheduleStatus } from "./schedule-status-command.js";
import { runScheduleRemove } from "./schedule-remove-command.js";
import { persistGitHubTokenForSchedule } from "./schedule-github-token.js";
import {
  createReadlinePrompter,
  runFeedbackCommand,
  type FeedbackPrompter
} from "./feedback-command.js";
import type { CarouselHtmlToPngRenderer } from "./carousel-renderer.js";
import type { ImageAssetProvider } from "./visual-assets.js";
import { isRecord } from "./type-guards.js";

/**
 * Thrown by readPreviewDraftRoot when config.json is unreadable, malformed,
 * or has an unsupported schemaVersion. Task 3's exit-code mapper recognises
 * this via `code === "config-corruption"`.
 */
export class PreviewConfigError extends Error {
  readonly code = "config-corruption" as const;

  constructor(message: string) {
    super(message);
    this.name = "PreviewConfigError";
  }
}

/**
 * Returns true for any config-corruption error regardless of which reader
 * produced it. Recognises both `SourceConfigError` (by class) and the
 * `code === "config-corruption"` tag carried by `GitHubTokenConfigError`
 * and `PreviewConfigError` — avoiding hard imports of those classes here.
 */
function isConfigCorruptionError(error: unknown): boolean {
  if (error instanceof SourceConfigError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "config-corruption"
  );
}

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type CliOptions = {
  cwd?: string;
  homeDir?: string;
  claudeHome?: string;
  codexHome?: string;
  draftRoot?: string;
  now?: () => string;
  aiProvider?: AiProvider;
  imageAssetProvider?: ImageAssetProvider;
  carouselRenderer?: CarouselHtmlToPngRenderer;
  schedulerExecutor?: LaunchctlExecutor;
  /** Injectable structured launchctl runner for status/remove (tests). */
  schedulerRunner?: LaunchctlRawRunner;
  /**
   * Executable path recorded into the launchd plist by `schedule install`.
   * When omitted, `process.argv[1]` is used as the last-resort candidate and
   * validated — under vitest/worktrees it points at an ephemeral worker
   * script, which must never reach the plist (UNC-190).
   */
  schedulerExecutablePath?: string;
  /** Injectable prompter for feedback command (tests). */
  feedbackPrompter?: FeedbackPrompter;
  /**
   * Injectable per-source collect invokers used by `collect all` orchestration.
   * Tests stub these to force success/failure deterministically without
   * exercising the live per-source collectors.
   */
  collectInvokers?: Partial<CollectInvokerMap>;
};

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message)
};

export function getHelpText(): string {
  const commandList = commands
    .map((command) => `  ${command.name.padEnd(10)} ${command.summary}`)
    .join("\n");

  return `Usage: uncommitted <command> [options]

Local-first AI coworker diary drafts from Git activity and manual notes.

Commands:
${commandList}

Options:
  -h, --help  Show help.
`;
}

export async function runCli(
  args: string[],
  io: CliIo = defaultIo,
  options: CliOptions = {}
): Promise<number> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...commandArgs] = normalizedArgs;

  if (!command || command === "--help" || command === "-h") {
    io.stdout(getHelpText());
    return 0;
  }

  if (!isKnownCommand(command)) {
    io.stderr(`Unknown command: ${command}`);
    io.stderr("Run `uncommitted --help`.");
    return 1;
  }

  if (command === "init") {
    try {
      const result = await runInitCommand(commandArgs);
      io.stdout("Initialized Uncommitted config.");
      for (const line of result.guidance) {
        io.stdout(line);
      }
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : "Init failed.");
      return 1;
    }
  }

  if (command === "doctor") {
    const result = await runDoctorCommand(options);
    io.stdout(formatDoctorReport(result.report));
    return result.exitCode;
  }

  // Central config-corruption mapper: any reader that throws a config-corruption
  // error (GitHubTokenConfigError, PreviewConfigError, SourceConfigError) is
  // caught here and converted to exit 2 + unified message. Non-config errors
  // are rethrown so per-command handlers remain intact.
  try {
    const [subcommand, value] = commandArgs;

    if (command === "project" && subcommand === "add") {
      return await runProjectAdd(value, io, options);
    }

    if (command === "project" && subcommand === "list") {
      return await runProjectList(commandArgs.slice(1), io, options);
    }

    if (command === "project" && subcommand === "remove") {
      return await runProjectRemove(value, commandArgs.slice(2), io, options);
    }

    if (command === "note") {
      return await runNote(commandArgs, io, options);
    }

    if (command === "collect") {
      return await runCollect(commandArgs, io, options);
    }

    if (command === "generate") {
      return await runGenerate(commandArgs, io, options);
    }

    if (command === "render") {
      return await runRender(commandArgs, io, options);
    }

    if (command === "preview") {
      return await runPreview(commandArgs, io, options);
    }

    if (command === "export") {
      return await runExport(commandArgs, io, options);
    }

    if (command === "schedule") {
      return await runSchedule(commandArgs, io, options);
    }

    if (command === "feedback") {
      return await runFeedback(commandArgs, io, options);
    }

    io.stderr(`Command not implemented yet: ${command}`);
    return 1;
  } catch (error) {
    if (isConfigCorruptionError(error)) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
    throw error;
  }
}

async function runSchedule(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  const [subcommand, ...subcommandArgs] = args;

  if (subcommand === "install") {
    let scheduleTime: string | undefined;

    for (let i = 0; i < subcommandArgs.length; i++) {
      if (subcommandArgs[i] === "--time" && i + 1 < subcommandArgs.length) {
        scheduleTime = subcommandArgs[i + 1];
        i++;
      } else {
        // Reject malformed/unknown arguments outright: only a genuinely
        // argument-free invocation may fall back to config.scheduleTime,
        // otherwise a typo would silently reschedule with the stored time.
        if (subcommandArgs[i] !== "--time") {
          io.stderr(`Unknown argument: ${subcommandArgs[i]}`);
        }
        io.stderr("Usage: uncommitted schedule install --time HH:mm");
        return 1;
      }
    }

    if (!scheduleTime) {
      // --time omitted entirely: fall back to config.scheduleTime so the value
      // the user set at `init` is actually honored instead of being write-only.
      const configFile = resolveConfigPaths({
        homeDir: options.homeDir
      }).configFile;
      const outcome = await loadGlobalConfig(configFile);
      if (outcome.status === "ok") {
        scheduleTime = selectScheduleTime(outcome.value);
      }
    }

    if (!scheduleTime) {
      io.stderr("Usage: uncommitted schedule install --time HH:mm");
      return 1;
    }

    if (process.platform !== "darwin") {
      io.stderr("macOS is required to install the scheduler.");
      return 1;
    }

    try {
      const executablePath =
        options.schedulerExecutablePath ?? realpathSync.native(process.argv[1]);
      const plist = buildLaunchAgentPlist({
        homeDir: options.homeDir,
        scheduleTime,
        executablePath,
        environmentVariables: captureProviderEnv()
      });

      await installScheduler(plist, {
        homeDir: options.homeDir,
        executor: options.schedulerExecutor
      });

      io.stdout(`Installed macOS schedule for ${scheduleTime}.`);
      io.stdout(`Plist path: ${plist.plistPath}`);

      const tokenPersistResult = await persistGitHubTokenForSchedule({
        homeDir: options.homeDir
      });
      if (tokenPersistResult.persisted) {
        io.stdout(
          "Saved GITHUB_TOKEN to config for scheduled GitHub collection (not written to the launchd plist)."
        );
      }

      return 0;
    } catch (error) {
      if (error instanceof SchedulerExecutablePathError) {
        io.stderr(error.message);
        return 2;
      }
      io.stderr(error instanceof Error ? error.message : "Schedule install failed.");
      return 1;
    }
  }

  if (subcommand === "status") {
    if (subcommandArgs.length !== 0) {
      io.stderr("Usage: uncommitted schedule status");
      return 1;
    }

    const result = await runScheduleStatus({
      homeDir: options.homeDir,
      runner: options.schedulerRunner
    });

    if (!result.installed) {
      io.stdout("Scheduler: not installed");
      io.stdout(`Plist path: ${result.plistPath}`);
      return 0;
    }

    const loadedLabel =
      result.loaded === true
        ? "loaded"
        : result.loaded === false
          ? "not loaded"
          : "unknown (launchctl unavailable)";

    io.stdout(`Scheduler: installed, ${loadedLabel}`);
    io.stdout(`Plist path: ${result.plistPath}`);

    // Surface the stored config time vs the actual installed launchd time.
    // Degrade gracefully: only compare when both are readable.
    const configFile = resolveConfigPaths({ homeDir: options.homeDir }).configFile;
    const configOutcome = await loadGlobalConfig(configFile);
    const configScheduleTime =
      configOutcome.status === "ok"
        ? selectScheduleTime(configOutcome.value)
        : undefined;
    const installedScheduleTime = result.installedScheduleTime;

    if (
      configScheduleTime !== undefined &&
      installedScheduleTime !== undefined &&
      configScheduleTime !== installedScheduleTime
    ) {
      io.stdout(`Installed schedule time: ${installedScheduleTime}`);
      io.stdout(`Config schedule time: ${configScheduleTime}`);
      io.stdout(
        "Warning: installed schedule time diverges from config.scheduleTime. " +
          "Run `uncommitted schedule install` to realign."
      );
    } else if (installedScheduleTime !== undefined) {
      io.stdout(`Schedule time: ${installedScheduleTime}`);
    } else if (configScheduleTime !== undefined) {
      io.stdout(`Schedule time: ${configScheduleTime} (from config)`);
    }

    if (result.launchctlError) {
      io.stderr(`launchctl: ${result.launchctlError}`);
    }

    return 0;
  }

  if (subcommand === "run-now") {
    if (subcommandArgs.length !== 0) {
      io.stderr("Usage: uncommitted schedule run-now");
      return 1;
    }

    const scheduledAt = options.now ? options.now() : new Date().toISOString();
    const targetDate = scheduledAt.slice(0, 10);
    const workflowOptions = {
      ...options,
      now: () => scheduledAt
    };

    // Collect every source enabled in config (git/claude/codex/github), not
    // just git — `collect all` reads sources[*].enabled and isolates per-source
    // failures, so a flaky claude/codex/github collection cannot block the
    // draft as long as one enabled source succeeds.
    const collectExitCode = await runCollect(["all"], io, workflowOptions);

    if (collectExitCode !== 0) {
      return collectExitCode;
    }

    const generateExitCode = await runGenerate(
      ["--date", targetDate],
      io,
      workflowOptions
    );

    if (generateExitCode !== 0) {
      return generateExitCode;
    }

    return await runRender(["latest"], io, workflowOptions);
  }

  if (subcommand === "remove") {
    if (subcommandArgs.length !== 0) {
      io.stderr("Usage: uncommitted schedule remove");
      return 1;
    }

    const result = await runScheduleRemove({
      homeDir: options.homeDir,
      runner: options.schedulerRunner
    });

    if (!result.removed) {
      io.stderr(result.launchctlError ?? "Schedule remove failed.");
      return 1;
    }

    if (!result.wasInstalled) {
      io.stdout("Scheduler: not installed (nothing to remove).");
      return 0;
    }

    if (result.launchctlError) {
      io.stderr(`launchctl: ${result.launchctlError}`);
    }

    io.stdout("Scheduler removed.");
    io.stdout(`Deleted: ${result.plistPath}`);
    return 0;
  }

  io.stderr("Usage: uncommitted schedule <install|status|remove|run-now> [options]");
  return 1;
}

async function runRender(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  try {
    const result = await runRenderCommand(args, {
      homeDir: options.homeDir,
      renderer: options.carouselRenderer
    });

    io.stdout(`Rendered carousel for ${result.targetDate}: ${result.outputDir}`);
    io.stdout(`Carousel files: ${result.carouselDir}`);
    return 0;
  } catch (error) {
    if (error instanceof RenderCommandError) {
      io.stderr(error.message);

      if (error.code === "invalid-arguments") {
        return 1;
      }

      if (error.code === "invalid-config") {
        return 2;
      }

      if (error.code === "safety-blocked") {
        return 6;
      }

      return 5;
    }

    throw error;
  }
}

const PREVIEW_USAGE =
  "Usage: uncommitted preview latest | uncommitted preview --date YYYY-MM-DD [--rev rev-NNN]";

async function runPreview(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  // Backward-compat path: `preview latest` (no flags).
  if (args.length === 1 && args[0] === "latest") {
    const paths = resolveConfigPaths({ homeDir: options.homeDir });
    const draftRoot = await readPreviewDraftRoot(paths.configFile, options.homeDir);
    const result = await loadLatestDraftPreview(draftRoot);

    if (result.outcome === "success") {
      io.stdout(formatPreview(result));
      return 0;
    }

    io.stderr(formatPreview(result));
    return 1;
  }

  // New path: `preview --date YYYY-MM-DD [--rev rev-NNN]`.
  // Parse flags + reject any other positional (including "latest" mixed with flags).
  let targetDate: string | undefined;
  let revision: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--date") {
      const value = args[i + 1];
      // Reject a missing value or an adjacent flag (e.g. `--date --rev`),
      // which would otherwise be consumed as the value and fail later with a
      // confusing format error. No valid date starts with "--".
      if (value === undefined || value.startsWith("--")) {
        io.stderr(`--date requires a value (YYYY-MM-DD). ${PREVIEW_USAGE}`);
        return 1;
      }
      targetDate = value;
      i++;
      continue;
    }
    if (arg === "--rev") {
      const value = args[i + 1];
      // Same guard as --date: a following flag is not a valid rev-NNN value.
      if (value === undefined || value.startsWith("--")) {
        io.stderr(`--rev requires a value (rev-NNN). ${PREVIEW_USAGE}`);
        return 1;
      }
      revision = value;
      i++;
      continue;
    }
    // Any other token (including "latest" combined with flags, or unknown positionals).
    io.stderr(PREVIEW_USAGE);
    return 1;
  }

  if (targetDate === undefined) {
    io.stderr(`--date is required when not using \`preview latest\`. ${PREVIEW_USAGE}`);
    return 1;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    io.stderr(`--date must be in YYYY-MM-DD format, got: ${targetDate}`);
    return 1;
  }

  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const draftRoot = await readPreviewDraftRoot(paths.configFile, options.homeDir);

  let resolved: { revision: string; outputDir: string } | null;
  try {
    if (revision === undefined) {
      resolved = await resolveLatestRevForDate(draftRoot, targetDate);
    } else {
      resolved = await resolveSpecificRev(draftRoot, targetDate, revision);
    }
  } catch (error) {
    if (error instanceof RevisionFormatError) {
      io.stderr(`${error.message} ${PREVIEW_USAGE}`);
      return 1;
    }
    throw error;
  }

  if (resolved === null) {
    if (revision === undefined) {
      io.stderr(`No draft found for ${targetDate}.`);
    } else {
      io.stderr(`No draft ${revision} found for ${targetDate}.`);
    }
    return 1;
  }

  const result = await loadDraftPreviewForRevision(
    draftRoot,
    resolved.outputDir,
    targetDate,
    resolved.revision
  );

  if (result.outcome === "success") {
    io.stdout(formatPreview(result));
    return 0;
  }

  io.stderr(formatPreview(result));
  return 1;
}

async function readPreviewDraftRoot(
  configFile: string,
  homeDir: string | undefined
): Promise<string> {
  const outcome = await loadGlobalConfig(configFile);

  // Preview is best-effort: a missing config falls back to the default draft
  // root, but an unreadable or malformed config surfaces a typed error.
  if (outcome.status === "read-error" || outcome.status === "parse-error") {
    throw new PreviewConfigError(
      `Config error: ${configFile} is unreadable or malformed. Fix or remove the file.`
    );
  }

  if (outcome.status === "ok") {
    // Guard: a valid-JSON config must be a record with schemaVersion 1. A
    // non-record (e.g. `[]`, `42`, `null`) or an unsupported schemaVersion is
    // corruption, not a default-fallback case — surface it rather than
    // silently previewing from the wrong root.
    if (!isRecord(outcome.value) || outcome.value.schemaVersion !== 1) {
      throw new PreviewConfigError(
        `Config error: ${configFile} is unreadable or malformed. Fix or remove the file.`
      );
    }
    const draftRoot = selectDraftRoot(outcome.value);
    if (draftRoot !== undefined) {
      return resolveConfigPaths({ homeDir, draftRoot }).defaultDraftRoot;
    }
  }

  return resolveConfigPaths({ homeDir }).defaultDraftRoot;
}

const FEEDBACK_HELP_TEXT = `Usage: uncommitted feedback <latest|report> [options]

Subcommands:
  latest          Record feedback for the latest draft (default if omitted).
  report          Print an aggregate feedback report.

Options:
  --date <YYYY-MM-DD>   Target a specific draft date (latest revision under that date).
  --days <N>            For report: number of days to aggregate (default 7).
  --fun <1-5>           Non-interactive: Fun score.
  --share <1-5>         Non-interactive: Share score.
  --accuracy <1-5>      Non-interactive: Accuracy score.
  --safety-concern      Non-interactive: mark safety concern.
  --would-post          Non-interactive: would post to Instagram.
  --reasons <a,b>       Non-interactive: comma-separated reason slugs.
  --note "..."          Non-interactive: free-form note.
  --yes, -y             Non-interactive: auto-confirm overwrites.
  -h, --help            Show this help.
`;

async function runFeedback(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(FEEDBACK_HELP_TEXT);
    return 0;
  }

  // Parse args: `feedback [latest|report] [--date YYYY-MM-DD] [--days N]
  //   [--fun N] [--share N] [--accuracy N] [--would-post] [--safety-concern]
  //   [--reasons a,b] [--note "..."] [--yes]`
  const [maybeSubcommand, ...rest] = args;
  const subcommand =
    maybeSubcommand && !maybeSubcommand.startsWith("-")
      ? maybeSubcommand
      : "latest";
  const flagArgs = maybeSubcommand?.startsWith("-")
    ? [maybeSubcommand, ...rest]
    : rest;

  let targetDate: string | undefined;
  let days: number | undefined;
  let fun: number | undefined;
  let share: number | undefined;
  let accuracy: number | undefined;
  let safetyConcern: boolean | undefined;
  let wouldPost: boolean | undefined;
  let reasons: string[] | undefined;
  let note: string | undefined;
  let yes = false;
  let hasNonInteractiveFlag = false;

  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];

    if (flag === "--date" && i + 1 < flagArgs.length) {
      targetDate = flagArgs[++i];
    } else if (flag === "--days" && i + 1 < flagArgs.length) {
      const rawDays = flagArgs[++i];
      const parsedDays = parseInt(rawDays, 10);
      if (!Number.isInteger(parsedDays) || parsedDays < 1) {
        io.stderr(`--days must be a positive integer, got: ${rawDays}`);
        return 1;
      }
      days = parsedDays;
    } else if (flag === "--fun" && i + 1 < flagArgs.length) {
      fun = Number(flagArgs[++i]);
      hasNonInteractiveFlag = true;
    } else if (flag === "--share" && i + 1 < flagArgs.length) {
      share = Number(flagArgs[++i]);
      hasNonInteractiveFlag = true;
    } else if (flag === "--accuracy" && i + 1 < flagArgs.length) {
      accuracy = Number(flagArgs[++i]);
      hasNonInteractiveFlag = true;
    } else if (flag === "--would-post") {
      wouldPost = true;
      hasNonInteractiveFlag = true;
    } else if (flag === "--safety-concern") {
      safetyConcern = true;
      hasNonInteractiveFlag = true;
    } else if (flag === "--reasons" && i + 1 < flagArgs.length) {
      reasons = flagArgs[++i].split(",").map((r) => r.trim()).filter(Boolean);
      hasNonInteractiveFlag = true;
    } else if (flag === "--note" && i + 1 < flagArgs.length) {
      note = flagArgs[++i];
      hasNonInteractiveFlag = true;
    } else if (flag === "--yes" || flag === "-y") {
      yes = true;
      hasNonInteractiveFlag = true;
    }
  }

  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const draftRoot = options.draftRoot ?? await readPreviewDraftRoot(paths.configFile, options.homeDir);
  const evalsDir = paths.evalsDir;
  // Only create readline for 'latest'; 'report' never uses interactive prompts
  const prompter = options.feedbackPrompter ?? (subcommand === "latest" ? createReadlinePrompter() : {
    askScores: async (): Promise<never> => { throw new Error("prompter not available"); },
    askBooleans: async (): Promise<never> => { throw new Error("prompter not available"); },
    askReasons: async (): Promise<never> => { throw new Error("prompter not available"); },
    askNote: async (): Promise<never> => { throw new Error("prompter not available"); },
    confirmOverwrite: async (): Promise<never> => { throw new Error("prompter not available"); },
  });

  try {
    return await runFeedbackCommand(
      { subcommand, targetDate, days },
      io,
      {
        draftRoot,
        evalsDir,
        prompter,
        nonInteractive: hasNonInteractiveFlag
          ? { fun, share, accuracy, safetyConcern, wouldPost, reasons, note, yes }
          : undefined
      }
    );
  } finally {
    prompter.close?.();
  }
}

async function runExport(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const draftRoot = options.draftRoot ?? paths.defaultDraftRoot;

  try {
    const result = await runExportCommand(args, {
      draftRoot,
      now: options.now
    });

    if (result.warningMessage) {
      io.stderr(result.warningMessage);
    }

    io.stdout(`Exported to: ${result.exportDir}`);
    io.stdout(`Files: ${result.exportedFiles.join(", ")}`);
    io.stdout("Re-running export overwrites this folder. Source draft is never modified.");
    return 0;
  } catch (error) {
    if (error instanceof ExportCommandError) {
      io.stderr(error.message);

      if (error.code === "invalid-arguments") {
        return 1;
      }

      if (error.code === "invalid-config") {
        return 2;
      }

      if (error.code === "missing-draft") {
        return 1;
      }

      if (error.code === "missing-carousel") {
        return 5;
      }

      if (error.code === "safety-blocked") {
        return 6;
      }

      return 1;
    }

    throw error;
  }
}

async function runGenerate(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  try {
    const result = await runGenerateCommand(args, options);

    if (result.safetyReport.status === "warning") {
      io.stderr(`Safety warning: ${result.safetyReport.message}`);
    }

    io.stdout(`Generated text draft for ${result.targetDate}: ${result.outputDir}`);
    return 0;
  } catch (error) {
    if (error instanceof GenerateCommandError) {
      io.stderr(error.message);
      if (error.code === "invalid-arguments") {
        return 1;
      }

      if (error.code === "invalid-data") {
        return 3;
      }

      if (error.code === "safety-blocked") {
        return 6;
      }

      if (error.code === "visual-generation-failed") {
        return 5;
      }

      return 2;
    }

    if (error instanceof AiGenerationError) {
      io.stderr(error.message);
      return 4;
    }

    throw error;
  }
}

/**
 * Parse the optional `--date YYYY-MM-DD` argv shared by `collect codex` and
 * `collect github`. Rejects a dangling `--date` (would otherwise fall back to
 * today and overwrite events) and any unknown token. Emits the usage error to
 * stderr and returns `{ error: true }` on failure.
 */
function parseCollectDateArgs(
  args: string[],
  source: "codex" | "github",
  io: CliIo
): { targetDate?: string; error: boolean } {
  const usage = `Usage: uncommitted collect ${source} [--date YYYY-MM-DD]`;
  let targetDate: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date") {
      if (i + 1 >= args.length) {
        io.stderr(usage);
        return { error: true };
      }
      targetDate = args[++i];
      continue;
    }
    io.stderr(usage);
    return { error: true };
  }
  return { targetDate, error: false };
}

async function runCollect(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (
    args.length < 1 ||
    (args[0] !== "git" &&
      args[0] !== "claude" &&
      args[0] !== "codex" &&
      args[0] !== "github" &&
      args[0] !== "all")
  ) {
    io.stderr("Usage: uncommitted collect <git|claude|codex|github|all>");
    return 1;
  }

  // `all` orchestrates every enabled source with failure isolation; reject
  // trailing tokens so a typo (e.g. `collect all --date ...`) can't be
  // silently ignored.
  if (args[0] === "all") {
    if (args.length > 1) {
      io.stderr("Usage: uncommitted collect all");
      return 1;
    }
    return await runCollectAllCommand(io, options);
  }

  // git and claude take no further arguments; reject trailing tokens so an
  // unsupported flag can't silently collect/overwrite today's events.
  if ((args[0] === "git" || args[0] === "claude") && args.length > 1) {
    io.stderr(`Usage: uncommitted collect ${args[0]}`);
    return 1;
  }

  const source = args[0] as SourceName;

  // codex and github accept `--date`; validate their argv BEFORE consulting
  // config so a typo (e.g. `collect codex --date`, `collect github --bogus`) is
  // rejected even when the source is disabled — matching the enabled path.
  let codexTargetDate: string | undefined;
  let ghTargetDate: string | undefined;
  if (source === "codex" || source === "github") {
    const parsed = parseCollectDateArgs(args.slice(1), source, io);
    if (parsed.error) {
      return 1;
    }
    if (source === "codex") {
      codexTargetDate = parsed.targetDate;
    } else {
      ghTargetDate = parsed.targetDate;
    }
  }

  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const sourceConfig = await loadSourceConfig(paths.configFile);
  if (!sourceConfig[source].enabled) {
    io.stdout(
      `Source '${source}' is disabled in config; skipping collection.`
    );
    return 0;
  }

  if (args[0] === "git") {
    try {
      const result = await collectGitForRegisteredProjects(options);

      if (result.successes.length > 0) {
        io.stdout(`Collected Git activity for ${formatProjectCount(result.successes.length)}.`);

        for (const success of result.successes) {
          io.stdout(
            `${success.projectId}: ${success.activity.totals.commits} commits, ${success.activity.dirty.files.length} dirty files.`
          );
        }
      }

      for (const failure of result.failures) {
        io.stderr(`Failed to collect ${failure.projectId}: ${failure.message}`);
      }

      return result.failures.length > 0 ? 3 : 0;
    } catch (error) {
      if (error instanceof CollectGitCommandError) {
        io.stderr(error.message);
        return error.code === "invalid-projects-file" ? 2 : 3;
      }

      throw error;
    }
  }

  if (args[0] === "claude") {
    try {
      const result = await collectClaudeForRegisteredProjects(options);

      if (result.claudeLogsMissing) {
        io.stdout("No Claude session logs found at ~/.claude/projects. Skipping.");
        return 0;
      }

      if (result.successes.length > 0) {
        io.stdout(
          `Collected Claude activity for ${formatProjectCount(result.successes.length)}.`
        );
        for (const success of result.successes) {
          io.stdout(
            `${success.projectId}: ${success.signalCount} signals, ${success.conversationCount} turns, ${success.toolFactCount} tool facts.`
          );
        }
      }

      for (const failure of result.failures) {
        io.stderr(`Failed to collect ${failure.projectId}: ${failure.message}`);
      }

      return result.failures.length > 0 ? 3 : 0;
    } catch (error) {
      if (error instanceof CollectClaudeCommandError) {
        io.stderr(error.message);
        return error.code === "invalid-projects-file" ? 2 : 3;
      }
      throw error;
    }
  }

  if (args[0] === "codex") {
    try {
      const result = await collectCodexForRegisteredProjects({
        homeDir: options.homeDir,
        codexHome: options.codexHome,
        now: options.now ?? (() => new Date().toISOString()),
        targetDate: codexTargetDate
      });

      if (result.codexLogsMissing) {
        io.stdout("No Codex session logs found at ~/.codex/sessions. Skipping.");
        return 0;
      }

      if (result.successes.length > 0) {
        io.stdout(
          `Collected Codex activity for ${formatProjectCount(result.successes.length)}.`
        );
        for (const success of result.successes) {
          io.stdout(
            `${success.projectId}: ${success.signalCount} signals, ${success.conversationCount} turns, ${success.toolFactCount} tool facts.`
          );
        }
      }

      for (const failure of result.failures) {
        io.stderr(`Failed to collect ${failure.projectId}: ${failure.message}`);
      }

      return result.failures.length > 0 ? 3 : 0;
    } catch (error) {
      if (error instanceof CollectCodexCommandError) {
        io.stderr(error.message);
        return error.code === "invalid-projects-file" ||
          error.code === "invalid-date"
          ? 2
          : 3;
      }
      throw error;
    }
  }

  if (args[0] === "github") {
    try {
      const result = await collectGitHubForRegisteredProjects({
        homeDir: options.homeDir,
        targetDate: ghTargetDate,
        now: options.now ?? (() => new Date().toISOString())
      });

      if (result.successes.length > 0) {
        io.stdout(
          `Collected GitHub activity for ${formatProjectCount(result.successes.length)}.`
        );
        for (const success of result.successes) {
          io.stdout(
            `${success.projectId}: ${success.signalCount} signals, ${success.rawCount} authored bodies.`
          );
        }
      }
      for (const skip of result.skippedProjects) {
        io.stdout(`${skip.projectId}: skipped (non-GitHub remote).`);
      }
      for (const failure of result.failures) {
        io.stderr(`Failed to collect ${failure.projectId}: ${failure.message}`);
      }
      return result.failures.length > 0 ? 3 : 0;
    } catch (error) {
      if (error instanceof CollectGitHubCommandError) {
        io.stderr(error.message);
        if (error.code === "invalid-projects-file") return 2;
        if (error.code === "no-token") return 2;
        if (error.code === "invalid-date") return 2;
        return 3;
      }
      throw error;
    }
  }

  return 1;
}

async function runCollectAllCommand(
  io: CliIo,
  options: CliOptions
): Promise<number> {
  const summary = await runCollectAll({
    homeDir: options.homeDir,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    now: options.now,
    collectInvokers: options.collectInvokers
  });

  const enabledEntries = summary.entries.filter(
    (entry) => entry.status !== "disabled"
  );

  if (enabledEntries.length === 0) {
    io.stdout("collect all: no sources enabled in config; nothing to do.");
  }

  for (const entry of summary.entries) {
    if (entry.status === "disabled") {
      io.stdout(`Source '${entry.source}': disabled`);
      continue;
    }
    if (entry.status === "success") {
      io.stdout(`Source '${entry.source}': success (${entry.detail})`);
      continue;
    }
    io.stdout(`Source '${entry.source}': failed (${entry.detail})`);
  }

  return summary.exitCode;
}

async function runNote(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (args[0] === "list") {
    if (args.length !== 1) {
      io.stderr("Usage: uncommitted note list");
      return 1;
    }

    return await runNoteList(io, options);
  }

  try {
    const result = await recordManualNote(args, options);

    io.stdout(`Note saved for ${result.event.date}.`);
    return 0;
  } catch (error) {
    if (error instanceof NoteCommandError) {
      io.stderr(error.message);
      return error.code === "empty-note" ? 1 : 2;
    }

    throw error;
  }
}

async function runNoteList(
  io: CliIo,
  options: CliOptions
): Promise<number> {
  try {
    const result = await listManualNotes(options);

    if (result.notes.length === 0) {
      io.stdout("No manual notes found.");
      return 0;
    }

    io.stdout("Manual notes (newest first):");

    for (const note of result.notes) {
      io.stdout(formatManualNote(note));
    }

    return 0;
  } catch (error) {
    if (error instanceof NoteCommandError) {
      io.stderr(error.message);
      return error.code === "malformed-note-data" ? 1 : 2;
    }

    throw error;
  }
}

function formatManualNote(note: ManualNoteEvent): string {
  const displayTimestamp = note.timestamp.replace("T", " ").slice(0, 16);

  return `${displayTimestamp} ${note.text}`;
}

function formatProjectCount(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"}`;
}

async function runProjectAdd(
  path: string | undefined,
  io: CliIo,
  options: CliOptions
): Promise<number> {
  try {
    const result = await addProject(path ?? ".", options);

    if (result.status === "already-registered") {
      io.stdout(`Project already registered: ${result.project.id}`);
    } else {
      io.stdout(`Project registered: ${result.project.id}`);
    }

    io.stdout(result.project.root);
    return 0;
  } catch (error) {
    if (error instanceof ProjectAddError) {
      io.stderr(error.message);
      return 2;
    }

    throw error;
  }
}

async function runProjectList(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (args.length !== 0) {
    io.stderr("Usage: uncommitted project list");
    return 1;
  }

  try {
    const result = await listProjects(options);

    if (result.projects.length === 0) {
      io.stdout("No registered projects. Run `uncommitted project add .` first.");
      return 0;
    }

    io.stdout("Registered projects:");

    for (const project of result.projects) {
      io.stdout(formatProject(project));
    }

    return 0;
  } catch (error) {
    if (error instanceof ProjectRegistryError) {
      io.stderr(error.message);
      return 2;
    }

    throw error;
  }
}

async function runProjectRemove(
  projectId: string | undefined,
  extraArgs: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (!projectId || extraArgs.length !== 0) {
    io.stderr("Usage: uncommitted project remove <project-id>");
    return 1;
  }

  try {
    const result = await removeProject(projectId, options);

    io.stdout(`Project removed: ${result.removedProject.id}`);
    io.stdout(result.removedProject.root);
    return 0;
  } catch (error) {
    if (error instanceof ProjectRegistryError) {
      io.stderr(error.message);
      return 2;
    }

    throw error;
  }
}

function formatProject(project: ProjectRecord): string {
  const status = project.enabled ? "enabled" : "disabled";

  return [
    project.id,
    project.name,
    project.gitRoot,
    status,
    project.createdAt
  ].join("\t");
}

export function isDirectRun(
  entrypoint: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url
): boolean {
  if (!entrypoint) {
    return false;
  }

  return (
    pathToFileURL(realpathSync.native(entrypoint)).href ===
    pathToFileURL(realpathSync.native(fileURLToPath(moduleUrl))).href
  );
}

if (isDirectRun()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
