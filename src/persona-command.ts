import { writeFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";
import { clearGlobalConfigCache, loadGlobalConfig, type GlobalConfig } from "./global-config.js";
import {
  PERSONA_PRESET_NAMES,
  resolvePersonaPreset,
  type PersonaEmojiUsage,
  type PersonaHumor,
  type PersonaHumorStyle,
  type PersonaLangMix,
  type PersonaOverride,
  type PersonaPresetName,
  type PersonaRegister,
  type PersonaSentenceLength,
  type PersonaVoice
} from "./persona.js";
import { isRecord } from "./type-guards.js";

export type PersonaCommandOptions = {
  homeDir?: string;
};

export type PersonaCommandResult = {
  preset: PersonaPresetName;
  config: GlobalConfig;
};

export type PersonaCommandErrorCode =
  | "usage"
  | "missing-config"
  | "invalid-preset"
  | "invalid-override";

export class PersonaCommandError extends Error {
  readonly code: PersonaCommandErrorCode;

  constructor(message: string, code: PersonaCommandErrorCode) {
    super(message);
    this.name = "PersonaCommandError";
    this.code = code;
  }
}

const USAGE =
  "Usage: uncommitted persona set <preset> " +
  "[--emoji none|light|heavy] [--register formal|casual|mixed] " +
  "[--sentence-length terse|medium|long] [--korean-english-mix low|medium|high] " +
  "[--humor-style dry|warm|sarcastic|absurd] [--roast-level 0-5]";

/**
 * `uncommitted persona set <preset> [overrides]`: resolve a preset (+
 * optional per-knob override flags, see `parseOverrideArgs`) and persist the
 * resulting structured persona + roastLevel into `~/.uncommitted/config.json`,
 * without touching any other config field. Mirrors the load/merge/write shape
 * of `schedule-github-token.ts` / `schedule-provider-keys.ts`, and the plain
 * `JSON.stringify(value, null, 2) + "\n"` writer shape `init-command.ts` uses.
 */
export async function runPersonaCommand(
  args: string[],
  options: PersonaCommandOptions = {}
): Promise<PersonaCommandResult> {
  const [subcommand, presetArg, ...rest] = args;

  if (subcommand !== "set") {
    throw new PersonaCommandError(USAGE, "usage");
  }

  if (!presetArg) {
    throw new PersonaCommandError(
      `${USAGE}\nPresets: ${PERSONA_PRESET_NAMES.join(", ")}`,
      "usage"
    );
  }

  if (!(PERSONA_PRESET_NAMES as readonly string[]).includes(presetArg)) {
    throw new PersonaCommandError(
      `Unknown persona preset: ${presetArg}. Choose one of: ${PERSONA_PRESET_NAMES.join(", ")}.`,
      "invalid-preset"
    );
  }
  const preset = presetArg as PersonaPresetName;

  const override = parseOverrideArgs(rest);

  const configFile = resolveConfigPaths({ homeDir: options.homeDir }).configFile;
  const existing = await readExistingConfig(configFile);

  const { roastLevel, persona } = resolvePersonaPreset(preset, override);

  const updatedConfig: GlobalConfig = {
    ...existing,
    persona,
    roastLevel
  } as GlobalConfig;

  await writeFile(configFile, `${JSON.stringify(updatedConfig, null, 2)}\n`);
  clearGlobalConfigCache();

  return { preset, config: updatedConfig };
}

async function readExistingConfig(configFile: string): Promise<Record<string, unknown>> {
  const outcome = await loadGlobalConfig(configFile);

  if (outcome.status === "missing") {
    throw new PersonaCommandError("Run `uncommitted init` first.", "missing-config");
  }

  if (outcome.status !== "ok" || !isRecord(outcome.value)) {
    throw new PersonaCommandError(
      `Config error: ${configFile} is unreadable or malformed. Fix or remove the file, then run \`uncommitted init\`.`,
      "missing-config"
    );
  }

  return outcome.value;
}

const emojiValues: readonly PersonaEmojiUsage[] = ["none", "light", "heavy"];
const registerValues: readonly PersonaRegister[] = ["formal", "casual", "mixed"];
const sentenceLengthValues: readonly PersonaSentenceLength[] = ["terse", "medium", "long"];
const langMixValues: readonly PersonaLangMix[] = ["low", "medium", "high"];
const humorStyleValues: readonly PersonaHumorStyle[] = ["dry", "warm", "sarcastic", "absurd"];

/**
 * Minimal per-knob override syntax for `persona set`: `--<flag> <value>`
 * pairs, one flag per supported knob. Only `voice`, `humor.style`, and
 * `roastLevel` are exposed via CLI flags today (identity/reactions overrides
 * are reachable through the `PersonaOverride` API but not yet wired to a
 * flag) — kept intentionally small per the task brief's "don't over-design"
 * guidance. Returns `undefined` when no override flags were given.
 */
function parseOverrideArgs(args: string[]): PersonaOverride | undefined {
  if (args.length === 0) {
    return undefined;
  }

  const voice: Partial<PersonaVoice> = {};
  const humor: Partial<PersonaHumor> = {};
  let roastLevel: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];

    switch (flag) {
      case "--emoji":
        voice.emoji = assertOneOf(flag, requireValue(flag, value), emojiValues);
        i++;
        break;
      case "--register":
        voice.register = assertOneOf(flag, requireValue(flag, value), registerValues);
        i++;
        break;
      case "--sentence-length":
        voice.sentenceLength = assertOneOf(
          flag,
          requireValue(flag, value),
          sentenceLengthValues
        );
        i++;
        break;
      case "--korean-english-mix":
        voice.koreanEnglishMix = assertOneOf(flag, requireValue(flag, value), langMixValues);
        i++;
        break;
      case "--humor-style":
        humor.style = assertOneOf(flag, requireValue(flag, value), humorStyleValues);
        i++;
        break;
      case "--roast-level":
        roastLevel = assertRoastLevel(requireValue(flag, value));
        i++;
        break;
      default:
        throw new PersonaCommandError(`Unknown option: ${flag}\n${USAGE}`, "usage");
    }
  }

  const override: PersonaOverride = {};
  if (Object.keys(voice).length > 0) {
    override.voice = voice;
  }
  if (Object.keys(humor).length > 0) {
    override.humor = humor;
  }
  if (roastLevel !== undefined) {
    override.roastLevel = roastLevel;
  }

  return Object.keys(override).length > 0 ? override : undefined;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new PersonaCommandError(`${flag} requires a value.\n${USAGE}`, "invalid-override");
  }
  return value;
}

function assertOneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new PersonaCommandError(
      `${flag} must be one of: ${allowed.join(", ")}. Got: ${value}`,
      "invalid-override"
    );
  }
  return value as T;
}

function assertRoastLevel(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new PersonaCommandError(
      "--roast-level must be an integer from 0 to 5.",
      "invalid-override"
    );
  }
  return parsed;
}
