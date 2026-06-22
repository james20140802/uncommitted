import { collectClaudeForRegisteredProjects } from "./collect-claude-command.js";
import { collectCodexForRegisteredProjects } from "./collect-codex-command.js";
import { collectGitForRegisteredProjects } from "./collect-git-command.js";
import { collectGitHubForRegisteredProjects } from "./collect-github-command.js";
import { resolveConfigPaths } from "./config-paths.js";
import {
  loadSourceConfig,
  SOURCE_NAMES,
  type SourceName
} from "./source-config.js";

/**
 * Normalized per-source invoker return shape used by the `collect all`
 * orchestrator. Each invoker reports how many per-project collections
 * succeeded/failed and an optional human-readable detail line.
 */
export type CollectInvokerResult = {
  successCount: number;
  failureCount: number;
  detail?: string;
};

export type CollectInvoker = () => Promise<CollectInvokerResult>;

export type CollectInvokerMap = Record<SourceName, CollectInvoker>;

export type CollectAllOptions = {
  homeDir?: string;
  claudeHome?: string;
  codexHome?: string;
  now?: () => string;
  /**
   * Optional per-source invoker overrides. Any source omitted falls back to
   * the default per-source command wrapper. Test fixtures use this hook to
   * stub success/failure without exercising live collectors.
   */
  collectInvokers?: Partial<CollectInvokerMap>;
};

export type CollectAllEntry =
  | { source: SourceName; status: "success"; detail: string }
  | { source: SourceName; status: "failed"; detail: string }
  | { source: SourceName; status: "disabled" };

export type CollectAllSummary = {
  exitCode: number;
  entries: CollectAllEntry[];
};

/**
 * Iterate every source declared in config:
 *  - disabled → record a `disabled` entry, do not invoke.
 *  - enabled  → call the per-source invoker inside a try/catch so one source's
 *    failure cannot abort the run (failure isolation).
 *
 * Exit code rules:
 *  - 0 if at least one enabled source succeeded.
 *  - 0 if zero sources are enabled (treated as a no-op, not an error).
 *  - 3 only when every enabled source failed.
 */
export async function runCollectAll(
  options: CollectAllOptions
): Promise<CollectAllSummary> {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const sourceConfig = await loadSourceConfig(paths.configFile);
  const invokers = resolveInvokerMap(options);

  const entries: CollectAllEntry[] = [];
  let enabledCount = 0;
  let successCount = 0;

  for (const source of SOURCE_NAMES) {
    if (!sourceConfig[source].enabled) {
      entries.push({ source, status: "disabled" });
      continue;
    }

    enabledCount += 1;
    const invoke = invokers[source];

    try {
      const result = await invoke();
      const detail = formatInvokerDetail(result);
      // A collector that returns per-project failures without throwing (broken
      // project path, fetch/write error) is still a failed run — mirror the
      // per-source `collect <source>` exit-3 behavior instead of reporting
      // success and masking the failure.
      if (result.failureCount > 0) {
        entries.push({ source, status: "failed", detail });
      } else {
        entries.push({ source, status: "success", detail });
        successCount += 1;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      entries.push({ source, status: "failed", detail });
    }
  }

  // No-op exit (zero sources enabled) and partial-success exit both 0. Only
  // total enabled-source failure escalates to 3 (consistent with per-source
  // collect exit codes).
  const exitCode = enabledCount === 0 ? 0 : successCount > 0 ? 0 : 3;

  return { exitCode, entries };
}

function resolveInvokerMap(options: CollectAllOptions): CollectInvokerMap {
  const defaults = buildDefaultInvokers(options);
  const overrides = options.collectInvokers ?? {};

  return {
    git: overrides.git ?? defaults.git,
    claude: overrides.claude ?? defaults.claude,
    codex: overrides.codex ?? defaults.codex,
    github: overrides.github ?? defaults.github
  };
}

/**
 * Wrap a clock so the first reading is captured and reused for the rest of the
 * run. Without this, each per-source collector would call `now()` as it starts,
 * and a `collect all` run that straddles UTC midnight could write events under
 * two different dates — splitting one run so `generate today` sees only part.
 */
export function createStableNow(now?: () => string): () => string {
  let cached: string | undefined;
  return () => {
    if (cached === undefined) {
      cached = now ? now() : new Date().toISOString();
    }
    return cached;
  };
}

function buildDefaultInvokers(options: CollectAllOptions): CollectInvokerMap {
  const now = createStableNow(options.now);

  return {
    git: async () => {
      const result = await collectGitForRegisteredProjects({
        homeDir: options.homeDir,
        now
      });
      const totals = sumActivityTotals(result.successes);
      return {
        successCount: result.successes.length,
        failureCount: result.failures.length,
        detail: `${formatProjectCount(result.successes.length)}, ${totals.commits} commits`
      };
    },
    claude: async () => {
      const result = await collectClaudeForRegisteredProjects({
        homeDir: options.homeDir,
        claudeHome: options.claudeHome,
        now
      });
      if (result.claudeLogsMissing) {
        return {
          successCount: 0,
          failureCount: 0,
          detail: "no Claude session logs found"
        };
      }
      const signals = sumSignalCounts(result.successes);
      return {
        successCount: result.successes.length,
        failureCount: result.failures.length,
        detail: `${formatProjectCount(result.successes.length)}, ${signals} signals`
      };
    },
    codex: async () => {
      const result = await collectCodexForRegisteredProjects({
        homeDir: options.homeDir,
        codexHome: options.codexHome,
        now
      });
      if (result.codexLogsMissing) {
        return {
          successCount: 0,
          failureCount: 0,
          detail: "no Codex session logs found"
        };
      }
      const signals = sumSignalCounts(result.successes);
      return {
        successCount: result.successes.length,
        failureCount: result.failures.length,
        detail: `${formatProjectCount(result.successes.length)}, ${signals} signals`
      };
    },
    github: async () => {
      const result = await collectGitHubForRegisteredProjects({
        homeDir: options.homeDir,
        now
      });
      const signals = result.successes.reduce(
        (acc, success) => acc + success.signalCount,
        0
      );
      return {
        successCount: result.successes.length,
        failureCount: result.failures.length,
        detail: `${formatProjectCount(result.successes.length)}, ${signals} signals`
      };
    }
  };
}

function formatInvokerDetail(result: CollectInvokerResult): string {
  const base =
    result.detail && result.detail.length > 0
      ? result.detail
      : `${result.successCount} ok, ${result.failureCount} failed`;
  // Surface the failure count on the success-flavored default detail so a
  // partially failed source does not read as fully clean.
  if (result.failureCount > 0 && !base.includes("failed")) {
    return `${base} (${result.failureCount} failed)`;
  }
  return base;
}

function sumActivityTotals(
  successes: ReadonlyArray<{ activity: { totals: { commits: number } } }>
): { commits: number } {
  return successes.reduce(
    (acc, success) => ({ commits: acc.commits + success.activity.totals.commits }),
    { commits: 0 }
  );
}

function sumSignalCounts(
  successes: ReadonlyArray<{ signalCount: number }>
): number {
  return successes.reduce((acc, success) => acc + success.signalCount, 0);
}

function formatProjectCount(count: number): string {
  return count === 1 ? "1 project" : `${count} projects`;
}
