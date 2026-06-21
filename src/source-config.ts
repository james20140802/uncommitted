import { readFile } from "node:fs/promises";

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
  let parsed: unknown;

  try {
    const raw = await readFile(configFilePath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  return buildSourceConfigMap(parsed);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
