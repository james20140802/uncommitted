/**
 * Thin, read-only accessor for the durable "core facts" persisted in
 * `persona.json` (owned/defined elsewhere — this module neither creates the
 * file nor defines its schema). Used to inject always-present persona
 * context into `ActivitySummary.unfinishedThreads` (see activity-summary.ts).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfigPaths } from "./config-paths.js";
import { isNodeError, isRecord } from "./type-guards.js";

/**
 * Read `coreFacts` from `<configDir>/memory/persona.json`. Returns `[]` when
 * the file is missing, the field is absent, the JSON is malformed, or the
 * field isn't an array — this is a best-effort read, never a hard failure.
 * Non-string array entries are filtered out.
 */
export async function readCoreFacts(homeDir?: string): Promise<string[]> {
  const { configDir } = resolveConfigPaths({ homeDir });
  const personaFilePath = join(configDir, "memory", "persona.json");

  let text: string;

  try {
    text = await readFile(personaFilePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.coreFacts)) {
    return [];
  }

  return parsed.coreFacts.filter((value): value is string => typeof value === "string");
}
