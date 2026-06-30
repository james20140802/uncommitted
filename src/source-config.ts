import { loadGlobalConfig } from "./global-config.js";
import { isRecord } from "./type-guards.js";

export type SourceName = "git" | "claude" | "codex" | "github";

export const SOURCE_NAMES: readonly SourceName[] = [
  "git",
  "claude",
  "codex",
  "github"
];

export type SourceConfigRecord = {
  enabled: boolean;
};

export type SourceConfigMap = Record<SourceName, SourceConfigRecord>;

/**
 * Raised when `config.json` exists but cannot be read or parsed. A missing
 * file is NOT an error (it falls back to all-enabled defaults); a malformed or
 * permission-denied file is, so the opt-out gate cannot be silently bypassed.
 */
export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigError";
  }
}

export function isSourceEnabled(config: unknown, source: SourceName): boolean {
  const record = readSourceRecord(config, source);

  if (record === undefined) {
    return true;
  }

  return record.enabled !== false;
}

export function listEnabledSources(config: unknown): SourceName[] {
  return SOURCE_NAMES.filter((name) => isSourceEnabled(config, name));
}

export async function loadSourceConfig(
  configFilePath: string
): Promise<SourceConfigMap> {
  const outcome = await loadGlobalConfig(configFilePath);

  switch (outcome.status) {
    // A missing config file is a valid first-run state: default everything on.
    case "missing":
      return buildSourceConfigMap({});
    // Any other read error (permissions, I/O) must surface rather than
    // silently enabling all sources.
    case "read-error":
      throw new SourceConfigError(
        `Config error: ${configFilePath} is unreadable or malformed. Fix or remove the file.`
      );
    case "parse-error":
      throw new SourceConfigError(
        `Config error: ${configFilePath} is unreadable or malformed. Fix or remove the file.`
      );
    case "ok":
      // A record declaring an unsupported schemaVersion is a malformed config,
      // not a default-on first run — reject it so source gating cannot be
      // silently bypassed by a schema-mismatched file (matches the preview
      // reader's guard).
      if (isRecord(outcome.value) && outcome.value.schemaVersion !== 1) {
        throw new SourceConfigError(
          `Config error: ${configFilePath} is unreadable or malformed. Fix or remove the file.`
        );
      }
      return buildSourceConfigMap(outcome.value);
  }
}

export function buildSourceConfigMap(config: unknown): SourceConfigMap {
  const map = {} as SourceConfigMap;

  for (const name of SOURCE_NAMES) {
    const record = readSourceRecord(config, name);
    map[name] = { enabled: record?.enabled !== false };
  }

  return map;
}

export const defaultSourceConfigMap = (): SourceConfigMap => ({
  git: { enabled: true },
  claude: { enabled: true },
  codex: { enabled: true },
  github: { enabled: true }
});

function readSourceRecord(
  config: unknown,
  source: SourceName
): SourceConfigRecord | undefined {
  if (!isRecord(config)) {
    return undefined;
  }

  const sources = config.sources;

  if (!isRecord(sources)) {
    return undefined;
  }

  const candidate = sources[source];

  if (!isRecord(candidate)) {
    return undefined;
  }

  const enabled = candidate.enabled;

  if (typeof enabled !== "boolean") {
    return undefined;
  }

  return { enabled };
}
