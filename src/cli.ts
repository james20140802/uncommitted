#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectGitForRegisteredProjects,
  CollectGitCommandError
} from "./collect-git-command.js";
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
  ExportCommandError,
  runExportCommand
} from "./export-command.js";
import {
  RenderCommandError,
  runRenderCommand
} from "./render-command.js";
import { loadLatestDraftPreview } from "./preview-loader.js";
import { formatPreview } from "./preview-formatter.js";
import {
  buildLaunchAgentPlist,
  installScheduler,
  type LaunchctlExecutor,
  type LaunchctlRawRunner
} from "./scheduler.js";
import { runScheduleStatus } from "./schedule-status-command.js";
import { runScheduleRemove } from "./schedule-remove-command.js";
import {
  createReadlinePrompter,
  runFeedbackCommand,
  type FeedbackPrompter
} from "./feedback-command.js";
import type { CarouselHtmlToPngRenderer } from "./carousel-renderer.js";
import type { ImageAssetProvider } from "./visual-assets.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type CliOptions = {
  cwd?: string;
  homeDir?: string;
  draftRoot?: string;
  now?: () => string;
  aiProvider?: AiProvider;
  imageAssetProvider?: ImageAssetProvider;
  carouselRenderer?: CarouselHtmlToPngRenderer;
  schedulerExecutor?: LaunchctlExecutor;
  /** Injectable structured launchctl runner for status/remove (tests). */
  schedulerRunner?: LaunchctlRawRunner;
  /** Injectable prompter for feedback command (tests). */
  feedbackPrompter?: FeedbackPrompter;
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
      await runInitCommand(commandArgs);
      io.stdout("Initialized Uncommitted config.");
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
      const executablePath = realpathSync.native(process.argv[1]);
      const plist = buildLaunchAgentPlist({
        homeDir: options.homeDir,
        scheduleTime,
        executablePath
      });

      await installScheduler(plist, {
        homeDir: options.homeDir,
        executor: options.schedulerExecutor
      });

      io.stdout(`Installed macOS schedule for ${scheduleTime}.`);
      io.stdout(`Plist path: ${plist.plistPath}`);
      return 0;
    } catch (error) {
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

    const collectExitCode = await runCollect(["git"], io, workflowOptions);

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

async function runPreview(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  const [subcommand] = args;

  if (subcommand !== "latest" || args.length !== 1) {
    io.stderr("Usage: uncommitted preview latest");
    return 1;
  }

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

async function readPreviewDraftRoot(
  configFile: string,
  homeDir: string | undefined
): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).draftRoot === "string"
    ) {
      return resolveConfigPaths({
        homeDir,
        draftRoot: (parsed as Record<string, unknown>).draftRoot as string
      }).defaultDraftRoot;
    }
  } catch (err) {
    if (!isCliNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
  }
  return resolveConfigPaths({ homeDir }).defaultDraftRoot;
}

async function runFeedback(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
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
      days = parseInt(flagArgs[++i], 10);
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
  const draftRoot = options.draftRoot ?? paths.defaultDraftRoot;
  const evalsDir = paths.evalsDir;
  const prompter = options.feedbackPrompter ?? createReadlinePrompter();

  return runFeedbackCommand(
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
}

function isCliNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

async function runCollect(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (args.length !== 1 || args[0] !== "git") {
    io.stderr("Usage: uncommitted collect git");
    return 1;
  }

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
