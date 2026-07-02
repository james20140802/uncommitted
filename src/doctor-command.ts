import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { resolveConfigPaths } from "./config-paths.js";
import { loadGlobalConfig, selectGitHubToken, type GlobalConfig } from "./global-config.js";
import { describeGitHubTokenStatus } from "./github-token-safety.js";
import { isRecord } from "./type-guards.js";

const execFileAsync = promisify(execFile);
const minimumNodeVersion = "22.13.0";

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
  exitCode?: number;
};

export type DoctorReport = {
  checks: DoctorCheck[];
};

export type CommandCheckResult = {
  ok: boolean;
  detail: string;
};

export type DoctorOptions = {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  checkCommand?: (command: string, args: string[]) => Promise<CommandCheckResult>;
  checkAccess?: (path: string, mode: number) => Promise<boolean>;
};

type DoctorConfig = Pick<
  GlobalConfig,
  "schemaVersion" | "draftRoot" | "aiProvider" | "githubToken"
>;

const aiProviderEnvKeys: Record<string, string | undefined> = {
  none: undefined,
  mock: undefined,
  ollama: undefined,
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
};

const directoryLabels: Record<string, string> = {
  configDir: "Config directory",
  historyDir: "Format history directory",
  globalDraftsDir: "Global drafts directory",
  logsDir: "Logs directory",
  defaultDraftRoot: "Configured draft root",
  exportRoot: "Export root"
};

const directoryIds: Record<string, string> = {
  configDir: "directory-config",
  historyDir: "directory-history",
  globalDraftsDir: "directory-global-drafts",
  logsDir: "directory-logs",
  defaultDraftRoot: "directory-draft-root",
  exportRoot: "directory-export-root"
};

export async function runDoctorCommand(
  options: DoctorOptions = {}
): Promise<{ report: DoctorReport; exitCode: number }> {
  const report = await createDoctorReport(options);

  return {
    report,
    exitCode: getDoctorExitCode(report)
  };
}

export async function createDoctorReport(
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const paths = resolveConfigPaths({ homeDir: options.homeDir });
  const { config, check } = await readConfig(paths.configFile);
  const configuredPaths = resolveConfigPaths({
    homeDir: options.homeDir,
    draftRoot: config?.draftRoot
  });

  const directoryChecks = await createDirectoryChecks(
    configuredPaths,
    options.checkAccess ?? defaultCheckAccess
  );
  const exportRootCheck = await createExportRootCheck(
    configuredPaths,
    options.checkAccess ?? defaultCheckAccess
  );
  const legacyExportCheck = await createLegacyExportCheck(
    configuredPaths,
    options.checkAccess ?? defaultCheckAccess
  );

  const checks: DoctorCheck[] = [
    check,
    createNodeCheck(options.nodeVersion ?? process.version),
    await createGitCheck(options.checkCommand ?? defaultCheckCommand),
    ...directoryChecks,
    exportRootCheck,
    ...(legacyExportCheck ? [legacyExportCheck] : [])
  ];

  if (config) {
    checks.push(createAiApiKeyCheck(config.aiProvider, env));
    checks.push(createGitHubTokenCheck(config, env));
  }

  return { checks };
}

export function getDoctorExitCode(report: DoctorReport): number {
  const failedCheck = report.checks.find((check) => check.status === "fail");

  if (!failedCheck) {
    return 0;
  }

  return failedCheck.exitCode ?? 1;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Uncommitted Doctor", ""];

  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.label}: ${check.message}`);

    if (check.detail) {
      lines.push(`  ${check.detail}`);
    }
  }

  return lines.join("\n");
}

async function readConfig(
  configFile: string
): Promise<{ config?: DoctorConfig; check: DoctorCheck }> {
  const outcome = await loadGlobalConfig(configFile);

  if (outcome.status === "missing") {
    return {
      check: {
        id: "config",
        label: "Global config",
        status: "fail",
        message: `Config file is missing: ${configFile}`,
        exitCode: 2
      }
    };
  }

  if (outcome.status !== "ok" || !isDoctorConfig(outcome.value)) {
    return {
      check: {
        id: "config",
        label: "Global config",
        status: "fail",
        message: `Config file is invalid: ${configFile}`,
        exitCode: 2
      }
    };
  }

  return {
    config: outcome.value,
    check: {
      id: "config",
      label: "Global config",
      status: "pass",
      message: "Config file found.",
      detail: configFile
    }
  };
}

function createNodeCheck(nodeVersion: string): DoctorCheck {
  const normalizedVersion = nodeVersion.replace(/^v/, "");

  if (compareNodeVersions(normalizedVersion, minimumNodeVersion) < 0) {
    return {
      id: "node",
      label: "Node.js",
      status: "fail",
      message: `Node.js v${minimumNodeVersion} or newer is required.`,
      detail: `Current version: ${nodeVersion}`
    };
  }

  return {
    id: "node",
    label: "Node.js",
    status: "pass",
    message: `Node.js ${nodeVersion} is supported.`
  };
}

async function createGitCheck(
  checkCommand: (command: string, args: string[]) => Promise<CommandCheckResult>
): Promise<DoctorCheck> {
  const result = await checkCommand("git", ["--version"]);

  if (!result.ok) {
    return {
      id: "git",
      label: "Git",
      status: "fail",
      message: "Git is not installed or not available on PATH.",
      detail: result.detail
    };
  }

  return {
    id: "git",
    label: "Git",
    status: "pass",
    message: "Git is available.",
    detail: result.detail
  };
}

async function createDirectoryChecks(
  paths: ReturnType<typeof resolveConfigPaths>,
  checkAccess: (path: string, mode: number) => Promise<boolean>
): Promise<DoctorCheck[]> {
  const pathEntries = [
    ["configDir", paths.configDir],
    ["historyDir", paths.historyDir],
    ["globalDraftsDir", paths.globalDraftsDir],
    ["logsDir", paths.logsDir],
    ["defaultDraftRoot", paths.defaultDraftRoot]
  ] as const;

  return await Promise.all(
    pathEntries.map(async ([key, path]) => {
      const writable = await checkAccess(path, constants.W_OK);

      if (!writable) {
        return {
          id: directoryIds[key],
          label: directoryLabels[key],
          status: "fail",
          message: `Directory is not writable: ${path}`
        };
      }

      return {
        id: directoryIds[key],
        label: directoryLabels[key],
        status: "pass",
        message: `Directory is writable: ${path}`
      };
    })
  );
}

async function createExportRootCheck(
  paths: ReturnType<typeof resolveConfigPaths>,
  checkAccess: (path: string, mode: number) => Promise<boolean>
): Promise<DoctorCheck> {
  const uncommittedRoot = dirname(paths.defaultDraftRoot);
  const exportRoot = join(uncommittedRoot, "exports", "instagram");
  const id = directoryIds.exportRoot;
  const label = directoryLabels.exportRoot;

  // The export root is created lazily on first `export instagram`, so a
  // freshly-initialized environment legitimately has no export root yet.
  // Don't fail doctor before the first export: when the directory is absent,
  // confirm the parent path it will be created under is writable instead.
  const exists = await checkAccess(exportRoot, constants.F_OK);

  if (!exists) {
    const parentWritable = await checkAccess(uncommittedRoot, constants.W_OK);

    if (!parentWritable) {
      return {
        id,
        label,
        status: "fail",
        message: `Cannot create export root; parent is not writable: ${uncommittedRoot}`
      };
    }

    return {
      id,
      label,
      status: "pass",
      message: `Export root will be created on first export: ${exportRoot}`
    };
  }

  const writable = await checkAccess(exportRoot, constants.W_OK);

  if (!writable) {
    return {
      id,
      label,
      status: "fail",
      message: `Directory is not writable: ${exportRoot}`
    };
  }

  return {
    id,
    label,
    status: "pass",
    message: `Directory is writable: ${exportRoot}`
  };
}

async function createLegacyExportCheck(
  paths: ReturnType<typeof resolveConfigPaths>,
  checkAccess: (path: string, mode: number) => Promise<boolean>
): Promise<DoctorCheck | null> {
  const legacyDir = join(paths.defaultDraftRoot, "exports");
  const exists = await checkAccess(legacyDir, constants.F_OK);

  if (!exists) return null;

  return {
    id: "directory-legacy-exports",
    label: "Legacy export directory",
    status: "warn",
    message:
      `Legacy export directory detected at ${legacyDir}. Move its contents to ` +
      `${join(dirname(paths.defaultDraftRoot), "exports", "instagram")} or delete it; ` +
      `Uncommitted no longer writes here.`
  };
}

function createAiApiKeyCheck(
  aiProvider: string,
  env: Record<string, string | undefined>
): DoctorCheck {
  const normalizedProvider = aiProvider.trim().toLowerCase();
  const providerIsSupported = Object.prototype.hasOwnProperty.call(
    aiProviderEnvKeys,
    normalizedProvider
  );

  if (!providerIsSupported) {
    return {
      id: "ai-api-key",
      label: "AI API key",
      status: "fail",
      message: `Unsupported AI provider: ${normalizedProvider}.`,
      exitCode: 2
    };
  }

  const envKey = aiProviderEnvKeys[normalizedProvider];

  if (!envKey) {
    return {
      id: "ai-api-key",
      label: "AI API key",
      status: "pass",
      message: `No API key required for provider: ${normalizedProvider}.`
    };
  }

  if (!env[envKey]) {
    return {
      id: "ai-api-key",
      label: "AI API key",
      status: "warn",
      message: `${envKey} is not set.`
    };
  }

  return {
    id: "ai-api-key",
    label: "AI API key",
    status: "pass",
    message: `${envKey} is set.`
  };
}

function createGitHubTokenCheck(
  config: DoctorConfig,
  env: Record<string, string | undefined>
): DoctorCheck {
  const envToken = env.GITHUB_TOKEN;
  const source: "env" | "config" | "missing" =
    typeof envToken === "string" && envToken.length > 0
      ? "env"
      : selectGitHubToken(config) !== null
        ? "config"
        : "missing";

  const message = describeGitHubTokenStatus(source);

  return {
    id: "github-token",
    label: "GitHub token",
    status: source === "config" ? "warn" : "pass",
    message
  };
}

async function defaultCheckCommand(
  command: string,
  args: string[]
): Promise<CommandCheckResult> {
  try {
    const { stdout } = await execFileAsync(command, args);

    return { ok: true, detail: stdout.trim() };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : `${command} failed.`
    };
  }
}

async function defaultCheckAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function compareNodeVersions(a: string, b: string): number {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);

  for (let index = 0; index < 3; index += 1) {
    if (aParts[index] > bParts[index]) {
      return 1;
    }

    if (aParts[index] < bParts[index]) {
      return -1;
    }
  }

  return 0;
}

function parseVersionParts(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");

  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

function isDoctorConfig(value: unknown): value is DoctorConfig {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.draftRoot === "string" &&
    typeof value.aiProvider === "string" &&
    (value.githubToken === undefined || typeof value.githubToken === "string")
  );
}
