import { describe, expect, it } from "vitest";
import {
  describeGitHubTokenStatus,
  GITHUB_TOKEN_MASK,
  maskGitHubToken,
  redactGitHubTokenForDisplay
} from "../src/github-token-safety.js";

describe("github-token-safety", () => {
  describe("maskGitHubToken", () => {
    it("returns the fixed mask without revealing the original token", () => {
      const sampleToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

      const masked = maskGitHubToken(sampleToken);

      expect(masked).toBe(GITHUB_TOKEN_MASK);
      expect(masked).not.toContain(sampleToken);
      expect(masked.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe(false);
    });
  });

  describe("describeGitHubTokenStatus", () => {
    it("returns distinct, value-free strings per source", () => {
      const envStatus = describeGitHubTokenStatus("env");
      const configStatus = describeGitHubTokenStatus("config");
      const missingStatus = describeGitHubTokenStatus("missing");

      expect(envStatus).toContain("GITHUB_TOKEN");
      expect(configStatus.toLowerCase()).toContain("plaintext");
      expect(missingStatus.toLowerCase()).toContain("not set");

      const statuses = [envStatus, configStatus, missingStatus];
      expect(new Set(statuses).size).toBe(3);
    });
  });

  describe("redactGitHubTokenForDisplay", () => {
    it("replaces githubToken with the mask and preserves sibling keys", () => {
      const config = {
        schemaVersion: 1,
        draftRoot: "~/Uncommitted/drafts",
        githubToken: "ghp_supersecrettoken"
      };

      const redacted = redactGitHubTokenForDisplay(config);

      expect(redacted).toEqual({
        schemaVersion: 1,
        draftRoot: "~/Uncommitted/drafts",
        githubToken: GITHUB_TOKEN_MASK
      });
    });

    it("does not mutate the input object", () => {
      const config = { githubToken: "ghp_supersecrettoken", other: "value" };
      const original = { ...config };

      redactGitHubTokenForDisplay(config);

      expect(config).toEqual(original);
    });

    it("passes through non-record values unchanged", () => {
      expect(redactGitHubTokenForDisplay(42)).toBe(42);
      expect(redactGitHubTokenForDisplay(null)).toBe(null);
      expect(redactGitHubTokenForDisplay("a string")).toBe("a string");
      expect(redactGitHubTokenForDisplay([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("passes through records without a string githubToken unchanged in shape", () => {
      const config = { schemaVersion: 1, draftRoot: "~/x" };

      const redacted = redactGitHubTokenForDisplay(config);

      expect(redacted).toEqual(config);
    });
  });
});
