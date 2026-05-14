import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  getLaunchdLabel,
  parseScheduleTime,
  resolveLaunchAgentPlistPath,
  resolveSchedulerLogPaths
} from "../src/scheduler.js";

describe("macOS scheduler plist helpers", () => {
  it("uses stable launchd label and user LaunchAgent path conventions", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    expect(getLaunchdLabel()).toBe("com.uncommitted.schedule");
    expect(resolveLaunchAgentPlistPath({ homeDir })).toBe(
      join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist")
    );
  });

  it("parses 24-hour HH:mm schedule times for launchd", () => {
    expect(parseScheduleTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseScheduleTime("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseScheduleTime("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  it("resolves stdout and stderr logs under the global config logs directory", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    expect(resolveSchedulerLogPaths({ homeDir })).toEqual({
      stdout: join(homeDir, ".uncommitted", "logs", "schedule.stdout.log"),
      stderr: join(homeDir, ".uncommitted", "logs", "schedule.stderr.log")
    });
  });

  it("generates deterministic plist XML for daily schedule run-now execution", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30"
    });

    expect(plist).toEqual({
      label: "com.uncommitted.schedule",
      plistPath: join(
        homeDir,
        "Library",
        "LaunchAgents",
        "com.uncommitted.schedule.plist"
      ),
      stdoutLogPath: join(
        homeDir,
        ".uncommitted",
        "logs",
        "schedule.stdout.log"
      ),
      stderrLogPath: join(
        homeDir,
        ".uncommitted",
        "logs",
        "schedule.stderr.log"
      ),
      hour: 23,
      minute: 30,
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.uncommitted.schedule</string>
  <key>ProgramArguments</key>
  <array>
    <string>uncommitted</string>
    <string>schedule</string>
    <string>run-now</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>23</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${join(homeDir, ".uncommitted", "logs", "schedule.stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homeDir, ".uncommitted", "logs", "schedule.stderr.log")}</string>
</dict>
</plist>
`
    });
  });

  it("supports an absolute executablePath in the generated plist", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";
    const executablePath = "/usr/local/bin/uncommitted";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30",
      executablePath
    });

    expect(plist.xml).toContain(`<string>${executablePath}</string>`);
  });

  it("rejects invalid schedule times with a short actionable error", () => {
    for (const scheduleTime of ["", "9:30", "24:00", "23:60", "23:30:00"]) {
      expect(() => parseScheduleTime(scheduleTime)).toThrow(
        "Schedule time must use 24-hour HH:mm format."
      );
      expect(() => buildLaunchAgentPlist({ scheduleTime })).toThrow(
        "Schedule time must use 24-hour HH:mm format."
      );
    }
  });
});
