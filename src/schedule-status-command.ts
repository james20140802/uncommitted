import { access, readFile } from "node:fs/promises";
import {
  getLaunchdLabel,
  parseInstalledPlistScheduleTime,
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
  /**
   * Actual scheduled time (24-hour `HH:mm`) parsed from the installed plist.
   * Undefined when not installed or the plist lacks a valid Hour/Minute pair.
   */
  installedScheduleTime?: string;
  /** Short actionable error from launchctl, present when the check failed. */
  launchctlError?: string;
};

export type ScheduleStatusOptions = SchedulerPathOptions & {
  /** Injectable launchctl runner for tests. */
  runner?: LaunchctlRawRunner;
};

/**
 * Inspect whether the Uncommitted macOS scheduler is installed and loaded.
 * Queries launchctl regardless of plist presence to detect orphaned jobs.
 * Never throws — all failure modes are captured in the result.
 */
export async function runScheduleStatus(
  options: ScheduleStatusOptions = {}
): Promise<ScheduleStatusResult> {
  const plistPath = resolveLaunchAgentPlistPath(options);

  const installed = await fileExists(plistPath);
  const installedScheduleTime = installed
    ? await readInstalledScheduleTime(plistPath)
    : undefined;

  // Always query launchctl — a job may be loaded even when the plist is absent
  const launchctlResult = await runLaunchctl(["list"], options.runner);

  if (!launchctlResult.ok) {
    return {
      installed,
      loaded: undefined,
      plistPath,
      installedScheduleTime,
      launchctlError: launchctlResult.stderr || "launchctl check failed."
    };
  }

  const loaded = isJobLoaded(launchctlResult.stdout, getLaunchdLabel());

  return { installed, loaded, plistPath, installedScheduleTime };
}

/**
 * Read the installed plist and parse its scheduled time. Returns undefined on
 * any read/parse failure so status never throws over a hand-edited plist.
 */
async function readInstalledScheduleTime(
  plistPath: string
): Promise<string | undefined> {
  try {
    const xml = await readFile(plistPath, "utf8");
    return parseInstalledPlistScheduleTime(xml);
  } catch {
    return undefined;
  }
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
