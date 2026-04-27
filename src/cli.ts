#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commands, isKnownCommand } from "./commands.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
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

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command] = normalizedArgs;

  if (!command || command === "--help" || command === "-h") {
    io.stdout(getHelpText());
    return 0;
  }

  if (!isKnownCommand(command)) {
    io.stderr(`Unknown command: ${command}`);
    io.stderr("Run `uncommitted --help`.");
    return 1;
  }

  io.stderr(`Command not implemented yet: ${command}`);
  return 1;
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
