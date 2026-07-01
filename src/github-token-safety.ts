import { isRecord } from "./type-guards.js";

/**
 * Reusable safety helpers for handling a GitHub token value.
 *
 * A GitHub token must never appear in stdout/stderr/logs/doctor output. This
 * module centralizes masking and status-description logic so every caller
 * (init guidance, doctor checks, config display) applies the same rules
 * instead of hand-rolling redaction.
 */

/** Fixed indicator shown in place of any real token value. */
export const GITHUB_TOKEN_MASK = "[redacted-github-token]";

/**
 * Mask a GitHub token for display. Always returns the fixed mask; never
 * reveals any characters of the original token (not even a prefix/suffix).
 */
export function maskGitHubToken(token: string): string {
  // The parameter is part of the documented signature (callers pass the
  // token being masked) but masking always returns the fixed constant and
  // never derives output from the input, so nothing else reads it here.
  void token;
  return GITHUB_TOKEN_MASK;
}

/**
 * Doctor-facing status text describing where (if anywhere) a GitHub token
 * was found. Never includes the token value itself.
 */
export function describeGitHubTokenStatus(
  source: "env" | "config" | "missing"
): string {
  switch (source) {
    case "env":
      return "set (GITHUB_TOKEN env)";
    case "config":
      return "set (config file, plaintext — prefer GITHUB_TOKEN env)";
    case "missing":
      return "not set";
  }
}

/**
 * Return a shallow clone of `config` with a string `githubToken` field
 * replaced by the fixed mask. Non-record inputs (including arrays) and
 * records without a string `githubToken` are passed through unchanged
 * (unmutated). Never mutates the input.
 */
export function redactGitHubTokenForDisplay<T>(config: T): T {
  if (!isRecord(config)) {
    return config;
  }

  if (typeof config.githubToken !== "string") {
    return config;
  }

  return {
    ...config,
    githubToken: maskGitHubToken(config.githubToken)
  } as T;
}
