import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  captureProviderEnv,
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

    // Binary executable path: must appear as ProgramArguments[0], no interpreter prepended
    expect(plist.xml).toContain(`<string>${executablePath}</string>`);
    expect(plist.xml).not.toContain(`<string>${process.execPath}</string>`);
  });

  it("prepends process.execPath as interpreter when executablePath is a .js file", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";
    const executablePath = "/Users/user/.nvm/versions/node/v22.0.0/lib/node_modules/uncommitted/dist/cli.js";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30",
      executablePath
    });

    // node interpreter must be ProgramArguments[0], script path must be ProgramArguments[1]
    const nodeLine = `<string>${process.execPath}</string>`;
    const scriptLine = `<string>${executablePath}</string>`;
    expect(plist.xml).toContain(nodeLine);
    expect(plist.xml).toContain(scriptLine);
    // node must appear before the script path in the XML
    expect(plist.xml.indexOf(nodeLine)).toBeLessThan(plist.xml.indexOf(scriptLine));
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

  it("includes EnvironmentVariables dict when env vars are provided", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30",
      environmentVariables: { OPENAI_API_KEY: "sk-test" }
    });

    expect(plist.xml).toContain("<key>EnvironmentVariables</key>");
    expect(plist.xml).toContain("<key>OPENAI_API_KEY</key>");
    expect(plist.xml).toContain("<string>sk-test</string>");
  });

  it("omits EnvironmentVariables key when no env vars are provided", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30"
    });

    expect(plist.xml).not.toContain("EnvironmentVariables");
  });

  it("omits EnvironmentVariables key when empty object is provided", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30",
      environmentVariables: {}
    });

    expect(plist.xml).not.toContain("EnvironmentVariables");
  });

  it("XML-escapes env var values containing special characters", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30",
      environmentVariables: { SPECIAL_VAR: "val&<>\"'" }
    });

    expect(plist.xml).toContain("<key>SPECIAL_VAR</key>");
    expect(plist.xml).toContain("<string>val&amp;&lt;&gt;&quot;&apos;</string>");
    expect(plist.xml).not.toContain("<string>val&<>\"'</string>");
  });

  it("emits multiple env vars in alphabetical key order for determinism", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "23:30",
      environmentVariables: {
        OPENROUTER_API_KEY: "sk-or-test",
        OPENAI_API_KEY: "sk-test",
        UNCOMMITTED_AI_TIMEOUT_MS: "5000"
      }
    });

    const openaiPos = plist.xml.indexOf("<key>OPENAI_API_KEY</key>");
    const openrouterPos = plist.xml.indexOf("<key>OPENROUTER_API_KEY</key>");
    const timeoutPos = plist.xml.indexOf("<key>UNCOMMITTED_AI_TIMEOUT_MS</key>");

    // Alphabetical: OPENAI < OPENROUTER < UNCOMMITTED
    expect(openaiPos).toBeLessThan(openrouterPos);
    expect(openrouterPos).toBeLessThan(timeoutPos);
  });

  it("produces exact byte-for-byte XML when env vars are provided", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";

    const plist = buildLaunchAgentPlist({
      homeDir,
      scheduleTime: "08:00",
      executablePath: "uncommitted",
      environmentVariables: {
        OPENROUTER_API_KEY: "or-xyz",
        OPENAI_API_KEY: "sk-abc"
      }
    });

    const expectedXml = `<?xml version="1.0" encoding="UTF-8"?>
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
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENAI_API_KEY</key>
    <string>sk-abc</string>
    <key>OPENROUTER_API_KEY</key>
    <string>or-xyz</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/uncommitted-scheduler-home/.uncommitted/logs/schedule.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/uncommitted-scheduler-home/.uncommitted/logs/schedule.stderr.log</string>
</dict>
</plist>
`;

    expect(plist.xml).toBe(expectedXml);
  });
});

describe("captureProviderEnv", () => {
  it("captures only known provider env keys", () => {
    const result = captureProviderEnv({
      OPENAI_API_KEY: "sk-test",
      OPENROUTER_API_KEY: "sk-or-test",
      UNCOMMITTED_AI_TIMEOUT_MS: "5000",
      HOME: "/home/user",
      SOME_OTHER_VAR: "value"
    });

    expect(result).toEqual({
      OPENAI_API_KEY: "sk-test",
      OPENROUTER_API_KEY: "sk-or-test",
      UNCOMMITTED_AI_TIMEOUT_MS: "5000"
    });
    expect(result).not.toHaveProperty("HOME");
    expect(result).not.toHaveProperty("SOME_OTHER_VAR");
  });

  it("omits keys with undefined values", () => {
    const result = captureProviderEnv({
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-or-test"
    });

    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).toEqual({ OPENROUTER_API_KEY: "sk-or-test" });
  });

  it("omits keys with empty string values", () => {
    const result = captureProviderEnv({
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "sk-or-test"
    });

    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).toEqual({ OPENROUTER_API_KEY: "sk-or-test" });
  });

  it("omits keys whose value is whitespace-only", () => {
    const result = captureProviderEnv({
      OPENAI_API_KEY: "   ",
      OPENROUTER_API_KEY: "\t",
      UNCOMMITTED_AI_TIMEOUT_MS: "5000"
    });

    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(result).toEqual({ UNCOMMITTED_AI_TIMEOUT_MS: "5000" });
  });

  it("returns empty object when no known keys are present", () => {
    const result = captureProviderEnv({ HOME: "/home/user", PATH: "/usr/bin" });

    expect(result).toEqual({});
  });

  it("defaults to process.env when no source is provided", () => {
    // Just verify it doesn't throw and returns a record
    const result = captureProviderEnv();
    expect(typeof result).toBe("object");
  });
});
