import { access } from "node:fs/promises";
import {
  getLaunchdLabel,
  resolveLaunchAgentPlistPath,
  runLaunchctl,
  type LaunchctlRawRunner,
  type SchedulerPathOptions
} from "./scheduler.js";

export type ScheduleStatusResult = {
  /** True when the Uncommitted LaunchAgent plist exists on disk. */
  installed: boolean;
  /**
   * True when launchctl reports the job loaded, false when determinably absent.
   * Undefined when launchctl could not be queried (see launchctlError).
   */
  loaded: boolean | undefined;
  /** Resolved plist path (always present for display). */
  plistPath: string;
  /** Short actionable error from launchctl, present when the check failed. */
  launchctlError?: string;
};

export type ScheduleStatusOptions = SchedulerPathOptions & {
  /** Injectable launchctl runner for tests. */
  runner?: LaunchctlRawRunner;
};

/**
 * Inspect whether the Uncommitted macOS scheduler is installed and loaded.
 * Never throws — all failure modes are captured in the result.
 */
export async function runScheduleStatus(
  options: ScheduleStatusOptions = {}
): Promise<ScheduleStatusResult> {
  const plistPath = resolveLaunchAgentPlistPath(options);

  const installed = await fileExists(plistPath);

  if (!installed) {
    return { installed: false, loaded: false, plistPath };
  }

  // Query launchctl for loaded state
  const launchctlResult = await runLaunchctl(["list"], options.runner);

  if (!launchctlResult.ok) {
    return {
      installed: true,
      loaded: undefined,
      plistPath,
      launchctlError: launchctlResult.stderr || "launchctl check failed."
    };
  }

  const loaded = isJobLoaded(launchctlResult.stdout, getLaunchdLabel());

  return { installed: true, loaded, plistPath };
}

/**
 * Parse launchctl list output and check for an exact label match.
 * Output lines are tab-separated: PID\tStatus\tLabel
 * We match only the third column exactly to avoid substring false-positives.
 */
function isJobLoaded(listOutput: string, label: string): boolean {
  return listOutput
    .split("\n")
    .some((line) => {
      const parts = line.split("\t");
      return parts.length >= 3 && parts[2] === label;
    });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
