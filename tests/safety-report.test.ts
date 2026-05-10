import { describe, expect, it } from "vitest";
import {
  checkDraftSafety,
  createSafetyReport,
  isSafetyReport
} from "../src/safety-report.js";

describe("safety report", () => {
  it("marks ordinary draft text as safe and exportable", () => {
    const report = createSafetyReport(
      "Quiet day. Refined the CLI shape and left a few TODOs for tomorrow."
    );

    expect(isSafetyReport(report)).toBe(true);
    expect(report).toEqual({
      schemaVersion: 1,
      status: "safe",
      risks: [],
      redactionsApplied: [],
      exportAllowed: true,
      message: "Safety check passed."
    });
  });

  it("warns and redacts local paths, emails, phone numbers, and private URLs", () => {
    const result = checkDraftSafety(
      [
        "Debug notes lived at /Users/chase/private/todo.md.",
        "Ask dev@example.com or 555-123-4567.",
        "Private repo: https://github.com/acme/secret-project"
      ].join(" ")
    );

    expect(result.report.status).toBe("warning");
    expect(result.report.exportAllowed).toBe(true);
    expect(result.report.message).toBe("Review redactions before export.");
    expect(result.report.risks).toEqual([
      {
        category: "private-url",
        severity: "warning",
        message: "Private URL was redacted."
      },
      {
        category: "email",
        severity: "warning",
        message: "Email address was redacted."
      },
      {
        category: "phone-number",
        severity: "warning",
        message: "Phone number was redacted."
      },
      {
        category: "local-path",
        severity: "warning",
        message: "Local absolute path was redacted."
      }
    ]);
    expect(result.report.redactionsApplied).toEqual([
      {
        category: "private-url",
        replacement: "[redacted-url]",
        count: 1
      },
      {
        category: "email",
        replacement: "[redacted-email]",
        count: 1
      },
      {
        category: "phone-number",
        replacement: "[redacted-phone]",
        count: 1
      },
      {
        category: "local-path",
        replacement: "[redacted-path]",
        count: 1
      }
    ]);
    expect(result.redactedText).toContain("[redacted-path]");
    expect(result.redactedText).toContain("[redacted-email]");
    expect(result.redactedText).toContain("[redacted-phone]");
    expect(result.redactedText).toContain("[redacted-url]");
    expect(result.redactedText).not.toContain("/Users/chase");
    expect(result.redactedText).not.toContain("dev@example.com");
    expect(result.redactedText).not.toContain("555-123-4567");
    expect(result.redactedText).not.toContain("secret-project");
  });

  it("blocks token-like strings and records secret redactions", () => {
    const result = checkDraftSafety(
      "The deployment failed with OPENAI_API_KEY=sk-1234567890abcdef and Bearer ghp_abcdefghijklmnopqrstuvwxyz."
    );

    expect(result.report.status).toBe("blocked");
    expect(result.report.exportAllowed).toBe(false);
    expect(result.report.message).toBe("Remove blocked sensitive content.");
    expect(result.report.risks).toContainEqual({
      category: "secret",
      severity: "blocked",
      message: "Secret or token was redacted."
    });
    expect(result.report.redactionsApplied).toContainEqual({
      category: "secret",
      replacement: "[redacted-secret]",
      count: 2
    });
    expect(result.redactedText).not.toContain("OPENAI_API_KEY");
    expect(result.redactedText).not.toContain("Bearer ghp_");
  });

  it("blocks database credentials and exploit details where pattern matching is feasible", () => {
    const result = checkDraftSafety(
      [
        "DATABASE_URL=postgres://user:password@localhost:5432/app",
        "Do not publish the SQL injection payload: ' OR 1=1 --",
        "The draft pasted <ScRiPt>alert('xss')</script\t\n bar>"
      ].join(" ")
    );

    expect(result.report.status).toBe("blocked");
    expect(result.report.exportAllowed).toBe(false);
    expect(result.report.risks).toEqual([
      {
        category: "database-credential",
        severity: "blocked",
        message: "Database credential was redacted."
      },
      {
        category: "exploit-detail",
        severity: "blocked",
        message: "Exploit detail was redacted."
      }
    ]);
    expect(result.redactedText).toContain("[redacted-db-credential]");
    expect(result.redactedText).toContain("[redacted-exploit-detail]");
    expect(result.redactedText).not.toContain("postgres://user:password");
    expect(result.redactedText).not.toContain("' OR 1=1 --");
    expect(result.redactedText).not.toContain("alert('xss')");
  });

  it("recognizes private repository remote URLs", () => {
    const result = checkDraftSafety(
      "Origin was git@github.com:acme/secret-project.git during cleanup."
    );

    expect(result.report.status).toBe("warning");
    expect(result.report.risks).toContainEqual({
      category: "private-repo-remote",
      severity: "warning",
      message: "Private repository remote was redacted."
    });
    expect(result.report.redactionsApplied).toContainEqual({
      category: "private-repo-remote",
      replacement: "[redacted-repo-url]",
      count: 1
    });
    expect(result.redactedText).toContain("[redacted-repo-url]");
    expect(result.redactedText).not.toContain("git@github.com");
  });
});
