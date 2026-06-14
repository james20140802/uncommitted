// tests/codex-session-redactor.test.ts
import { describe, it, expect } from "vitest";
import { redactCodexSession } from "../src/codex-session-redactor.js";

describe("redactCodexSession", () => {
  it("masks vendor secrets in conversation and signals", () => {
    const result = redactCodexSession({
      signals: [
        {
          projectId: "p1",
          timestamp: "t",
          kind: "codex-user-turn",
          summary: "token AKIAABCDEFGHIJKLMNOP and email a@b.com",
          safetyNotes: []
        }
      ],
      conversation: [
        { role: "user", text: "key=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", timestamp: "t" }
      ],
      toolFacts: [
        { tool: "read_file", target: "/Users/me/secret.env", timestamp: "t" }
      ]
    });

    expect(result.signals[0].summary).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.signals[0].summary).not.toContain("a@b.com");
    expect(result.conversation[0].text).not.toContain("ghp_");
    expect(result.toolFacts[0].target).not.toContain("/Users/me");
    expect(result.appliedCategories.length).toBeGreaterThan(0);
  });

  it("leaves benign prose untouched", () => {
    const result = redactCodexSession({
      signals: [],
      conversation: [
        { role: "user", text: "hello what is this codebase doing", timestamp: "t" }
      ],
      toolFacts: []
    });
    expect(result.conversation[0].text).toBe(
      "hello what is this codebase doing"
    );
    expect(result.appliedCategories).toEqual([]);
  });

  it("passes through tool facts without target", () => {
    const result = redactCodexSession({
      signals: [],
      conversation: [],
      toolFacts: [{ tool: "exec_command_end", timestamp: "t" }]
    });
    expect(result.toolFacts[0].target).toBeUndefined();
  });
});
