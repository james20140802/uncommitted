import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfigPaths } from "./config-paths.js";
import {
  clearGlobalConfigCache,
  loadGlobalConfig,
  PROVIDER_ENV_KEYS,
  PROVIDER_KEY_CONFIG_FIELDS,
  selectProviderKey
} from "./global-config.js";
import type { ProviderEnvKey } from "./global-config.js";
import { isRecord } from "./type-guards.js";

export type PersistProviderKeysForScheduleInput = {
  homeDir?: string;
  env?: Record<string, string | undefined>;
};

export type PersistProviderKeysForScheduleReason =
  | "no-env-keys"
  | "already-in-config"
  | "persisted"
  | "config-unavailable"
  | "unsupported-schema";

export type PersistProviderKeysForScheduleResult = {
  /** Env var names newly written to config (empty when nothing was persisted). */
  persisted: string[];
  reason: PersistProviderKeysForScheduleReason;
};

/**
 * Persist env-provided provider API keys (`OPENAI_API_KEY`,
 * `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) into the global config so that
 * `schedule run-now` (invoked by launchd with a minimal environment) can
 * inject them back into `process.env`, without ever writing them into the
 * launchd plist as plaintext.
 *
 * Mirrors `persistGitHubTokenForSchedule`: each key is captured independently
 * from its own env presence (no gating on the configured provider), never
 * overwrites a key already in config, and only ever augments an
 * already-valid config record (never creates or overwrites a missing/corrupt
 * config). Skips when the config declares an unsupported `schemaVersion`
 * (corruption that `run-now` would reject anyway). All newly-present keys are
 * written in a single atomic 0600 temp-file + rename.
 */
export async function persistProviderKeysForSchedule(
  input: PersistProviderKeysForScheduleInput
): Promise<PersistProviderKeysForScheduleResult> {
  const env = input.env ?? process.env;

  // Candidate keys: present and non-empty in the install-time environment.
  const candidates: ProviderKeyUpdate[] = [];
  for (const envKey of PROVIDER_ENV_KEYS) {
    const value = env[envKey];
    if (typeof value === "string" && value.trim() !== "") {
      candidates.push({ envKey, field: PROVIDER_KEY_CONFIG_FIELDS[envKey], value });
    }
  }

  if (candidates.length === 0) {
    return { persisted: [], reason: "no-env-keys" };
  }

  const configFile = resolveConfigPaths({ homeDir: input.homeDir }).configFile;
  const outcome = await loadGlobalConfig(configFile);

  if (outcome.status !== "ok" || !isRecord(outcome.value)) {
    return { persisted: [], reason: "config-unavailable" };
  }

  // Reject a config declaring an unsupported schemaVersion for the same reason
  // the GitHub-token precedent does: it is corruption, not a default-fallback
  // case, and `schedule run-now` fails on the same guard while loading sources,
  // so persisting here would be useless.
  if (outcome.value.schemaVersion !== 1) {
    return { persisted: [], reason: "unsupported-schema" };
  }

  // Do-not-overwrite: keep only keys not already stored (matches GITHUB_TOKEN).
  const updates = candidates.filter(
    (candidate) => selectProviderKey(outcome.value, candidate.envKey) === null
  );

  if (updates.length === 0) {
    return { persisted: [], reason: "already-in-config" };
  }

  const updatedConfig: Record<string, unknown> = { ...outcome.value };
  for (const update of updates) {
    updatedConfig[update.field] = update.value;
  }

  await atomicWriteConfig(configFile, updatedConfig);
  clearGlobalConfigCache();

  return {
    persisted: updates.map((update) => update.envKey),
    reason: "persisted"
  };
}

type ProviderKeyUpdate = {
  envKey: ProviderEnvKey;
  field: string;
  value: string;
};

/**
 * Write `config` over `configFile` atomically at 0600. `writeFile`'s `mode`
 * only applies to a newly-created file and the existing config.json is
 * typically 0644 from `init`, so a fresh temp file in the SAME directory
 * (collision-resistant name; cleaned up on failure) is created at 0600 and
 * renamed over the target — the secret never sits on disk at a looser mode.
 */
async function atomicWriteConfig(
  configFile: string,
  config: Record<string, unknown>
): Promise<void> {
  const tempFile = join(
    dirname(configFile),
    `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    await writeFile(tempFile, `${JSON.stringify(config, null, 2)}\n`, {
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
}
