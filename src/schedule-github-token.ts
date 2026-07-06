import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfigPaths } from "./config-paths.js";
import {
  clearGlobalConfigCache,
  loadGlobalConfig,
  selectGitHubToken
} from "./global-config.js";
import { isSourceEnabled } from "./source-config.js";
import { isRecord } from "./type-guards.js";

export type PersistGitHubTokenForScheduleInput = {
  homeDir?: string;
  env?: Record<string, string | undefined>;
};

export type PersistGitHubTokenForScheduleReason =
  | "no-env-token"
  | "already-in-config"
  | "persisted"
  | "config-unavailable"
  | "unsupported-schema"
  | "github-source-disabled";

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
 * an already-valid config object. Also skips persistence when the config
 * declares an unsupported `schemaVersion` (corruption that `run-now` would
 * reject anyway) or when the GitHub source is explicitly disabled (so no
 * plaintext secret is stored when scheduled collection will not use it).
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

  // Reject a config declaring an unsupported schemaVersion for the same reason
  // source gating and the preview reader do: it is corruption, not a
  // default-fallback case. Persisting a token here would be useless because
  // `schedule run-now` fails on the same schema guard while loading sources.
  if (outcome.value.schemaVersion !== 1) {
    return { persisted: false, reason: "unsupported-schema" };
  }

  // Only persist when GitHub is an active source. With GitHub opted out,
  // scheduled collection skips it entirely, so writing the token would leave a
  // plaintext secret on disk with no benefit. Absent/partial source config
  // defaults to enabled (mirrors `isSourceEnabled`), so the common case still
  // persists.
  if (!isSourceEnabled(outcome.value, "github")) {
    return { persisted: false, reason: "github-source-disabled" };
  }

  const existingToken = selectGitHubToken(outcome.value);
  if (existingToken !== null) {
    return { persisted: false, reason: "already-in-config" };
  }

  const updatedConfig = { ...outcome.value, githubToken: envToken };

  // Write atomically so the token never sits on disk at a looser mode:
  // `writeFile`'s `mode` only applies when the target is newly created, and the
  // existing config.json is typically 0644 from `init`. Create a fresh temp
  // file in the SAME directory (so `rename` is atomic on the same filesystem)
  // at 0600, then rename it over config.json. The temp name is
  // collision-resistant (pid + random) and cleaned up on failure.
  const tempFile = join(
    dirname(configFile),
    `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    await writeFile(tempFile, `${JSON.stringify(updatedConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tempFile, configFile);
  } catch (error) {
    await unlink(tempFile).catch(() => {
      // Best-effort cleanup: the temp file may not exist if writeFile failed.
    });
    throw error;
  }

  clearGlobalConfigCache();

  return { persisted: true, reason: "persisted" };
}
