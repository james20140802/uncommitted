import { describe, it, expect } from "vitest";
import { redactClaudeSession } from "../src/claude-session-redactor.js";
import type { ClaudeSessionParseResult } from "../src/claude-session-parser.js";

const baseParsed = (): ClaudeSessionParseResult => ({
  signals: [],
  conversation: [],
  toolFacts: []
});

describe("redactClaudeSession", () => {
  it("masks vendor secrets in conversation text and reports the vendor api tokens category", () => {
    const parsed: ClaudeSessionParseResult = {
      ...baseParsed(),
      conversation: [
        { role: "user", text: "Use AKIAIOSFODNN7EXAMPLE for AWS", timestamp: "t" }
      ]
    };
    const result = redactClaudeSession(parsed);
    expect(result.conversation[0].text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.appliedCategories).toContain("vendor api tokens");
  });

  it("also strips emails / paths / private URLs via sanitizeText", () => {
    const parsed: ClaudeSessionParseResult = {
      ...baseParsed(),
      conversation: [
        {
          role: "assistant",
          text: "ping alice@example.com or check /Users/alice/secret and git@github.com:org/repo.git",
          timestamp: "t"
        }
      ]
    };
    const result = redactClaudeSession(parsed);
    expect(result.conversation[0].text).not.toContain("alice@example.com");
    expect(result.conversation[0].text).not.toContain("/Users/alice/secret");
    expect(result.conversation[0].text).not.toContain("git@github.com:org/repo.git");
    expect(result.appliedCategories).toEqual(
      expect.arrayContaining(["emails", "local absolute paths", "private URLs"])
    );
  });

  it("populates signal.safetyNotes with applied categories per signal", () => {
    const parsed: ClaudeSessionParseResult = {
      ...baseParsed(),
      signals: [
        {
          projectId: "p1",
          timestamp: "t",
          kind: "claude-user-turn",
          summary: "Use AKIAIOSFODNN7EXAMPLE here",
          safetyNotes: []
        }
      ]
    };
    const result = redactClaudeSession(parsed);
    expect(result.signals[0].summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.signals[0].safetyNotes).toContain("vendor api tokens");
  });

  it("masks tool-fact targets that are file paths or contain secrets", () => {
    const parsed: ClaudeSessionParseResult = {
      ...baseParsed(),
      toolFacts: [
        { tool: "Read", target: "/Users/alice/secret.env", timestamp: "t" },
        { tool: "Bash", target: "curl https://api.example.com/v1?token=ghp_" + "z".repeat(36), timestamp: "t" }
      ]
    };
    const result = redactClaudeSession(parsed);
    expect(result.toolFacts[0].target).not.toContain("/Users/alice/secret.env");
    expect(result.toolFacts[1].target).not.toContain("ghp_");
  });

  it("does not mutate the input", () => {
    const parsed: ClaudeSessionParseResult = {
      ...baseParsed(),
      conversation: [
        { role: "user", text: "AKIAIOSFODNN7EXAMPLE", timestamp: "t" }
      ]
    };
    const beforeText = parsed.conversation[0].text;
    redactClaudeSession(parsed);
    expect(parsed.conversation[0].text).toBe(beforeText);
  });

  it("leaves clean text untouched and reports empty appliedCategories", () => {
    const parsed: ClaudeSessionParseResult = {
      ...baseParsed(),
      conversation: [
        { role: "user", text: "Build the parser test fixtures.", timestamp: "t" }
      ],
      signals: [
        {
          projectId: "p1",
          timestamp: "t",
          kind: "claude-user-turn",
          summary: "Build the parser test fixtures.",
          safetyNotes: []
        }
      ]
    };
    const result = redactClaudeSession(parsed);
    expect(result.conversation[0].text).toBe("Build the parser test fixtures.");
    expect(result.signals[0].summary).toBe("Build the parser test fixtures.");
    expect(result.appliedCategories).toEqual([]);
  });
});
