import { readFile } from "node:fs/promises";
import type { SourceConfigMap } from "./source-config.js";
import { isNodeError, isRecord } from "./type-guards.js";

export type CarouselVisualStyleMode = "photo-first" | "story-card";

/**
 * Canonical shape of `~/.uncommitted/config.json` as written by `init`.
 *
 * This is the single source of truth shared by the writer (`init-command.ts`)
 * and every reader. Individual readers consume only the subset of fields they
 * need via the selectors below; they no longer define their own partial config
 * types. `githubToken` is optional because `init` does not write it (the user
 * adds it by hand, env-first being preferred).
 */
export interface GlobalConfig {
  schemaVersion: 1;
  draftRoot: string;
  scheduleTime: string;
  aiProvider: string;
  carouselVisualStyle: CarouselVisualStyleMode;
  persona: string;
  roastLevel: number;
  rawRetentionDays: number;
  captionProjectionTokenBudget: number;
  sources: SourceConfigMap;
  /**
   * Optional GitHub token used by GitHub-sourced collection.
   *
   * Not managed by `init` — the user adds it by hand. The `GITHUB_TOKEN`
   * environment variable is the recommended way to supply it; storing it
   * here as plaintext in config.json is discouraged (readable by anything
   * with filesystem access, easy to accidentally commit/share). `doctor`
   * only ever reports a masked status (env / config-plaintext / not-set)
   * and never surfaces the value itself.
   */
  githubToken?: string;
  /**
   * Optional provider API keys persisted so a launchd-invoked `schedule
   * run-now` (which runs under a minimal environment) can resolve them,
   * without ever writing them into the launchd plist as plaintext.
   *
   * Not managed by `init` — populated best-effort by `schedule install`
   * (see `schedule-provider-keys.ts`) from the install-time environment,
   * mirroring the `githubToken` precedent. Supplying them via the
   * corresponding environment variable remains the recommended path;
   * storing them here is a scheduled-run fallback, not the primary source.
   */
  openaiApiKey?: string;
  openrouterApiKey?: string;
  anthropicApiKey?: string;
}

/**
 * Maps each secret provider environment variable to its flat GlobalConfig
 * field. Single source of truth shared by the persistence writer and the
 * `run-now` env-injection reader so the two never drift.
 */
export const PROVIDER_KEY_CONFIG_FIELDS = {
  OPENAI_API_KEY: "openaiApiKey",
  OPENROUTER_API_KEY: "openrouterApiKey",
  ANTHROPIC_API_KEY: "anthropicApiKey"
} as const;

export type ProviderEnvKey = keyof typeof PROVIDER_KEY_CONFIG_FIELDS;

/** The three secret provider env keys, in a stable iteration order. */
export const PROVIDER_ENV_KEYS = Object.keys(
  PROVIDER_KEY_CONFIG_FIELDS
) as ProviderEnvKey[];

/**
 * Outcome of attempting to load the global config. Readers map these neutral
 * states onto their own error/default behavior, so this loader stays free of
 * any one command's error type while still distinguishing the cases readers
 * care about (missing vs. unreadable vs. malformed vs. parsed).
 *
 * `value` on `ok` is intentionally `unknown`: a file containing valid JSON that
 * is not an object (e.g. `42`) is a successful read, and several readers treat
 * that as "fall back to defaults" rather than an error.
 */
export type GlobalConfigLoadOutcome =
  | { status: "ok"; value: unknown }
  | { status: "missing" }
  | { status: "read-error"; error: unknown }
  | { status: "parse-error"; error: unknown };

const cache = new Map<string, Promise<GlobalConfigLoadOutcome>>();

/** Drop all cached config reads. Primarily for test isolation. */
export function clearGlobalConfigCache(): void {
  cache.clear();
}

/**
 * Read and parse the global config once per process invocation.
 *
 * Successful reads are cached by path so multiple readers in a single command
 * (e.g. `generate` reading provider config and source gating) hit disk once.
 * Non-`ok` outcomes are not cached, so a config written after an initial
 * missing read is observed on the next call.
 */
export function loadGlobalConfig(
  configFilePath: string
): Promise<GlobalConfigLoadOutcome> {
  const cached = cache.get(configFilePath);
  if (cached) {
    return cached;
  }

  const pending = readGlobalConfigOutcome(configFilePath).then(
    (outcome) => {
      if (outcome.status !== "ok") {
        cache.delete(configFilePath);
      }
      return outcome;
    },
    (error) => {
      // readGlobalConfigOutcome catches its own errors today, but never leave a
      // rejected promise wedged in the cache if that ever changes.
      cache.delete(configFilePath);
      throw error;
    }
  );

  cache.set(configFilePath, pending);
  return pending;
}

async function readGlobalConfigOutcome(
  configFilePath: string
): Promise<GlobalConfigLoadOutcome> {
  let raw: string;

  try {
    raw = await readFile(configFilePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "read-error", error };
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { status: "parse-error", error };
  }

  return { status: "ok", value };
}

/** Unified roast-level guard: an integer in the inclusive range 0–5. */
export function isRoastLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 5
  );
}

/** Extract `draftRoot` when present as a string, else `undefined`. */
export function selectDraftRoot(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.draftRoot === "string") {
    return value.draftRoot;
  }
  return undefined;
}

/** 24-hour HH:mm shape, matching `parseScheduleTime` in scheduler.ts. */
const scheduleTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Extract a usable `scheduleTime` (24-hour HH:mm string) when present, else
 * `undefined`. Callers fall back to their own default/usage error when the key
 * is absent or not a valid time. Validated here so a malformed stored value is
 * treated the same as "not set" rather than flowing into scheduler code as a
 * throwing input.
 */
export function selectScheduleTime(value: unknown): string | undefined {
  if (
    isRecord(value) &&
    typeof value.scheduleTime === "string" &&
    scheduleTimePattern.test(value.scheduleTime)
  ) {
    return value.scheduleTime;
  }
  return undefined;
}

/** Extract a non-empty `githubToken`, else `null`. */
export function selectGitHubToken(value: unknown): string | null {
  if (
    isRecord(value) &&
    typeof value.githubToken === "string" &&
    value.githubToken.length > 0
  ) {
    return value.githubToken;
  }
  return null;
}

/**
 * Extract the persisted provider key for `envKey` (mapped to its flat config
 * field via {@link PROVIDER_KEY_CONFIG_FIELDS}) when present as a non-empty
 * string, else `null`. Mirrors `selectGitHubToken`.
 */
export function selectProviderKey(
  value: unknown,
  envKey: ProviderEnvKey
): string | null {
  const field = PROVIDER_KEY_CONFIG_FIELDS[envKey];
  if (
    isRecord(value) &&
    typeof value[field] === "string" &&
    (value[field] as string).length > 0
  ) {
    return value[field] as string;
  }
  return null;
}
