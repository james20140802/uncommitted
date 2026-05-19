import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getLaunchdLabel,
  resolveLaunchAgentPlistPath,
  runLaunchctl,
  type LaunchctlRawRunner,
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
 * Never throws — all failure modes are captured in the result.
 */
export async function runScheduleRemove(
  options: ScheduleRemoveOptions = {}
): Promise<ScheduleRemoveResult> {
  const plistPath = resolveLaunchAgentPlistPath(options);

  // Safety guard: plist path must be inside ~/Library/LaunchAgents/
  const expectedDir = join(
    options.homeDir ?? process.env["HOME"] ?? "",
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

  if (!wasInstalled) {
    // Already absent — idempotent success
    return { removed: true, wasInstalled: false, plistPath };
  }

  // Attempt bootout using the service-target form: gui/$uid/<label>
  const uid = process.getuid?.() ?? 501;
  const serviceTarget = `gui/${uid}/${getLaunchdLabel()}`;
  const bootoutResult = await runLaunchctl(["bootout", serviceTarget], options.runner);

  let launchctlError: string | undefined;

  if (!bootoutResult.ok) {
    // Bootout failure is non-fatal (job may already be unloaded).
    // Capture the error and continue to delete the plist.
    launchctlError = bootoutResult.stderr || "launchctl bootout failed.";
  }

  // Delete only the Uncommitted plist file
  await rm(plistPath, { force: true });

  return { removed: true, wasInstalled: true, plistPath, launchctlError };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
