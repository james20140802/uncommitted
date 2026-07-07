import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  captureProviderEnv,
  getLaunchdLabel,
  parseInstalledPlistScheduleTime,
  parseScheduleTime,
  resolveLaunchAgentPlistPath,
  resolveSchedulerLogPaths,
  SchedulerExecutablePathError,
  validateSchedulerExecutablePath
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

describe("validateSchedulerExecutablePath", () => {
  const unstablePaths = [
    // vitest tinypool worker entry — the exact shape that poisoned the 6/28 plist
    "/Users/user/repo/node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/entry/process.js",
    // ephemeral Claude worktree, even when it points at a real cli.js
    "/Users/user/repo/.claude/worktrees/clever-cerf-2fad25/dist/cli.js",
    // foreign package cli.js inside the pnpm virtual store — not our CLI
    "/Users/user/repo/node_modules/.pnpm/uncommitted@0.1.0/node_modules/uncommitted/dist/cli.js",
    // generic non-CLI .js worker entry
    "/opt/some-tool/dist/entry/worker.js",
    // TypeScript source entry — launchd cannot execute it
    "/Users/user/repo/src/cli.ts"
  ];

  it.each(unstablePaths)("rejects unstable executable path %s", (path) => {
    const result = validateSchedulerExecutablePath(path);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("accepts stable CLI entrypoints and binaries", () => {
    for (const path of [
      "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      "/Users/user/.nvm/versions/node/v22.0.0/lib/node_modules/uncommitted/dist/cli.js",
      "/usr/local/bin/uncommitted",
      "uncommitted"
    ]) {
      expect(validateSchedulerExecutablePath(path)).toEqual({ ok: true });
    }
  });

  it("accepts this package's own cli.js resolved into the pnpm virtual store", () => {
    // Documented install paths (README Option B): `pnpm add -g` resolves the
    // bin shim into the virtual store before validation runs.
    for (const path of [
      "/Users/user/Library/pnpm/global/5/node_modules/.pnpm/@sangchu04+uncommitted@0.1.1/node_modules/@sangchu04/uncommitted/dist/cli.js",
      "/Users/user/Library/pnpm/global/5/node_modules/.pnpm/@sangchu04+uncommitted@file+sangchu04-uncommitted-0.1.1.tgz/node_modules/@sangchu04/uncommitted/dist/cli.js"
    ]) {
      expect(validateSchedulerExecutablePath(path)).toEqual({ ok: true });
    }
  });

  it("buildLaunchAgentPlist refuses to bake an unstable executable path into the plist", () => {
    const homeDir = "/tmp/uncommitted-scheduler-home";
    const executablePath =
      "/Users/user/repo/node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/entry/process.js";

    expect(() =>
      buildLaunchAgentPlist({ homeDir, scheduleTime: "23:30", executablePath })
    ).toThrow(SchedulerExecutablePathError);
    expect(() =>
      buildLaunchAgentPlist({ homeDir, scheduleTime: "23:30", executablePath })
    ).toThrow(executablePath);
  });
});

describe("parseInstalledPlistScheduleTime", () => {
  it("parses Hour and Minute out of a generated plist as an HH:mm string", () => {
    const plist = buildLaunchAgentPlist({
      homeDir: "/tmp/uncommitted-scheduler-home",
      scheduleTime: "23:30"
    });

    expect(parseInstalledPlistScheduleTime(plist.xml)).toBe("23:30");
  });

  it("zero-pads single-digit hour and minute integers", () => {
    const plist = buildLaunchAgentPlist({
      homeDir: "/tmp/uncommitted-scheduler-home",
      scheduleTime: "08:05"
    });

    expect(parseInstalledPlistScheduleTime(plist.xml)).toBe("08:05");
  });

  it("tolerates whitespace between key and integer tags", () => {
    const xml = `<dict>
  <key>Hour</key>   <integer>9</integer>
  <key>Minute</key>
    <integer>7</integer>
</dict>`;

    expect(parseInstalledPlistScheduleTime(xml)).toBe("09:07");
  });

  it("returns undefined when Hour or Minute is absent or malformed", () => {
    expect(parseInstalledPlistScheduleTime("")).toBeUndefined();
    expect(parseInstalledPlistScheduleTime("<plist/>")).toBeUndefined();
    expect(
      parseInstalledPlistScheduleTime("<key>Hour</key><integer>9</integer>")
    ).toBeUndefined();
    expect(
      parseInstalledPlistScheduleTime(
        "<key>Hour</key><integer>99</integer><key>Minute</key><integer>0</integer>"
      )
    ).toBeUndefined();
  });
});

describe("captureProviderEnv", () => {
  it("captures only non-secret plist env keys and excludes secret provider keys (UNC-196)", () => {
    const result = captureProviderEnv({
      OPENAI_API_KEY: "sk-test",
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      UNCOMMITTED_AI_TIMEOUT_MS: "5000",
      HOME: "/home/user",
      SOME_OTHER_VAR: "value"
    });

    // Secret provider keys must never be captured for the launchd plist —
    // they are persisted to 0600 config by persistProviderKeysForSchedule.
    expect(result).toEqual({ UNCOMMITTED_AI_TIMEOUT_MS: "5000" });
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("HOME");
    expect(result).not.toHaveProperty("SOME_OTHER_VAR");
  });

  it("omits the timeout key when its value is undefined", () => {
    const result = captureProviderEnv({
      UNCOMMITTED_AI_TIMEOUT_MS: undefined,
      OPENAI_API_KEY: "sk-test"
    });

    expect(result).toEqual({});
  });

  it("omits the timeout key when its value is empty string", () => {
    const result = captureProviderEnv({ UNCOMMITTED_AI_TIMEOUT_MS: "" });

    expect(result).toEqual({});
  });

  it("omits the timeout key when its value is whitespace-only", () => {
    const result = captureProviderEnv({ UNCOMMITTED_AI_TIMEOUT_MS: "\t" });

    expect(result).toEqual({});
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
