import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexSessionLogFile = {
  year: string;
  month: string;
  day: string;
  sessionId: string;
  path: string;
};

export type DiscoverCodexSessionLogsOptions = {
  codexHome?: string;
  targetDate?: string; // "YYYY-MM-DD"; when set, only that day is walked
};

export async function discoverCodexSessionLogs(
  options: DiscoverCodexSessionLogsOptions = {}
): Promise<CodexSessionLogFile[]> {
  const codexHome = options.codexHome ?? join(homedir(), ".codex");
  const sessionsDir = join(codexHome, "sessions");

  const results: CodexSessionLogFile[] = [];

  const years = options.targetDate
    ? [options.targetDate.slice(0, 4)]
    : await readDirSafe(sessionsDir);
  for (const year of years) {
    const yearDir = join(sessionsDir, year);
    if (!(await isDirectory(yearDir))) continue;

    const months = options.targetDate
      ? [options.targetDate.slice(5, 7)]
      : await readDirSafe(yearDir);
    for (const month of months) {
      const monthDir = join(yearDir, month);
      if (!(await isDirectory(monthDir))) continue;

      const days = options.targetDate
        ? [options.targetDate.slice(8, 10)]
        : await readDirSafe(monthDir);
      for (const day of days) {
        const dayDir = join(monthDir, day);
        if (!(await isDirectory(dayDir))) continue;

        const entries = await readDirSafe(dayDir);
        for (const entry of entries) {
          if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
          const entryPath = join(dayDir, entry);
          const info = await statSafe(entryPath);
          if (!info || !info.isFile()) continue;
          results.push({
            year,
            month,
            day,
            sessionId: entry.slice(0, -".jsonl".length),
            path: entryPath
          });
        }
      }
    }
  }

  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function statSafe(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await statSafe(path);
  return info?.isDirectory() ?? false;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
