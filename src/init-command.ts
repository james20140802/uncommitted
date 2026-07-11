import { access, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureConfigDirectories, resolveConfigPaths } from "./config-paths.js";
import { clearGlobalConfigCache, type GlobalConfig } from "./global-config.js";
import { migratePersona } from "./persona.js";
import { defaultSourceConfigMap } from "./source-config.js";

/** @deprecated Use {@link GlobalConfig}, the canonical config shape. */
export type InitConfig = GlobalConfig;

export type InitAnswers = {
  draftRoot?: string;
  scheduleTime?: string;
  aiProvider?: string;
  carouselVisualStyle?: string;
  persona?: string;
  roastLevel?: string;
  rawRetentionDays?: string;
  captionProjectionTokenBudget?: string;
};

export type InitCommandOptions = {
  homeDir?: string;
  answers?: InitAnswers;
};

export type InitCommandResult = {
  created: true;
  config: GlobalConfig;
  guidance: string[];
};

const githubTokenGuidance: string[] = [
  "GitHub token: set the GITHUB_TOKEN environment variable rather than storing it in config.",
  "init does not manage githubToken; storing it as plaintext in config.json is discouraged — prefer GITHUB_TOKEN."
];

const defaultAnswers = {
  draftRoot: "~/Uncommitted/drafts",
  scheduleTime: "23:30",
  aiProvider: "none",
  carouselVisualStyle: "photo-first",
  persona: "project-local AI coworker writing its own off-the-record diary",
  roastLevel: "2",
  rawRetentionDays: "30",
  captionProjectionTokenBudget: "4000"
};
const supportedAiProviders = [
  "none",
  "mock",
  "openai",
  "anthropic",
  "google",
  "ollama",
  "mistral",
  "openrouter"
] as const;

export async function runInitCommand(
  args: string[],
  options: InitCommandOptions = {}
): Promise<InitCommandResult> {
  const force = parseInitArgs(args);
  const answers = await resolveAnswers(options.answers);
  const scheduleTime = parseScheduleTime(answers.scheduleTime);
  const aiProvider = parseAiProvider(answers.aiProvider);
  const carouselVisualStyle = parseCarouselVisualStyle(
    answers.carouselVisualStyle
  );
  const roastLevel = parseRoastLevel(answers.roastLevel);
  const rawRetentionDays = parseRawRetentionDays(answers.rawRetentionDays);
  const captionProjectionTokenBudget = parseCaptionProjectionTokenBudget(
    answers.captionProjectionTokenBudget
  );
  const paths = resolveConfigPaths({
    homeDir: options.homeDir,
    draftRoot: answers.draftRoot
  });

  if (!force && (await pathExists(paths.configFile))) {
    throw new Error("Config already exists. Rerun with --force to overwrite.");
  }

  await ensureConfigDirectories(paths);

  const config: GlobalConfig = {
    schemaVersion: 1,
    draftRoot: paths.defaultDraftRoot,
    scheduleTime,
    aiProvider,
    carouselVisualStyle,
    // TODO(UNC-210): replace free-text persona answer with preset selection.
    // Until then, migrate the free-text answer into the structured schema so
    // `config.json` stays schema-valid.
    persona: migratePersona(answers.persona),
    roastLevel,
    rawRetentionDays,
    captionProjectionTokenBudget,
    sources: defaultSourceConfigMap()
  };

  await writeJson(paths.configFile, config);
  // Invalidate any config cached earlier in this process so a subsequent read
  // in the same invocation reflects the freshly written config.
  clearGlobalConfigCache();
  await writeJsonIfMissing(paths.projectsFile, { schemaVersion: 1, projects: [] });
  await writeJsonIfMissing(paths.formatHistoryFile, { schemaVersion: 1, formats: [] });

  return { created: true, config, guidance: githubTokenGuidance };
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
      carouselVisualStyle:
        answers.carouselVisualStyle ?? defaultAnswers.carouselVisualStyle,
      persona: answers.persona ?? defaultAnswers.persona,
      roastLevel: answers.roastLevel ?? defaultAnswers.roastLevel,
      rawRetentionDays:
        answers.rawRetentionDays ?? defaultAnswers.rawRetentionDays,
      captionProjectionTokenBudget:
        answers.captionProjectionTokenBudget ??
        defaultAnswers.captionProjectionTokenBudget
    };
  }

  const readline = createInterface({ input, output });

  try {
    return {
      draftRoot: await ask(readline, "Draft root", defaultAnswers.draftRoot),
      scheduleTime: await ask(readline, "Schedule time", defaultAnswers.scheduleTime),
      aiProvider: await ask(
        readline,
        "AI provider, or none to decide later",
        defaultAnswers.aiProvider
      ),
      carouselVisualStyle: await ask(
        readline,
        "Carousel visual style",
        defaultAnswers.carouselVisualStyle
      ),
      persona: await ask(readline, "Persona", defaultAnswers.persona),
      roastLevel: await ask(readline, "Roast level 0-5", defaultAnswers.roastLevel),
      rawRetentionDays: await ask(
        readline,
        "Raw event retention days (0 or 'unlimited' to keep forever)",
        defaultAnswers.rawRetentionDays
      ),
      captionProjectionTokenBudget: await ask(
        readline,
        "Caption projection token budget per day",
        defaultAnswers.captionProjectionTokenBudget
      )
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

function parseRawRetentionDays(value: string): number {
  const normalized = value.trim().toLowerCase();

  if (normalized === "unlimited") {
    return 0;
  }

  const parsed = Number(normalized);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "Raw retention days must be a non-negative integer (use 0 or 'unlimited' to keep forever)."
    );
  }

  return parsed;
}

function parseCaptionProjectionTokenBudget(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Caption projection token budget must be a positive integer.");
  }

  return parsed;
}

function parseScheduleTime(value: string): string {
  const normalized = value.trim();

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error("Schedule time must use 24-hour HH:mm format.");
  }

  return normalized;
}

function parseAiProvider(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!supportedAiProviders.includes(normalized as (typeof supportedAiProviders)[number])) {
    throw new Error(
      `AI provider must be one of: ${supportedAiProviders.join(", ")}.`
    );
  }

  return normalized;
}

function parseCarouselVisualStyle(value: string): "photo-first" | "story-card" {
  const normalized = value.trim().toLowerCase();

  if (normalized !== "photo-first" && normalized !== "story-card") {
    throw new Error("Carousel visual style must be one of: photo-first, story-card.");
  }

  return normalized;
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
