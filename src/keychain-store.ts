import { execFile } from "node:child_process";
import { resolveConfigPaths } from "./config-paths.js";
import { clearGlobalConfigCache, loadGlobalConfig } from "./global-config.js";
import { atomicWriteConfig } from "./schedule-provider-keys.js";
import { isRecord } from "./type-guards.js";

/**
 * Shared secret lookup (UNC-293, reused by UNC-295):
 *
 * 1. macOS login keychain — `security find-generic-password -a uncommitted
 *    -s <service> -w`. Any failure (exit 44 = item not found, locked keychain,
 *    access denied, `security` unavailable, non-macOS) falls through.
 * 2. `~/.uncommitted/config.json` → `secrets.<configKey>` (written at 0600).
 * 3. Not found — callers print {@link formatMissingSecretMessage} and exit 2.
 *
 * Callers learn only the value and its source (`keychain` | `config`). This
 * module never logs or formats a secret value, and it never writes to the
 * keychain.
 */

export const KEYCHAIN_ACCOUNT = "uncommitted";

export type SecretSource = "keychain" | "config";

export type SecretSpec = {
  /** Keychain generic-password service name (account is {@link KEYCHAIN_ACCOUNT}). */
  keychainService: string;
  /** Key under `config.secrets` used for the 0600 config fallback. */
  configKey: string;
};

export type KeychainRunResult = { exitCode: number; stdout: string };

/** Runs `security <args>`. Injectable so tests never touch a real keychain. */
export type KeychainRunner = (args: string[]) => Promise<KeychainRunResult>;

export type SecretStoreOptions = {
  homeDir?: string;
  /** When omitted, the real `security` CLI is used on macOS only. */
  keychainRunner?: KeychainRunner;
};

export type SecretReadResult =
  | { found: true; value: string; source: SecretSource }
  | { found: false };

/**
 * Thrown when config.json cannot take a secret write (missing, unreadable,
 * malformed, unsupported schema). Tagged `config-corruption` so the CLI's
 * central mapper turns it into exit 2.
 */
export class SecretStoreConfigError extends Error {
  readonly code = "config-corruption" as const;

  constructor(message: string) {
    super(message);
    this.name = "SecretStoreConfigError";
  }
}

export async function readSecret(
  spec: SecretSpec,
  options: SecretStoreOptions = {}
): Promise<SecretReadResult> {
  const runner = options.keychainRunner ?? defaultKeychainRunner();

  if (runner) {
    const fromKeychain = await readKeychain(runner, spec.keychainService);
    if (fromKeychain !== null) {
      return { found: true, value: fromKeychain, source: "keychain" };
    }
  }

  const config = await loadConfigRecord(options.homeDir);
  const secrets = config && isRecord(config.secrets) ? config.secrets : undefined;
  const stored = secrets?.[spec.configKey];
  if (typeof stored === "string" && stored.trim() !== "") {
    return { found: true, value: stored.trim(), source: "config" };
  }

  return { found: false };
}

/** Store a secret under `config.secrets[configKey]`, writing config at 0600. */
export async function writeConfigSecret(
  configKey: string,
  value: string,
  options: { homeDir?: string } = {}
): Promise<void> {
  await updateGlobalConfig(options.homeDir, (config) => {
    const secrets = isRecord(config.secrets) ? { ...config.secrets } : {};
    secrets[configKey] = value;
    return { ...config, secrets };
  });
}

/** Remove the named config secrets; returns the keys that were present. */
export async function removeConfigSecrets(
  configKeys: string[],
  options: { homeDir?: string } = {}
): Promise<string[]> {
  const config = await loadConfigRecord(options.homeDir);
  if (!config || !isRecord(config.secrets)) {
    return [];
  }
  const present = configKeys.filter((key) => key in (config.secrets as object));
  if (present.length === 0) {
    return [];
  }

  await updateGlobalConfig(options.homeDir, (current) => {
    const secrets = isRecord(current.secrets) ? { ...current.secrets } : {};
    for (const key of present) {
      delete secrets[key];
    }
    const next: Record<string, unknown> = { ...current, secrets };
    if (Object.keys(secrets).length === 0) {
      delete next.secrets;
    }
    return next;
  });
  return present;
}

/**
 * Load config.json, apply `mutate`, and write it back atomically at 0600.
 * Requires an initialized (schemaVersion 1) config; never creates one.
 */
export async function updateGlobalConfig(
  homeDir: string | undefined,
  mutate: (config: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const configFile = resolveConfigPaths({ homeDir }).configFile;
  const config = await loadConfigRecord(homeDir);
  if (!config) {
    throw new SecretStoreConfigError(
      "Config not found or invalid. Run `uncommitted init` first."
    );
  }
  await atomicWriteConfig(configFile, mutate(config));
  clearGlobalConfigCache();
}

/** Load config.json as a schemaVersion-1 record, else `null`. */
export async function loadConfigRecord(
  homeDir: string | undefined
): Promise<Record<string, unknown> | null> {
  const configFile = resolveConfigPaths({ homeDir }).configFile;
  const outcome = await loadGlobalConfig(configFile);
  if (
    outcome.status !== "ok" ||
    !isRecord(outcome.value) ||
    outcome.value.schemaVersion !== 1
  ) {
    return null;
  }
  return outcome.value;
}

/**
 * Short guidance naming both storage methods. The keychain command uses
 * `-w "$(pbpaste)"` because interactive `-w` input truncates at 128 chars.
 */
export function formatMissingSecretMessage(input: {
  label: string;
  spec: SecretSpec;
  configCommand: string;
}): string {
  return [
    `${input.label}을(를) 찾지 못했습니다. 아래 중 한 가지로 저장하세요.`,
    `  키체인(권장): 값을 복사한 뒤 security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${input.spec.keychainService} -w "$(pbpaste)"`,
    `  config(0600): ${input.configCommand}`
  ].join("\n");
}

async function readKeychain(
  runner: KeychainRunner,
  service: string
): Promise<string | null> {
  try {
    const result = await runner([
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      service,
      "-w"
    ]);
    if (result.exitCode !== 0) {
      return null;
    }
    const value = result.stdout.replace(/\r?\n$/, "").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function defaultKeychainRunner(): KeychainRunner | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  return (args) =>
    new Promise((resolve) => {
      execFile("security", args, { encoding: "utf8" }, (error, stdout) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          resolve({ exitCode: typeof code === "number" ? code : 1, stdout: "" });
          return;
        }
        resolve({ exitCode: 0, stdout });
      });
    });
}
