import { access, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureConfigDirectories, resolveConfigPaths } from "./config-paths.js";

export type InitAnswers = {
  draftRoot?: string;
  scheduleTime?: string;
  aiProvider?: string;
  persona?: string;
  roastLevel?: string;
};

export type InitCommandOptions = {
  homeDir?: string;
  answers?: InitAnswers;
};

export type InitConfig = {
  schemaVersion: 1;
  draftRoot: string;
  scheduleTime: string;
  aiProvider: string;
  persona: string;
  roastLevel: number;
};

export type InitCommandResult = {
  created: true;
  config: InitConfig;
};

const defaultAnswers = {
  draftRoot: "~/Uncommitted/drafts",
  scheduleTime: "23:30",
  aiProvider: "openai",
  persona: "wry coworker",
  roastLevel: "2"
};

export async function runInitCommand(
  args: string[],
  options: InitCommandOptions = {}
): Promise<InitCommandResult> {
  const force = parseInitArgs(args);
  const answers = await resolveAnswers(options.answers);
  const roastLevel = parseRoastLevel(answers.roastLevel);
  const paths = resolveConfigPaths({
    homeDir: options.homeDir,
    draftRoot: answers.draftRoot
  });

  if (!force && (await pathExists(paths.configFile))) {
    throw new Error("Config already exists. Rerun with --force to overwrite.");
  }

  await ensureConfigDirectories(paths);

  const config: InitConfig = {
    schemaVersion: 1,
    draftRoot: paths.defaultDraftRoot,
    scheduleTime: answers.scheduleTime,
    aiProvider: answers.aiProvider,
    persona: answers.persona,
    roastLevel
  };

  await writeJson(paths.configFile, config);
  await writeJsonIfMissing(paths.projectsFile, { schemaVersion: 1, projects: [] });
  await writeJsonIfMissing(paths.formatHistoryFile, { schemaVersion: 1, formats: [] });

  return { created: true, config };
}

function parseInitArgs(args: string[]): boolean {
  let force = false;

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }

    throw new Error(`Unknown init option: ${arg}`);
  }

  return force;
}

async function resolveAnswers(answers: InitAnswers = {}): Promise<Required<InitAnswers>> {
  if (Object.keys(answers).length > 0 || !process.stdin.isTTY) {
    return {
      draftRoot: answers.draftRoot ?? defaultAnswers.draftRoot,
      scheduleTime: answers.scheduleTime ?? defaultAnswers.scheduleTime,
      aiProvider: answers.aiProvider ?? defaultAnswers.aiProvider,
      persona: answers.persona ?? defaultAnswers.persona,
      roastLevel: answers.roastLevel ?? defaultAnswers.roastLevel
    };
  }

  const readline = createInterface({ input, output });

  try {
    return {
      draftRoot: await ask(readline, "Draft root", defaultAnswers.draftRoot),
      scheduleTime: await ask(readline, "Schedule time", defaultAnswers.scheduleTime),
      aiProvider: await ask(readline, "AI provider", defaultAnswers.aiProvider),
      persona: await ask(readline, "Persona", defaultAnswers.persona),
      roastLevel: await ask(readline, "Roast level 0-5", defaultAnswers.roastLevel)
    };
  } finally {
    readline.close();
  }
}

async function ask(
  readline: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string
): Promise<string> {
  const answer = await readline.question(`${label} (${defaultValue}): `);
  return answer.trim() || defaultValue;
}

function parseRoastLevel(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new Error("Roast level must be a number from 0 to 5.");
  }

  return parsed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonIfMissing(path: string, value: unknown): Promise<void> {
  if (await pathExists(path)) {
    return;
  }

  await writeJson(path, value);
}
