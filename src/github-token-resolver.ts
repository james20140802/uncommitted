import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { githubToken?: unknown }).githubToken === "string" &&
      (parsed as { githubToken: string }).githubToken.length > 0
    ) {
      return {
        token: (parsed as { githubToken: string }).githubToken,
        source: "config"
      };
    }
  } catch {
    // Missing / unreadable / invalid JSON → fall through to "missing".
  }
  return { token: null, source: "missing" };
}
