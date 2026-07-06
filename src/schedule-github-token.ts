import { chmod, writeFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";
import {
  clearGlobalConfigCache,
  loadGlobalConfig,
  selectGitHubToken
} from "./global-config.js";
import { isRecord } from "./type-guards.js";

export type PersistGitHubTokenForScheduleInput = {
  homeDir?: string;
  env?: Record<string, string | undefined>;
};

export type PersistGitHubTokenForScheduleReason =
  | "no-env-token"
  | "already-in-config"
  | "persisted"
  | "config-unavailable";

export type PersistGitHubTokenForScheduleResult = {
  persisted: boolean;
  reason: PersistGitHubTokenForScheduleReason;
};

/**
 * Persist an env-provided `GITHUB_TOKEN` into the global config so that
 * `schedule run-now` (invoked by launchd with a minimal environment) can
 * resolve it via `resolveGitHubToken`'s config fallback, without ever
 * writing the token into the launchd plist as plaintext.
 *
 * Never overwrites an existing `githubToken`, never creates/overwrites a
 * config file that is missing or not a valid record — this only augments
 * an already-valid config object.
 */
export async function persistGitHubTokenForSchedule(
  input: PersistGitHubTokenForScheduleInput
): Promise<PersistGitHubTokenForScheduleResult> {
  const env = input.env ?? process.env;
  const envToken = env.GITHUB_TOKEN;

  if (typeof envToken !== "string" || envToken.trim() === "") {
    return { persisted: false, reason: "no-env-token" };
  }

  const configFile = resolveConfigPaths({ homeDir: input.homeDir }).configFile;
  const outcome = await loadGlobalConfig(configFile);

  if (outcome.status !== "ok" || !isRecord(outcome.value)) {
    return { persisted: false, reason: "config-unavailable" };
  }

  const existingToken = selectGitHubToken(outcome.value);
  if (existingToken !== null) {
    return { persisted: false, reason: "already-in-config" };
  }

  const updatedConfig = { ...outcome.value, githubToken: envToken };
  await writeFile(configFile, `${JSON.stringify(updatedConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  // `mode` on writeFile only applies at file creation time; the config file
  // already exists (created by `init`), so explicitly tighten permissions
  // now that it holds a secret.
  await chmod(configFile, 0o600);

  clearGlobalConfigCache();

  return { persisted: true, reason: "persisted" };
}
