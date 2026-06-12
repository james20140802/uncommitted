import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeSessionLogFile = {
  projectDirName: string;
  sessionId: string;
  path: string;
};

export type DiscoverClaudeSessionLogsOptions = {
  claudeHome?: string;
};

export async function discoverClaudeSessionLogs(
  options: DiscoverClaudeSessionLogsOptions = {}
): Promise<ClaudeSessionLogFile[]> {
  const claudeHome = options.claudeHome ?? join(homedir(), ".claude");
  const projectsDir = join(claudeHome, "projects");

  let projectDirNames: string[];
  try {
    projectDirNames = await readdir(projectsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const results: ClaudeSessionLogFile[] = [];

  for (const projectDirName of projectDirNames) {
    const projectDir = join(projectsDir, projectDirName);
    let info;
    try {
      info = await stat(projectDir);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!info.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const entryPath = join(projectDir, entry);
      let entryStat;
      try {
        entryStat = await stat(entryPath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!entryStat.isFile()) continue;
      results.push({
        projectDirName,
        sessionId: entry.slice(0, -".jsonl".length),
        path: entryPath
      });
    }
  }

  results.sort((a, b) => {
    if (a.projectDirName !== b.projectDirName) {
      return a.projectDirName < b.projectDirName ? -1 : 1;
    }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  return results;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
