import { readFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";
import { readProjectsFile } from "./project-registry.js";
import type { ProjectRecord } from "./project-registry.js";
import {
  discoverClaudeSessionLogs,
  type ClaudeSessionLogFile
} from "./claude-session-discovery.js";
import { attributeCwdToProject } from "./claude-session-attribution.js";
import {
  parseClaudeSession,
  type ClaudeSessionParseResult
} from "./claude-session-parser.js";
import { redactClaudeSession } from "./claude-session-redactor.js";
import { writeClaudeSessionOutputs } from "./claude-session-writer.js";
import {
  pruneRawArchives,
  readRawRetentionDays
} from "./raw-archive-prune.js";

export type CollectClaudeCommandOptions = {
  homeDir?: string;
  claudeHome?: string;
  now?: () => string;
};

export type CollectClaudeSuccess = {
  projectId: string;
  signalsFile: string;
  rawArchiveFile: string;
  signalCount: number;
  conversationCount: number;
  toolFactCount: number;
};

export type CollectClaudeFailure = {
  projectId: string;
  message: string;
};

export type CollectClaudeCommandResult = {
  targetDate: string;
  successes: CollectClaudeSuccess[];
  failures: CollectClaudeFailure[];
  claudeLogsMissing: boolean;
};

export type CollectClaudeCommandErrorCode =
  | "invalid-projects-file"
  | "no-projects";

export class CollectClaudeCommandError extends Error {
  constructor(
    message: string,
    public readonly code: CollectClaudeCommandErrorCode
  ) {
    super(message);
    this.name = "CollectClaudeCommandError";
  }
}

export async function collectClaudeForRegisteredProjects(
  options: CollectClaudeCommandOptions = {}
): Promise<CollectClaudeCommandResult> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  let projectsFile;
  try {
    projectsFile = await readProjectsFile(paths.projectsFile, {
      missingAsEmpty: true
    });
  } catch {
    throw new CollectClaudeCommandError(
      "Invalid projects file.",
      "invalid-projects-file"
    );
  }
  const projects = projectsFile.projects.filter((p) => p.enabled);
  if (projects.length === 0) {
    throw new CollectClaudeCommandError(
      "No registered projects. Run `uncommitted project add .` first.",
      "no-projects"
    );
  }

  const now = options.now ? options.now() : new Date().toISOString();
  const targetDate = now.slice(0, 10);
  const retentionDays = await readRawRetentionDays(paths.configFile);

  const logs = await discoverClaudeSessionLogs({
    claudeHome: options.claudeHome
  });
  if (logs.length === 0) {
    // No new logs to collect, but retention must still be enforced so raw
    // archives age out on quiet days instead of lingering until the next
    // session appears.
    for (const project of projects) {
      await pruneRawArchives({
        projectRoot: project.root,
        source: "claude",
        today: targetDate,
        retentionDays
      });
    }
    return {
      targetDate,
      successes: [],
      failures: [],
      claudeLogsMissing: true
    };
  }

  const logsByProject = new Map<
    string,
    { project: ProjectRecord; logs: ClaudeSessionLogFile[] }
  >();
  for (const project of projects) {
    logsByProject.set(project.id, { project, logs: [] });
  }

  for (const log of logs) {
    let projectId: string | null = null;
    try {
      const cwd = await readSessionCwd(log.path);
      if (cwd) {
        const attr = attributeCwdToProject(cwd, projects);
        if (attr) projectId = attr.projectId;
      }
    } catch {
      continue;
    }
    if (projectId) {
      logsByProject.get(projectId)?.logs.push(log);
    }
  }

  const successes: CollectClaudeSuccess[] = [];
  const failures: CollectClaudeFailure[] = [];

  for (const { project, logs: projectLogs } of logsByProject.values()) {
    try {
      const aggregate: ClaudeSessionParseResult = {
        signals: [],
        conversation: [],
        toolFacts: []
      };
      for (const log of projectLogs) {
        const contents = await readFile(log.path, "utf8");
        const parsed = parseClaudeSession({
          projectId: project.id,
          contents
        });
        // A single session can span midnight, and discovery returns every
        // session file regardless of date. Keep only entries that belong to
        // the target date (entries without a timestamp are treated as
        // current) so yesterday's Claude work never leaks into today's diary.
        aggregate.signals.push(
          ...parsed.signals.filter((s) => isOnTargetDate(s.timestamp, targetDate))
        );
        aggregate.conversation.push(
          ...parsed.conversation.filter((c) =>
            isOnTargetDate(c.timestamp, targetDate)
          )
        );
        aggregate.toolFacts.push(
          ...parsed.toolFacts.filter((t) =>
            isOnTargetDate(t.timestamp, targetDate)
          )
        );
      }
      const redacted = redactClaudeSession(aggregate);
      const written = await writeClaudeSessionOutputs({
        projectRoot: project.root,
        targetDate,
        signals: redacted.signals,
        conversation: redacted.conversation,
        toolFacts: redacted.toolFacts
      });
      successes.push({
        projectId: project.id,
        signalsFile: written.signalsFile,
        rawArchiveFile: written.rawArchiveFile,
        signalCount: written.signalCount,
        conversationCount: written.conversationCount,
        toolFactCount: written.toolFactCount
      });
      await pruneRawArchives({
        projectRoot: project.root,
        source: "claude",
        today: targetDate,
        retentionDays
      });
    } catch (error) {
      failures.push({
        projectId: project.id,
        message: error instanceof Error ? error.message : "Collection failed."
      });
    }
  }

  return { targetDate, successes, failures, claudeLogsMissing: false };
}

// Scan the session for the first record that carries a string `cwd`, rather
// than stopping at the first parseable JSON object. Claude sessions can open
// with a summary/metadata record that has no `cwd`; the project root only
// appears on later user/assistant records. Stopping at the first object would
// leave `cwd` null and silently drop the entire session.
async function readSessionCwd(path: string): Promise<string | null> {
  const contents = await readFile(path, "utf8");
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).cwd === "string"
      ) {
        return (parsed as Record<string, unknown>).cwd as string;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function isOnTargetDate(timestamp: string, targetDate: string): boolean {
  // Undated entries can't be proven to belong to another day, so keep them
  // with the current collection; dated entries must match the target date.
  return timestamp === "" || timestamp.slice(0, 10) === targetDate;
}
