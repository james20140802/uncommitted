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

  const logs = await discoverClaudeSessionLogs({
    claudeHome: options.claudeHome
  });
  if (logs.length === 0) {
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
      const head = await readFirstParseable(log.path);
      const cwd = head && typeof head.cwd === "string" ? head.cwd : null;
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
        aggregate.signals.push(...parsed.signals);
        aggregate.conversation.push(...parsed.conversation);
        aggregate.toolFacts.push(...parsed.toolFacts);
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
    } catch (error) {
      failures.push({
        projectId: project.id,
        message: error instanceof Error ? error.message : "Collection failed."
      });
    }
  }

  return { targetDate, successes, failures, claudeLogsMissing: false };
}

async function readFirstParseable(
  path: string
): Promise<Record<string, unknown> | null> {
  const contents = await readFile(path, "utf8");
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}
