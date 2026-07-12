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
      "The deployment failed with OPENAI_API_KEY=sk-1234567890abcdef, TOKEN=abc123, SECRET=def456, PASSWORD=hunter2, and Bearer ghp_abcdefghijklmnopqrstuvwxyz."
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
      count: 5
    });
    expect(result.redactedText).not.toContain("OPENAI_API_KEY");
    expect(result.redactedText).not.toContain("TOKEN=abc123");
    expect(result.redactedText).not.toContain("SECRET=def456");
    expect(result.redactedText).not.toContain("PASSWORD=hunter2");
    expect(result.redactedText).not.toContain("Bearer ghp_");
  });

  it("warns and redacts broad Unix and Windows absolute paths", () => {
    const result = checkDraftSafety(
      [
        "Current workspace was cwd=/workspace/uncommitted/src/index.ts.",
        "Windows path appeared as file:C:\\Users\\chase\\secret\\notes.txt."
      ].join(" ")
    );

    expect(result.report.status).toBe("warning");
    expect(result.report.risks).toContainEqual({
      category: "local-path",
      severity: "warning",
      message: "Local absolute path was redacted."
    });
    expect(result.report.redactionsApplied).toContainEqual({
      category: "local-path",
      replacement: "[redacted-path]",
      count: 2
    });
    expect(result.redactedText).toContain("cwd=[redacted-path]");
    expect(result.redactedText).toContain("file:[redacted-path]");
    expect(result.redactedText).not.toContain("/workspace/uncommitted");
    expect(result.redactedText).not.toContain("C:\\Users\\chase");
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

describe("safety-report architecture-disclosure (UNC-205)", () => {
  it("blocks route-guard / admin-allowlist disclosure and redacts it", () => {
    const result = checkDraftSafety(
      "Hardened the route guard so only allowlisted admins hit the server-side authorization check."
    );

    expect(result.report.status).toBe("blocked");
    expect(result.report.exportAllowed).toBe(false);
    expect(result.report.risks).toContainEqual({
      category: "architecture-disclosure",
      severity: "blocked",
      message: "Security architecture detail was redacted."
    });
    expect(result.redactedText).toContain("[redacted-architecture]");
  });

  it("leaves benign admin-dashboard styling copy safe", () => {
    const result = checkDraftSafety("Polished the admin dashboard styling.");

    expect(result.report.status).toBe("safe");
    expect(result.report.exportAllowed).toBe(true);
    expect(result.redactedText).toBe("Polished the admin dashboard styling.");
  });
});

describe("safety-report architecture-disclosure core-vs-residual severity (UNC-207 / T3)", () => {
  it("blocks when the core content IS the access-control mechanism (2026-06-05 reproduction class)", () => {
    const result = checkDraftSafety(
      [
        "Today was all about the admin allowlist and the route guard.",
        "Rewrote the auth checkpoint so the server-side authorization check runs first.",
        "Nothing else happened, this was the whole day."
      ].join(" ")
    );

    expect(result.report.status).toBe("blocked");
    expect(result.report.exportAllowed).toBe(false);
    expect(result.report.risks).toContainEqual({
      category: "architecture-disclosure",
      severity: "blocked",
      message: "Security architecture detail was redacted."
    });
    expect(result.report.redactionsApplied).toContainEqual({
      category: "architecture-disclosure",
      replacement: "[redacted-architecture]",
      count: 4
    });
    expect(result.redactedText).not.toContain("admin allowlist");
    expect(result.redactedText).not.toContain("route guard");
  });

  it("warns (does not block) a single incidental architecture-disclosure mention", () => {
    const result = checkDraftSafety(
      "Quiet day overall. In passing, docs now mention the route guard once. Otherwise just cleaned up TODOs."
    );

    expect(result.report.status).toBe("warning");
    expect(result.report.exportAllowed).toBe(true);
    expect(result.report.risks).toContainEqual({
      category: "architecture-disclosure",
      severity: "warning",
      message:
        "Security architecture detail was redacted; residual mention should be reviewed before export."
    });
    expect(result.report.redactionsApplied).toContainEqual({
      category: "architecture-disclosure",
      replacement: "[redacted-architecture]",
      count: 1
    });
    expect(result.redactedText).toContain("[redacted-architecture]");
    expect(result.redactedText).not.toContain("route guard");
  });

  it("warns (does not block) when ONE disclosure class is repeated across fields (draft+caption echo)", () => {
    // Two RAW occurrences of the same fact ("route guard"), as happens when a
    // slide body and the caption both describe the same incidental event.
    // One distinct class -> still a warning, still exportable (parent AC1).
    const result = checkDraftSafety(
      [
        "Fixed the route guard bug in the morning.",
        "Caption: today I finally fixed that route guard bug."
      ].join("\n")
    );

    expect(result.report.status).toBe("warning");
    expect(result.report.exportAllowed).toBe(true);
    expect(result.report.risks).toContainEqual({
      category: "architecture-disclosure",
      severity: "warning",
      message:
        "Security architecture detail was redacted; residual mention should be reviewed before export."
    });
    expect(result.report.redactionsApplied).toContainEqual({
      category: "architecture-disclosure",
      replacement: "[redacted-architecture]",
      count: 2
    });
    expect(result.redactedText).not.toContain("route guard");
  });

  it("round-trips a blocked architecture-disclosure report through isSafetyReport", () => {
    const result = checkDraftSafety(
      "The route guard and the admin allowlist were both rewritten today."
    );

    expect(result.report.status).toBe("blocked");
    const roundTripped = JSON.parse(JSON.stringify(result.report)) as unknown;
    expect(isSafetyReport(roundTripped)).toBe(true);
  });

  it("round-trips a warning architecture-disclosure report through isSafetyReport", () => {
    const result = checkDraftSafety(
      "Mentioned the route guard once while writing changelog notes."
    );

    expect(result.report.status).toBe("warning");
    const roundTripped = JSON.parse(JSON.stringify(result.report)) as unknown;
    expect(isSafetyReport(roundTripped)).toBe(true);
  });
});

describe("safety-report private-repo-remote (UNC-152)", () => {
  it("masks SSH-style remote URLs with git+ssh prefix", () => {
    const r = checkDraftSafety(
      "see git+ssh://git@github.com/foo/bar.git for details"
    );
    expect(r.redactedText).not.toContain(
      "git+ssh://git@github.com/foo/bar.git"
    );
    expect(
      r.report.risks.some((x) => x.category === "private-repo-remote")
    ).toBe(true);
  });

  it("preserves public org/repo references that aren't URLs", () => {
    const r = checkDraftSafety("our example is github.com/foo/bar in docs");
    expect(r.redactedText).toContain("github.com/foo/bar");
  });
});
