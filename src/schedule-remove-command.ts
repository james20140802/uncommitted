import { access, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getLaunchdLabel,
  resolveLaunchAgentPlistPath,
  runLaunchctl,
  type LaunchctlRawRunner,
  type LaunchctlResult,
  type SchedulerPathOptions
} from "./scheduler.js";

export type ScheduleRemoveResult = {
  /** True when the command completed without fatal errors. */
  removed: boolean;
  /** True when the plist existed before removal. */
  wasInstalled: boolean;
  /** Resolved plist path. */
  plistPath: string;
  /** Short actionable launchctl error, if bootout failed non-fatally. */
  launchctlError?: string;
};

export type ScheduleRemoveOptions = SchedulerPathOptions & {
  /** Injectable launchctl runner for tests. */
  runner?: LaunchctlRawRunner;
};

/**
 * Unload the Uncommitted launchd job and delete the LaunchAgent plist.
 * - Idempotent: succeeds cleanly when the scheduler is already absent.
 * - Never deletes files outside the Uncommitted plist path.
 * - Verifies the plist path is inside ~/Library/LaunchAgents/ before deletion.
 * - Attempts bootout even when plist is absent to unload orphaned jobs.
 * - Non-benign bootout failures abort without touching the plist.
 * Never throws — all failure modes are captured in the result.
 */
export async function runScheduleRemove(
  options: ScheduleRemoveOptions = {}
): Promise<ScheduleRemoveResult> {
  const plistPath = resolveLaunchAgentPlistPath(options);

  // Safety guard: use the same home source as resolveLaunchAgentPlistPath
  const expectedDir = join(
    options.homeDir ?? homedir(),
    "Library",
    "LaunchAgents"
  );

  if (!plistPath.startsWith(expectedDir + "/") && plistPath !== expectedDir) {
    return {
      removed: false,
      wasInstalled: false,
      plistPath,
      launchctlError: `Plist path is outside ~/Library/LaunchAgents/. Aborting for safety.`
    };
  }

  const wasInstalled = await fileExists(plistPath);

  // Always attempt bootout — guards against orphaned jobs when plist is absent
  const uid = process.getuid?.() ?? 501;
  const serviceTarget = `gui/${uid}/${getLaunchdLabel()}`;
  const bootoutResult = await runLaunchctl(["bootout", serviceTarget], options.runner);

  let launchctlError: string | undefined;

  if (!bootoutResult.ok) {
    if (!isBootoutErrorBenign(bootoutResult)) {
      // Non-benign failure (e.g. permission denied) — abort, do not delete plist
      return {
        removed: false,
        wasInstalled,
        plistPath,
        launchctlError: bootoutResult.stderr || "launchctl bootout failed."
      };
    }
    // Benign (already unloaded, no such process) — capture and continue
    launchctlError = bootoutResult.stderr || "launchctl bootout failed.";
  }

  if (!wasInstalled) {
    return { removed: true, wasInstalled: false, plistPath, launchctlError };
  }

  // Delete only the Uncommitted plist file
  try {
    await rm(plistPath, { force: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete plist file.";
    return { removed: false, wasInstalled: true, plistPath, launchctlError: message };
  }

  return { removed: true, wasInstalled: true, plistPath, launchctlError };
}

/** Returns true when a bootout failure indicates the job was already not loaded. */
function isBootoutErrorBenign(result: LaunchctlResult): boolean {
  if (result.code === 3) return true;   // ESRCH — No such process
  if (result.code === -1) return true;  // launchctl binary absent (ENOENT)
  const benignPattern = /no such process|could not find specified service|not loaded/i;
  return benignPattern.test(result.stderr);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
