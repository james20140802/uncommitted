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

  it("includes every text block of a multi-part user message", () => {
    const contents = line({
      type: "user",
      timestamp: "2026-06-13T05:00:00.000Z",
      message: {
        content: [
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." }
        ]
      }
    });
    const result = parseClaudeSession({ projectId: "p1", contents });
    expect(result.conversation).toEqual([
      {
        role: "user",
        text: "First part.\nSecond part.",
        timestamp: "2026-06-13T05:00:00.000Z"
      }
    ]);
    expect(result.signals[0].summary).toContain("First part.");
    expect(result.signals[0].summary).toContain("Second part.");
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

describe("harness noise", () => {
  it("keeps noise turns in conversation but out of signals", () => {
    const user = (text: string, n: number) =>
      line({
        type: "user",
        timestamp: `2026-06-13T05:00:0${n}.000Z`,
        message: { content: text }
      });
    const contents = [
      user("<local-command-caveat>Caveat: synthetic</local-command-caveat>", 0),
      user("<command-message>review</command-message>", 1),
      user("# AGENTS.md instructions for /repo\n\nsynthetic", 2),
      user("PR 128 끝까지 봐줘", 3),
      line({
        type: "assistant",
        timestamp: "2026-06-13T05:00:04.000Z",
        message: {
          content: [
            { type: "text", text: "<system-reminder>synthetic</system-reminder>" },
            { type: "text", text: "Looking at the PR now." }
          ]
        }
      })
    ].join("\n");

    const result = parseClaudeSession({ projectId: "p1", contents });

    expect(result.signals.map((s) => s.summary)).toEqual([
      "PR 128 끝까지 봐줘",
      "Looking at the PR now."
    ]);
    expect(result.conversation).toHaveLength(6);
  });

  it("drops only the noise blocks of a multi-block user turn", () => {
    const contents = line({
      type: "user",
      timestamp: "2026-06-13T05:00:00.000Z",
      message: {
        content: [
          { type: "text", text: "<system-reminder>synthetic</system-reminder>" },
          { type: "text", text: "PR 128 끝까지 봐줘" }
        ]
      }
    });

    const result = parseClaudeSession({ projectId: "p1", contents });

    expect(result.signals.map((s) => s.summary)).toEqual(["PR 128 끝까지 봐줘"]);
    expect(result.conversation[0]?.text).toBe(
      "<system-reminder>synthetic</system-reminder>\nPR 128 끝까지 봐줘"
    );
  });

  it("emits no signal when every user block is noise", () => {
    const contents = line({
      type: "user",
      timestamp: "2026-06-13T05:00:00.000Z",
      message: {
        content: [
          { type: "text", text: "<system-reminder>a</system-reminder>" },
          { type: "text", text: "<task-notification>b</task-notification>" }
        ]
      }
    });

    const result = parseClaudeSession({ projectId: "p1", contents });

    expect(result.signals).toEqual([]);
    expect(result.conversation).toHaveLength(1);
  });

  const SLASH_BLOCK =
    "<command-message>babysit is running…</command-message>\n<command-name>/babysit</command-name>\n<command-args>PR 145</command-args>";
  const userLine = (content: unknown) =>
    line({
      type: "user",
      timestamp: "2026-06-13T05:00:00.000Z",
      message: { content }
    });

  it("keeps the request of a slash command as a user-turn signal", () => {
    const result = parseClaudeSession({
      projectId: "p1",
      contents: userLine(SLASH_BLOCK)
    });

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.kind).toBe("claude-user-turn");
    expect(result.signals[0]?.summary).toBe("/babysit PR 145");
    expect(result.conversation[0]?.text).toBe(SLASH_BLOCK);
  });

  it("extracts the slash command request without a command-message line", () => {
    const result = parseClaudeSession({
      projectId: "p1",
      contents: userLine(
        "<command-name>/babysit</command-name>\n<command-args>PR 145</command-args>"
      )
    });

    expect(result.signals.map((s) => s.summary)).toEqual(["/babysit PR 145"]);
  });

  it("stays silent for slash commands without arguments", () => {
    const contents = [
      userLine("<command-name>/clear</command-name>"),
      userLine("<command-name>/clear</command-name>\n<command-args></command-args>")
    ].join("\n");

    expect(parseClaudeSession({ projectId: "p1", contents }).signals).toEqual([]);
  });

  it("joins a slash command request with the next block of the same turn", () => {
    const result = parseClaudeSession({
      projectId: "p1",
      contents: userLine([
        { type: "text", text: SLASH_BLOCK },
        { type: "text", text: "그리고 테스트도" }
      ])
    });

    expect(result.signals.map((s) => s.summary)).toEqual([
      "/babysit PR 145\n그리고 테스트도"
    ]);
  });
});
