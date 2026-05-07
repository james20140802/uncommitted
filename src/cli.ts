#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectGitForRegisteredProjects,
  CollectGitCommandError
} from "./collect-git-command.js";
import { commands, isKnownCommand } from "./commands.js";
import { formatDoctorReport, runDoctorCommand } from "./doctor-command.js";
import { runInitCommand } from "./init-command.js";
import { NoteCommandError, recordManualNote } from "./note-command.js";
import { addProject, ProjectAddError } from "./project-add.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type CliOptions = {
  cwd?: string;
  homeDir?: string;
  now?: () => string;
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

  io.stderr(`Command not implemented yet: ${command}`);
  return 1;
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
    io.stderr("Command not implemented yet: note list");
    return 1;
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
