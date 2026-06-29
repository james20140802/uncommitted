import { loadGlobalConfig, selectGitHubToken } from "./global-config.js";
import { resolveConfigPaths } from "./config-paths.js";

export type ResolvedGitHubToken = {
  token: string | null;
  source: "env" | "config" | "missing";
};

export type ResolveGitHubTokenInput = {
  homeDir: string;
  env?: Record<string, string | undefined>;
};

export class GitHubTokenConfigError extends Error {
  readonly code = "config-corruption" as const;

  constructor(message: string) {
    super(message);
    this.name = "GitHubTokenConfigError";
  }
}

export async function resolveGitHubToken(
  input: ResolveGitHubTokenInput
): Promise<ResolvedGitHubToken> {
  const env = input.env ?? process.env;
  const envToken = env.GITHUB_TOKEN;
  if (typeof envToken === "string" && envToken.length > 0) {
    return { token: envToken, source: "env" };
  }
  const configPath = resolveConfigPaths({ homeDir: input.homeDir }).configFile;
  const outcome = await loadGlobalConfig(configPath);
  if (outcome.status === "read-error" || outcome.status === "parse-error") {
    throw new GitHubTokenConfigError(
      `Config error: ${configPath} is unreadable or malformed. Fix or remove the file.`
    );
  }
  if (outcome.status === "ok") {
    const token = selectGitHubToken(outcome.value);
    if (token !== null) {
      return { token, source: "config" };
    }
  }
  // Missing or ok-without-token → "missing".
  return { token: null, source: "missing" };
}
