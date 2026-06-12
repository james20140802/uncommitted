import { describe, it, expect } from "vitest";
import { parseClaudeSession } from "../src/claude-session-parser.js";

const line = (obj: unknown) => JSON.stringify(obj);

describe("parseClaudeSession", () => {
  it("emits signals + conversation + tool facts in input order", () => {
    const contents = [
      line({
        type: "user",
        timestamp: "2026-06-13T05:00:00.000Z",
        message: { content: "Implement the parser." }
      }),
      line({
        type: "assistant",
        timestamp: "2026-06-13T05:00:01.000Z",
        message: {
          content: [
            { type: "text", text: "OK, starting." },
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/Users/alice/Developer/uncommitted/src/cli.ts" }
            }
          ]
        }
      }),
      line({
        type: "user",
        timestamp: "2026-06-13T05:00:02.000Z",
        message: {
          content: [{ type: "text", text: "Also check the tests." }]
        }
      })
    ].join("\n");

    const result = parseClaudeSession({ projectId: "p1", contents });

    expect(result.conversation.map((c) => [c.role, c.text])).toEqual([
      ["user", "Implement the parser."],
      ["assistant", "OK, starting."],
      ["user", "Also check the tests."]
    ]);

    expect(result.toolFacts).toEqual([
      {
        tool: "Read",
        target: "/Users/alice/Developer/uncommitted/src/cli.ts",
        timestamp: "2026-06-13T05:00:01.000Z"
      }
    ]);

    expect(result.signals.map((s) => s.kind)).toEqual([
      "claude-user-turn",
      "claude-assistant-text",
      "claude-tool",
      "claude-user-turn"
    ]);
    expect(result.signals.every((s) => s.projectId === "p1")).toBe(true);
    expect(result.signals.every((s) => Array.isArray(s.safetyNotes) && s.safetyNotes.length === 0)).toBe(true);
  });

  it("emits thinking blocks into conversation but not into signals", () => {
    const contents = line({
      type: "assistant",
      timestamp: "2026-06-13T05:00:00.000Z",
      message: {
        content: [{ type: "thinking", thinking: "private reasoning" }]
      }
    });
    const result = parseClaudeSession({ projectId: "p1", contents });
    expect(result.conversation).toEqual([
      {
        role: "assistant",
        text: "private reasoning",
        timestamp: "2026-06-13T05:00:00.000Z"
      }
    ]);
    expect(result.signals).toEqual([]);
  });

  it("truncates signal summary to 200 chars but keeps full conversation text", () => {
    const longText = "x".repeat(500);
    const contents = line({
      type: "user",
      timestamp: "2026-06-13T05:00:00.000Z",
      message: { content: longText }
    });
    const result = parseClaudeSession({ projectId: "p1", contents });
    expect(result.conversation[0].text.length).toBe(500);
    expect(result.signals[0].summary.length).toBe(200);
  });

  it("never carries tool_use_result content in any output", () => {
    const contents = [
      line({
        type: "assistant",
        timestamp: "2026-06-13T05:00:00.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "cat secrets.env" }
            }
          ]
        }
      }),
      line({
        type: "user",
        timestamp: "2026-06-13T05:00:01.000Z",
        toolUseResult: {
          content: "AKIAIOSFODNN7EXAMPLE\nDB_PASSWORD=hunter2hunter2"
        },
        message: {
          content: [{ type: "tool_result", content: "AKIAIOSFODNN7EXAMPLE" }]
        }
      })
    ].join("\n");

    const result = parseClaudeSession({ projectId: "p1", contents });
    const allText = JSON.stringify(result);
    expect(allText).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(allText).not.toContain("hunter2hunter2");
  });

  it("skips malformed lines without throwing", () => {
    const contents = [
      "not json at all",
      line({ type: "user", message: { content: "hi" } }),
      "{also not json",
      ""
    ].join("\n");
    const result = parseClaudeSession({ projectId: "p1", contents });
    expect(result.conversation).toEqual([
      { role: "user", text: "hi", timestamp: "" }
    ]);
  });

  it("extracts target from file_path, then path, then command, then url", () => {
    const contents = [
      line({ type: "assistant", timestamp: "t1", message: { content: [{ type: "tool_use", name: "A", input: { file_path: "/a.ts", path: "/x" } }] } }),
      line({ type: "assistant", timestamp: "t2", message: { content: [{ type: "tool_use", name: "B", input: { path: "/b" } }] } }),
      line({ type: "assistant", timestamp: "t3", message: { content: [{ type: "tool_use", name: "C", input: { command: "ls -la" } }] } }),
      line({ type: "assistant", timestamp: "t4", message: { content: [{ type: "tool_use", name: "D", input: { url: "https://example.com" } }] } }),
      line({ type: "assistant", timestamp: "t5", message: { content: [{ type: "tool_use", name: "E", input: {} }] } })
    ].join("\n");
    const result = parseClaudeSession({ projectId: "p1", contents });
    expect(result.toolFacts.map((t) => [t.tool, t.target])).toEqual([
      ["A", "/a.ts"],
      ["B", "/b"],
      ["C", "ls -la"],
      ["D", "https://example.com"],
      ["E", undefined]
    ]);
  });
});
