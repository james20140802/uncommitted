import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveConfigPaths } from "./config-paths.js";
import { readProjectsFile } from "./project-registry.js";
import { resolveGitHubToken } from "./github-token-resolver.js";
import { inferGitHubOriginRepo } from "./github-repo-inference.js";
import {
  fetchGitHubActivity,
  type HttpClient,
  type Sleep
} from "./github-fetcher.js";
import { normalizeGitHubFetch } from "./github-event-normalizer.js";
import { redactGitHubEvents } from "./github-event-redactor.js";
import { writeGitHubEvents } from "./github-event-writer.js";
import {
  pruneRawArchives,
  readRawRetentionDays
} from "./raw-archive-prune.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const execFileP = promisify(execFile);

export type CollectGitHubCommandErrorCode =
  | "invalid-projects-file"
  | "no-projects"
  | "invalid-date"
  | "no-token";

export class CollectGitHubCommandError extends Error {
  constructor(
    message: string,
    public readonly code: CollectGitHubCommandErrorCode
  ) {
    super(message);
    this.name = "CollectGitHubCommandError";
  }
}

export type CollectGitHubInput = {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  targetDate?: string;
  now?: () => string;
  httpClient?: HttpClient;
  sleep?: Sleep;
  remoteUrlReader?: (projectRoot: string) => Promise<string>;
};

export type CollectGitHubSuccess = {
  projectId: string;
  signalsFile: string;
  rawArchiveFile: string;
  signalCount: number;
  rawCount: number;
};

export type CollectGitHubFailure = { projectId: string; message: string };

export type CollectGitHubSkipped = {
  projectId: string;
  reason: "non-github-remote";
  remoteUrl: string;
};

export type CollectGitHubResult = {
  targetDate: string;
  successes: CollectGitHubSuccess[];
  failures: CollectGitHubFailure[];
  skippedProjects: CollectGitHubSkipped[];
};

async function defaultRemoteUrlReader(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      projectRoot,
      "remote",
      "get-url",
      "origin"
    ]);
    return stdout.trim();
  } catch (error) {
    // A repo that simply has no `origin` remote is a legitimate non-GitHub
    // skip — return an empty URL. But a genuine command failure (path gone,
    // not a Git repo, git unavailable) must surface so the project is reported
    // as a failure instead of silently dropped from collection.
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/no such remote/i.test(stderr)) {
      return "";
    }
    const detail = (stderr.split("\n").find((line) => line.trim().length > 0) ??
      (error instanceof Error ? error.message : "git remote read failed")).trim();
    throw new Error(`Could not read git remote: ${detail}`, { cause: error });
  }
}

export async function collectGitHubForRegisteredProjects(
  input: CollectGitHubInput = {}
): Promise<CollectGitHubResult> {
  const paths = resolveConfigPaths({ homeDir: input.homeDir });
  let projectsFile;
  try {
    projectsFile = await readProjectsFile(paths.projectsFile, {
      missingAsEmpty: true
    });
  } catch {
    throw new CollectGitHubCommandError(
      "Invalid projects file.",
      "invalid-projects-file"
    );
  }
  const projects = projectsFile.projects.filter((p) => p.enabled);
  if (projects.length === 0) {
    throw new CollectGitHubCommandError(
      "No registered projects. Run `uncommitted project add .` first.",
      "no-projects"
    );
  }

  let targetDate: string;
  if (input.targetDate) {
    if (!DATE_RE.test(input.targetDate)) {
      throw new CollectGitHubCommandError(
        "Invalid --date; expected YYYY-MM-DD.",
        "invalid-date"
      );
    }
    targetDate = input.targetDate;
  } else {
    const now = input.now ? input.now() : new Date().toISOString();
    targetDate = now.slice(0, 10);
  }

  const retentionDays = await readRawRetentionDays(paths.configFile);

  // Enforce retention for every enabled project independently of fetch
  // success or remote classification. A project whose remote was removed or
  // changed away from GitHub takes the skipped path and never reaches a
  // per-success prune, so archives from earlier GitHub collections would
  // otherwise outlive rawRetentionDays.
  for (const project of projects) {
    await pruneRawArchives({
      projectRoot: project.root,
      source: "github",
      today: targetDate,
      retentionDays
    });
  }

  const remoteUrlReader = input.remoteUrlReader ?? defaultRemoteUrlReader;
  const successes: CollectGitHubSuccess[] = [];
  const failures: CollectGitHubFailure[] = [];
  const skippedProjects: CollectGitHubSkipped[] = [];

  // Classify remotes before requiring a token: a workspace with only
  // GitLab/local remotes has nothing to collect, so it should skip gracefully
  // instead of failing with a config error the user can do nothing about.
  const githubProjects: Array<{
    project: (typeof projects)[number];
    owner: string;
    repo: string;
  }> = [];
  for (const project of projects) {
    let remoteUrl: string;
    try {
      remoteUrl = await remoteUrlReader(project.root);
    } catch (error) {
      // A broken project path or non-repo must not masquerade as a graceful
      // non-GitHub skip; report it as a per-project failure.
      failures.push({
        projectId: project.id,
        message:
          error instanceof Error ? error.message : "Could not read git remote."
      });
      continue;
    }
    const inferred = inferGitHubOriginRepo(remoteUrl);
    if (!inferred.isGitHub || !inferred.owner || !inferred.repo) {
      skippedProjects.push({
        projectId: project.id,
        reason: "non-github-remote",
        remoteUrl
      });
      continue;
    }
    githubProjects.push({
      project,
      owner: inferred.owner,
      repo: inferred.repo
    });
  }

  if (githubProjects.length === 0) {
    return { targetDate, successes, failures, skippedProjects };
  }

  const resolved = await resolveGitHubToken({
    homeDir: input.homeDir ?? homedir(),
    env: input.env
  });
  if (!resolved.token) {
    throw new CollectGitHubCommandError(
      "GITHUB_TOKEN not set and `githubToken` missing from config.",
      "no-token"
    );
  }

  for (const { project, owner, repo } of githubProjects) {
    try {
      const fetched = await fetchGitHubActivity({
        token: resolved.token,
        owner,
        repo,
        targetDate,
        httpClient: input.httpClient,
        sleep: input.sleep
      });
      const normalized = normalizeGitHubFetch({
        projectId: project.id,
        fetch: fetched
      });
      const redacted = redactGitHubEvents(normalized);
      const written = await writeGitHubEvents({
        projectRoot: project.root,
        targetDate,
        signals: redacted.signals,
        ownAuthoredBodies: redacted.ownAuthoredBodies
      });
      successes.push({
        projectId: project.id,
        signalsFile: written.signalsFile,
        rawArchiveFile: written.rawArchiveFile,
        signalCount: written.signalCount,
        rawCount: written.rawCount
      });
    } catch (error) {
      // On failure, never destroy a prior successful collection: if the
      // canonical signal file already exists, leave it (and the raw archive)
      // untouched. Only flush empty files on a first run so downstream readers
      // can still rely on the path contract.
      const signalsPath = join(
        project.root,
        ".uncommitted",
        "events",
        "github",
        `${targetDate}.jsonl`
      );
      const hasExisting = await access(signalsPath).then(
        () => true,
        () => false
      );
      if (!hasExisting) {
        try {
          await writeGitHubEvents({
            projectRoot: project.root,
            targetDate,
            signals: [],
            ownAuthoredBodies: []
          });
        } catch {
          // best effort
        }
      }
      failures.push({
        projectId: project.id,
        message:
          error instanceof Error ? error.message : "Collection failed."
      });
    }
  }

  return { targetDate, successes, failures, skippedProjects };
}
