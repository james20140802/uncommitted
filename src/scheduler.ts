import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfigPaths } from "./config-paths.js";

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

const launchdLabel = "com.uncommitted.schedule";
const executableName = "uncommitted";
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
  const xml = renderLaunchAgentPlistXml({
    label: launchdLabel,
    programArguments: [executableName, ...scheduleCommand],
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
