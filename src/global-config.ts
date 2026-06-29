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
  githubToken?: string;
}

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
