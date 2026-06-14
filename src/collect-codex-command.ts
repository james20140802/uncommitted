import { readFile } from "node:fs/promises";
import { resolveConfigPaths } from "./config-paths.js";
import { readProjectsFile } from "./project-registry.js";
import type { ProjectRecord } from "./project-registry.js";
import {
  discoverCodexSessionLogs,
  type CodexSessionLogFile
} from "./codex-session-discovery.js";
import {
  attributeCwdToProject,
  readCodexSessionCwd
} from "./codex-session-attribution.js";
import {
  parseCodexSession,
  type CodexSessionParseResult
} from "./codex-session-parser.js";
import { redactCodexSession } from "./codex-session-redactor.js";
import { writeCodexSessionOutputs } from "./codex-session-writer.js";

export type CollectCodexCommandOptions = {
  homeDir?: string;
  codexHome?: string;
  now?: () => string;
  targetDate?: string;
};

export type CollectCodexSuccess = {
  projectId: string;
  signalsFile: string;
  rawArchiveFile: string;
  signalCount: number;
  conversationCount: number;
  toolFactCount: number;
};

export type CollectCodexFailure = {
  projectId: string;
  message: string;
};

export type CollectCodexCommandResult = {
  targetDate: string;
  successes: CollectCodexSuccess[];
  failures: CollectCodexFailure[];
  codexLogsMissing: boolean;
};

export type CollectCodexCommandErrorCode =
  | "invalid-projects-file"
  | "no-projects"
  | "invalid-date";

export class CollectCodexCommandError extends Error {
  constructor(
    message: string,
    public readonly code: CollectCodexCommandErrorCode
  ) {
    super(message);
    this.name = "CollectCodexCommandError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function collectCodexForRegisteredProjects(
  options: CollectCodexCommandOptions = {}
): Promise<CollectCodexCommandResult> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  let projectsFile;
  try {
    projectsFile = await readProjectsFile(paths.projectsFile, {
      missingAsEmpty: true
    });
  } catch {
    throw new CollectCodexCommandError(
      "Invalid projects file.",
      "invalid-projects-file"
    );
  }
  const projects = projectsFile.projects.filter((p) => p.enabled);
  if (projects.length === 0) {
    throw new CollectCodexCommandError(
      "No registered projects. Run `uncommitted project add .` first.",
      "no-projects"
    );
  }

  let targetDate: string;
  if (options.targetDate) {
    if (!DATE_RE.test(options.targetDate)) {
      throw new CollectCodexCommandError(
        "Invalid --date; expected YYYY-MM-DD.",
        "invalid-date"
      );
    }
    targetDate = options.targetDate;
  } else {
    const now = options.now ? options.now() : new Date().toISOString();
    targetDate = now.slice(0, 10);
  }

  // A Codex session that starts before midnight stays under its start day's
  // `sessions/YYYY/MM/DD` directory even when work continues into the next day.
  // Discover both the target day and the previous day so cross-midnight entries
  // (kept by the per-entry timestamp filter below) aren't dropped.
  const discovered = [
    ...(await discoverCodexSessionLogs({
      codexHome: options.codexHome,
      targetDate
    })),
    ...(await discoverCodexSessionLogs({
      codexHome: options.codexHome,
      targetDate: previousDate(targetDate)
    }))
  ];
  const seenPaths = new Set<string>();
  const logs = discovered.filter((log) => {
    if (seenPaths.has(log.path)) return false;
    seenPaths.add(log.path);
    return true;
  });
  if (logs.length === 0) {
    return {
      targetDate,
      successes: [],
      failures: [],
      codexLogsMissing: true
    };
  }

  const logsByProject = new Map<
    string,
    { project: ProjectRecord; logs: CodexSessionLogFile[] }
  >();
  for (const project of projects) {
    logsByProject.set(project.id, { project, logs: [] });
  }

  for (const log of logs) {
    let projectId: string | null = null;
    try {
      const cwd = await readCodexSessionCwd(log.path);
      if (cwd) {
        const attr = attributeCwdToProject(cwd, projects);
        if (attr) projectId = attr.projectId;
      }
    } catch {
      continue;
    }
    if (projectId) logsByProject.get(projectId)?.logs.push(log);
  }

  const successes: CollectCodexSuccess[] = [];
  const failures: CollectCodexFailure[] = [];

  for (const { project, logs: projectLogs } of logsByProject.values()) {
    try {
      const aggregate: CodexSessionParseResult = {
        signals: [],
        conversation: [],
        toolFacts: []
      };
      for (const log of projectLogs) {
        const contents = await readFile(log.path, "utf8");
        const parsed = parseCodexSession({
          projectId: project.id,
          contents
        });
        // A single session can span midnight; only keep entries on the target
        // date so yesterday's Codex work doesn't leak into today's diary.
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
      const redacted = redactCodexSession(aggregate);
      const written = await writeCodexSessionOutputs({
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
    } catch (error) {
      failures.push({
        projectId: project.id,
        message: error instanceof Error ? error.message : "Collection failed."
      });
    }
  }

  return { targetDate, successes, failures, codexLogsMissing: false };
}

function previousDate(targetDate: string): string {
  const d = new Date(`${targetDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isOnTargetDate(timestamp: string, targetDate: string): boolean {
  // Undated entries can't be proven to belong to another day, so keep them
  // with the current collection; dated entries must match the target date.
  return timestamp === "" || timestamp.slice(0, 10) === targetDate;
}
