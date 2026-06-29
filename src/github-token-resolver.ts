import { join } from "node:path";
import { loadGlobalConfig, selectGitHubToken } from "./global-config.js";

export type ResolvedGitHubToken = {
  token: string | null;
  source: "env" | "config" | "missing";
};

export type ResolveGitHubTokenInput = {
  homeDir: string;
  env?: Record<string, string | undefined>;
};

export async function resolveGitHubToken(
  input: ResolveGitHubTokenInput
): Promise<ResolvedGitHubToken> {
  const env = input.env ?? process.env;
  const envToken = env.GITHUB_TOKEN;
  if (typeof envToken === "string" && envToken.length > 0) {
    return { token: envToken, source: "env" };
  }
  const configPath = join(input.homeDir, ".uncommitted", "config.json");
  const outcome = await loadGlobalConfig(configPath);
  if (outcome.status === "ok") {
    const token = selectGitHubToken(outcome.value);
    if (token !== null) {
      return { token, source: "config" };
    }
  }
  // Missing / unreadable / invalid JSON / no token → "missing".
  return { token: null, source: "missing" };
}
