import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveConfigPaths } from "./config-paths.js";

const execFileAsync = promisify(execFile);

export type SchedulerPathOptions = {
  homeDir?: string;
};

export type ScheduleTime = {
  hour: number;
  minute: number;
};

export type SchedulerLogPaths = {
  stdout: string;
  stderr: string;
};

export type LaunchAgentPlistOptions = SchedulerPathOptions & {
  scheduleTime: string;
  executablePath?: string;
};

export type LaunchAgentPlist = {
  label: string;
  plistPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  hour: number;
  minute: number;
  xml: string;
};

export type LaunchctlExecutor = (
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export type InstallSchedulerOptions = SchedulerPathOptions & {
  executor?: LaunchctlExecutor;
};

const launchdLabel = "com.uncommitted.schedule";
const defaultExecutableName = "uncommitted";
const scheduleCommand = ["schedule", "run-now"] as const;

export function getLaunchdLabel(): string {
  return launchdLabel;
}

export function resolveLaunchAgentPlistPath(
  options: SchedulerPathOptions = {}
): string {
  const homeDir = options.homeDir ?? homedir();

  return join(homeDir, "Library", "LaunchAgents", `${launchdLabel}.plist`);
}

export function resolveSchedulerLogPaths(
  options: SchedulerPathOptions = {}
): SchedulerLogPaths {
  const paths = resolveConfigPaths({ homeDir: options.homeDir });

  return {
    stdout: join(paths.logsDir, "schedule.stdout.log"),
    stderr: join(paths.logsDir, "schedule.stderr.log")
  };
}

export function parseScheduleTime(value: string): ScheduleTime {
  const normalized = value.trim();

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error("Schedule time must use 24-hour HH:mm format.");
  }

  const [hour, minute] = normalized.split(":").map(Number);

  return { hour, minute };
}

export function buildLaunchAgentPlist(
  options: LaunchAgentPlistOptions
): LaunchAgentPlist {
  const { hour, minute } = parseScheduleTime(options.scheduleTime);
  const plistPath = resolveLaunchAgentPlistPath(options);
  const logs = resolveSchedulerLogPaths(options);
  const executablePath = options.executablePath ?? defaultExecutableName;
  const xml = renderLaunchAgentPlistXml({
    label: launchdLabel,
    programArguments: [executablePath, ...scheduleCommand],
    hour,
    minute,
    stdoutLogPath: logs.stdout,
    stderrLogPath: logs.stderr
  });

  return {
    label: launchdLabel,
    plistPath,
    stdoutLogPath: logs.stdout,
    stderrLogPath: logs.stderr,
    hour,
    minute,
    xml
  };
}

export async function installScheduler(
  plist: LaunchAgentPlist,
  options: InstallSchedulerOptions = {}
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macOS is required to install the scheduler.");
  }

  const executor = options.executor ?? defaultLaunchctlExecutor;

  const logs = resolveSchedulerLogPaths(options);
  await mkdir(dirname(logs.stdout), { recursive: true });

  await mkdir(dirname(plist.plistPath), { recursive: true });
  await writeFile(plist.plistPath, plist.xml, "utf8");

  // We use bootout/bootstrap for modern macOS launchctl (10.11+)
  // bootout might fail if not already loaded, so we ignore that error.
  try {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await executor(["bootout", domain, plist.plistPath]);
  } catch {
    // Ignore bootout failure (likely not loaded)
  }

  const domain = `gui/${process.getuid?.() ?? 501}`;
  await executor(["bootstrap", domain, plist.plistPath]);
}

async function defaultLaunchctlExecutor(
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("launchctl", args);
}

function renderLaunchAgentPlistXml(options: {
  label: string;
  programArguments: string[];
  hour: number;
  minute: number;
  stdoutLogPath: string;
  stderrLogPath: string;
}): string {
  const programArgumentXml = options.programArguments
    .map((argument) => `    <string>${escapePlistString(argument)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlistString(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${options.hour}</integer>
    <key>Minute</key>
    <integer>${options.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapePlistString(options.stdoutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlistString(options.stderrLogPath)}</string>
</dict>
</plist>
`;
}

function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
