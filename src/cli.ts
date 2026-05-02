#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commands, isKnownCommand } from "./commands.js";
import { runInitCommand } from "./init-command.js";
import { addProject, ProjectAddError } from "./project-add.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type CliOptions = {
  cwd?: string;
  homeDir?: string;
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

  const [subcommand, value] = commandArgs;

  if (command === "project" && subcommand === "add") {
    return await runProjectAdd(value, io, options);
  }

  io.stderr(`Command not implemented yet: ${command}`);
  return 1;
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
      return error.code === "not-git-repository" ? 2 : 1;
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
