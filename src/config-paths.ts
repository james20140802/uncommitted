import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ConfigPathOptions = {
  homeDir?: string;
  draftRoot?: string;
};

export type ConfigPaths = {
  configDir: string;
  configFile: string;
  projectsFile: string;
  historyDir: string;
  formatHistoryFile: string;
  globalDraftsDir: string;
  logsDir: string;
  defaultDraftRoot: string;
  evalsDir: string;
  requiredDirectories: string[];
};

export function expandHomePath(path: string, homeDir: string = homedir()): string {
  if (path === "~") {
    return homeDir;
  }

  if (path.startsWith("~/")) {
    return join(homeDir, path.slice(2));
  }

  return path;
}

export function resolveConfigPaths(options: ConfigPathOptions = {}): ConfigPaths {
  const homeDir = options.homeDir ?? homedir();
  const configDir = join(homeDir, ".uncommitted");
  const historyDir = join(configDir, "history");
  const defaultDraftRoot = resolvePath(
    options.draftRoot ?? "~/Uncommitted/drafts",
    homeDir
  );

  const evalsDir = resolvePath("~/Uncommitted/evals", homeDir);

  const paths = {
    configDir,
    configFile: join(configDir, "config.json"),
    projectsFile: join(configDir, "projects.json"),
    historyDir,
    formatHistoryFile: join(historyDir, "formats.json"),
    globalDraftsDir: join(configDir, "drafts"),
    logsDir: join(configDir, "logs"),
    defaultDraftRoot,
    evalsDir
  };

  return {
    ...paths,
    requiredDirectories: [
      paths.configDir,
      paths.historyDir,
      paths.globalDraftsDir,
      paths.logsDir,
      paths.defaultDraftRoot
    ]
  };
}

export async function ensureConfigDirectories(paths: ConfigPaths): Promise<void> {
  const directories = new Set(paths.requiredDirectories);

  await Promise.all(
    Array.from(directories, (directory) => mkdir(directory, { recursive: true }))
  );
}

function resolvePath(path: string, homeDir: string): string {
  const expanded = expandHomePath(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(homeDir, expanded);
}
