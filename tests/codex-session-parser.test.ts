// tests/codex-session-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseCodexSession } from "../src/codex-session-parser.js";

const META_LINE = JSON.stringify({
  timestamp: "2026-06-13T14:17:57.191Z",
  type: "session_meta",
  payload: { id: "sess-1", cwd: "/repo" }
});

const USER_MESSAGE = JSON.stringify({
  timestamp: "2026-06-13T14:18:00.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello codex" }]
  }
});

const ASSISTANT_MESSAGE = JSON.stringify({
  timestamp: "2026-06-13T14:18:05.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    content: [
      { type: "output_text", text: "hi there" },
      { type: "output_text", text: " and more" }
    ]
  }
});

const FUNCTION_CALL = JSON.stringify({
  timestamp: "2026-06-13T14:18:10.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "read_file",
    arguments: JSON.stringify({ file_path: "/repo/src/index.ts" })
  }
});

const FUNCTION_OUTPUT = JSON.stringify({
  timestamp: "2026-06-13T14:18:11.000Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    output: "BIG SECRET BODY THAT MUST NOT LEAK"
  }
});

const EVENT_USER = JSON.stringify({
  timestamp: "2026-06-13T14:18:12.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "from event_msg user" }
});

const EVENT_AGENT = JSON.stringify({
  timestamp: "2026-06-13T14:18:13.000Z",
  type: "event_msg",
  payload: { type: "agent_message", message: "from event_msg agent" }
});

const EXEC_END = JSON.stringify({
  timestamp: "2026-06-13T14:18:14.000Z",
  type: "event_msg",
  payload: {
    type: "exec_command_end",
    command: ["ls", "-la"],
    stdout: "SHOULD NOT APPEAR",
    stderr: "ALSO NOT"
  }
});

const EXEC_FUNCTION_CALL_CMD = JSON.stringify({
  timestamp: "2026-06-13T14:18:15.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "cargo test" })
  }
});

const DEVELOPER_PROMPT = JSON.stringify({
  timestamp: "2026-06-13T14:18:00.500Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "system prompt scaffolding" }]
  }
});

describe("parseCodexSession", () => {
  it("ignores meta-only lines", () => {
    const result = parseCodexSession({ projectId: "p1", contents: META_LINE });
    expect(result.signals).toEqual([]);
    expect(result.conversation).toEqual([]);
    expect(result.toolFacts).toEqual([]);
  });

  it("captures user message text from response_item.message", () => {
    const result = parseCodexSession({ projectId: "p1", contents: USER_MESSAGE });
    expect(result.conversation).toEqual([
      {
        role: "user",
        text: "hello codex",
        timestamp: "2026-06-13T14:18:00.000Z"
      }
    ]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].kind).toBe("codex-user-turn");
  });

  it("concatenates assistant message blocks and emits one turn + signal per block", () => {
    const result = parseCodexSession({
      projectId: "p1",
      contents: ASSISTANT_MESSAGE
    });
    expect(result.conversation).toHaveLength(2);
    expect(result.conversation[0].role).toBe("assistant");
    expect(result.conversation.map((c) => c.text)).toEqual([
      "hi there",
      " and more"
    ]);
    expect(result.signals.map((s) => s.kind)).toEqual([
      "codex-assistant-text",
      "codex-assistant-text"
    ]);
  });

  it("extracts function_call as a tool fact with target", () => {
    const result = parseCodexSession({ projectId: "p1", contents: FUNCTION_CALL });
    expect(result.toolFacts).toEqual([
      {
        tool: "read_file",
        target: "/repo/src/index.ts",
        timestamp: "2026-06-13T14:18:10.000Z"
      }
    ]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].kind).toBe("codex-tool");
  });

  it("discards function_call_output body entirely (no signal, no fact, no conversation)", () => {
    const result = parseCodexSession({
      projectId: "p1",
      contents: FUNCTION_OUTPUT
    });
    expect(result.signals).toEqual([]);
    expect(result.conversation).toEqual([]);
    expect(result.toolFacts).toEqual([]);
  });

  it("captures event_msg.user_message and agent_message", () => {
    const result = parseCodexSession({
      projectId: "p1",
      contents: [EVENT_USER, EVENT_AGENT].join("\n")
    });
    expect(result.conversation).toEqual([
      {
        role: "user",
        text: "from event_msg user",
        timestamp: "2026-06-13T14:18:12.000Z"
      },
      {
        role: "assistant",
        text: "from event_msg agent",
        timestamp: "2026-06-13T14:18:13.000Z"
      }
    ]);
  });

  it("does not emit a Tier 2 signal for event_msg.agent_message (kept in raw archive only)", () => {
    // agent_message is a UI echo of the assistant turn already captured as a
    // response_item/message signal. Emitting it again double-counts (and can
    // surface reasoning) into activity summaries, so it stays conversation-only.
    const result = parseCodexSession({ projectId: "p1", contents: EVENT_AGENT });
    expect(result.conversation).toHaveLength(1);
    expect(result.conversation[0].role).toBe("assistant");
    expect(result.signals).toEqual([]);
  });

  it("reads exec_command cmd argument as the tool target", () => {
    const result = parseCodexSession({
      projectId: "p1",
      contents: EXEC_FUNCTION_CALL_CMD
    });
    expect(result.toolFacts).toEqual([
      {
        tool: "exec_command",
        target: "cargo test",
        timestamp: "2026-06-13T14:18:15.000Z"
      }
    ]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].summary).toBe("exec_command cargo test");
  });

  it("records exec_command_end as a tool fact without body", () => {
    const result = parseCodexSession({ projectId: "p1", contents: EXEC_END });
    expect(result.toolFacts).toHaveLength(1);
    expect(result.toolFacts[0].tool).toBe("exec_command_end");
    expect(JSON.stringify(result.toolFacts[0])).not.toContain("SHOULD NOT APPEAR");
    expect(JSON.stringify(result)).not.toContain("SHOULD NOT APPEAR");
    expect(JSON.stringify(result)).not.toContain("ALSO NOT");
  });

  it("drops developer/system role messages (prompt scaffolding)", () => {
    const result = parseCodexSession({
      projectId: "p1",
      contents: DEVELOPER_PROMPT
    });
    expect(result.conversation).toEqual([]);
    expect(result.signals).toEqual([]);
  });

  it("skips malformed JSON lines and continues parsing", () => {
    const contents = ["not json", USER_MESSAGE, "{broken"].join("\n");
    const result = parseCodexSession({ projectId: "p1", contents });
    expect(result.conversation).toHaveLength(1);
  });
});
