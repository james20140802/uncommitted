#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
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
  RenderCommandError,
  runRenderCommand
} from "./render-command.js";
import type { CarouselHtmlToPngRenderer } from "./carousel-renderer.js";
import type { ImageAssetProvider } from "./visual-assets.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type CliOptions = {
  cwd?: string;
  homeDir?: string;
  now?: () => string;
  aiProvider?: AiProvider;
  imageAssetProvider?: ImageAssetProvider;
  carouselRenderer?: CarouselHtmlToPngRenderer;
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

  if (command === "schedule") {
    return await runSchedule(commandArgs, io, options);
  }

  io.stderr(`Command not implemented yet: ${command}`);
  return 1;
}

async function runSchedule(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  if (args.length !== 1 || args[0] !== "run-now") {
    io.stderr("Usage: uncommitted schedule run-now");
    return 1;
  }

  const collectExitCode = await runCollect(["git"], io, options);

  if (collectExitCode !== 0) {
    return collectExitCode;
  }

  const generateExitCode = await runGenerate(["today"], io, options);

  if (generateExitCode !== 0) {
    return generateExitCode;
  }

  return await runRender(["latest"], io, options);
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
