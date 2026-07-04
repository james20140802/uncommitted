import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveConfigPaths } from "./config-paths.js";

const execFileAsync = promisify(execFile);

// ─── Structured launchctl runner (UNC-85) ─────────────────────────────────

export type LaunchctlResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

/** Low-level raw launchctl callback result, injectable for tests. */
export type LaunchctlRawRunner = (
  args: string[]
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function defaultLaunchctlRawRunner(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("launchctl", args, (err, stdout, stderr) => {
      if (!err) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }

      if (err.code === "ENOENT") {
        resolve({ exitCode: -1, stdout: "", stderr: "__ENOENT__" });
        return;
      }

      const code = typeof err.code === "number" ? (err.code as number) : -1;
      resolve({
        exitCode: code,
        stdout: stdout ?? "",
        stderr: stderr ?? err.message ?? "launchctl failed."
      });
    });
  });
}

/**
 * Run `launchctl` with explicit args and return a structured result.
 * Never throws — subprocess errors are captured in the return value.
 * Use this for status/remove operations that need to inspect the exit code.
 * Pass `runner` to inject a fake for tests.
 */
export async function runLaunchctl(
  args: string[],
  runner: LaunchctlRawRunner = defaultLaunchctlRawRunner
): Promise<LaunchctlResult> {
  const raw = await runner(args);

  if (raw.exitCode === -1 && raw.stderr === "__ENOENT__") {
    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr: "launchctl not found — macOS is required."
    };
  }

  return {
    ok: raw.exitCode === 0,
    code: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr
  };
}

// ─── End structured launchctl runner ──────────────────────────────────────

// ─── End structured launchctl runner ──────────────────────────────────────

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
  environmentVariables?: Record<string, string>;
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

export const KNOWN_PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "UNCOMMITTED_AI_TIMEOUT_MS"
] as const;

/**
 * Reads only the known provider env keys from `source`, omits keys whose
 * value is undefined or empty string, and returns the remaining as a
 * Record<string, string>.
 */
export function captureProviderEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of KNOWN_PROVIDER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value.trim() !== "") {
      result[key] = value;
    }
  }

  return result;
}

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

/**
 * Parse the scheduled Hour/Minute back out of an installed LaunchAgent plist's
 * XML and return it as a zero-padded 24-hour `HH:mm` string. Returns `undefined`
 * when the plist does not contain a valid `StartCalendarInterval` Hour/Minute
 * pair (e.g. a stub or hand-edited file), so callers can degrade gracefully.
 *
 * Pure and injectable — the caller reads the file; this only parses the string.
 */
export function parseInstalledPlistScheduleTime(
  xml: string
): string | undefined {
  const hour = extractPlistInteger(xml, "Hour");
  const minute = extractPlistInteger(xml, "Minute");

  if (hour === undefined || minute === undefined) {
    return undefined;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }

  return `${pad2(hour)}:${pad2(minute)}`;
}

function extractPlistInteger(xml: string, key: string): number | undefined {
  const pattern = new RegExp(
    `<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`
  );
  const match = pattern.exec(xml);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Thrown when a scheduler executable path would bake an ephemeral or
 * non-CLI entry (test worker, worktree, pnpm virtual store) into the
 * launchd plist. Callers map this to a config-style failure (exit 2)
 * and must not overwrite an existing plist.
 */
export class SchedulerExecutablePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerExecutablePathError";
  }
}

export type SchedulerExecutablePathValidation =
  | { ok: true }
  | { ok: false; reason: string };

// pnpm global/tarball installs resolve the CLI bin shim into the virtual
// store, so this suffix is a legitimate documented install path. Must match
// the package name in package.json.
const pnpmOwnCliPathSuffix = "/node_modules/@sangchu04/uncommitted/dist/cli.js";

const unstableExecutablePathRules: Array<{
  matches: (executablePath: string) => boolean;
  reason: string;
}> = [
  {
    matches: (executablePath) => executablePath.includes("/.claude/worktrees/"),
    reason: "temporary git worktree path"
  },
  {
    matches: (executablePath) =>
      executablePath.includes("/node_modules/.pnpm/") &&
      !executablePath.endsWith(pnpmOwnCliPathSuffix),
    reason: "pnpm virtual store path"
  },
  {
    matches: (executablePath) => executablePath.includes("/tinypool/"),
    reason: "test worker (tinypool) path"
  },
  {
    matches: (executablePath) => /\.(ts|mts|cts)$/.test(executablePath),
    reason: "TypeScript source entry"
  },
  {
    matches: (executablePath) =>
      /\.(js|mjs|cjs)$/.test(executablePath) &&
      !/(^|\/)cli\.(js|mjs|cjs)$/.test(executablePath),
    reason: "non-CLI script entry"
  }
];

/**
 * Checks whether an executable path is safe to persist into the launchd
 * plist. `process.argv[1]` is not trustworthy here: under vitest it points
 * at a tinypool worker inside (possibly pruned) worktree node_modules, and
 * launchd would then fail every run with MODULE_NOT_FOUND (UNC-190).
 */
export function validateSchedulerExecutablePath(
  executablePath: string
): SchedulerExecutablePathValidation {
  for (const rule of unstableExecutablePathRules) {
    if (rule.matches(executablePath)) {
      return { ok: false, reason: rule.reason };
    }
  }

  return { ok: true };
}

export function buildLaunchAgentPlist(
  options: LaunchAgentPlistOptions
): LaunchAgentPlist {
  const { hour, minute } = parseScheduleTime(options.scheduleTime);

  if (options.executablePath !== undefined) {
    const validation = validateSchedulerExecutablePath(options.executablePath);
    if (!validation.ok) {
      throw new SchedulerExecutablePathError(
        `Executable path is not a stable CLI entrypoint (${validation.reason}): ` +
          `${options.executablePath}. Run schedule install via the installed CLI ` +
          `(node dist/cli.js schedule install).`
      );
    }
  }

  const plistPath = resolveLaunchAgentPlistPath(options);
  const logs = resolveSchedulerLogPaths(options);
  const executablePath = options.executablePath ?? defaultExecutableName;
  // When the executable is a .js script, launchd cannot resolve the shebang
  // interpreter because it uses a minimal PATH. Prepend the absolute node binary
  // path (process.execPath) so launchd invokes: [node, script.js, ...args].
  // Binary executable paths (no .js extension) are left unchanged.
  const programArguments = executablePath.endsWith(".js")
    ? [process.execPath, executablePath, ...scheduleCommand]
    : [executablePath, ...scheduleCommand];
  const xml = renderLaunchAgentPlistXml({
    label: launchdLabel,
    programArguments,
    hour,
    minute,
    stdoutLogPath: logs.stdout,
    stderrLogPath: logs.stderr,
    environmentVariables: options.environmentVariables
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
  await writeFile(plist.plistPath, plist.xml, { encoding: "utf8", mode: 0o600 });

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
  environmentVariables?: Record<string, string>;
}): string {
  const programArgumentXml = options.programArguments
    .map((argument) => `    <string>${escapePlistString(argument)}</string>`)
    .join("\n");

  const envVars = options.environmentVariables;
  const hasEnvVars = envVars !== undefined && Object.keys(envVars).length > 0;
  const environmentVariablesXml = hasEnvVars
    ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...Object.keys(envVars)
          .sort()
          .map(
            (key) =>
              `    <key>${escapePlistString(key)}</key>\n    <string>${escapePlistString(envVars[key])}</string>`
          ),
        "  </dict>"
      ].join("\n") + "\n"
    : "";

  const afterInterval = hasEnvVars ? `\n${environmentVariablesXml}` : "";

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
  </dict>${afterInterval}
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
