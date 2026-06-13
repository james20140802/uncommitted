// src/codex-session-parser.ts
import type { ActivitySignal } from "./event-source.js";

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export type ToolFact = {
  tool: string;
  target?: string;
  timestamp: string;
};

export type CodexSessionParseResult = {
  signals: ActivitySignal[];
  conversation: ConversationTurn[];
  toolFacts: ToolFact[];
};

export type CodexSessionParseInput = {
  projectId: string;
  contents: string;
};

const SUMMARY_LIMIT = 200;
const COMMAND_LIMIT = 200;

export function parseCodexSession(
  input: CodexSessionParseInput
): CodexSessionParseResult {
  const signals: ActivitySignal[] = [];
  const conversation: ConversationTurn[] = [];
  const toolFacts: ToolFact[] = [];

  for (const raw of input.contents.split("\n")) {
    if (raw.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const topType = entry.type;

    if (topType === "response_item") {
      handleResponseItem(input.projectId, entry, timestamp, {
        signals,
        conversation,
        toolFacts
      });
      continue;
    }

    if (topType === "event_msg") {
      handleEventMsg(input.projectId, entry, timestamp, {
        signals,
        conversation,
        toolFacts
      });
      continue;
    }
    // session_meta, turn_context, token_count, and unknown types: skip.
  }

  return { signals, conversation, toolFacts };
}

type Sink = {
  signals: ActivitySignal[];
  conversation: ConversationTurn[];
  toolFacts: ToolFact[];
};

function handleResponseItem(
  projectId: string,
  entry: Record<string, unknown>,
  timestamp: string,
  sink: Sink
): void {
  const payload = entry.payload;
  if (!isRecord(payload)) return;
  const ptype = payload.type;

  if (ptype === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return;
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const bType = block.type;
      const bText = typeof block.text === "string" ? block.text : null;
      if (bText === null) continue;
      if (
        bType !== "input_text" &&
        bType !== "output_text" &&
        bType !== "text"
      ) {
        continue;
      }
      sink.conversation.push({ role, text: bText, timestamp });
      sink.signals.push(
        makeSignal(
          projectId,
          timestamp,
          role === "user" ? "codex-user-turn" : "codex-assistant-text",
          bText
        )
      );
    }
    return;
  }

  if (ptype === "reasoning") {
    const text = extractReasoningText(payload);
    if (!text) return;
    sink.conversation.push({ role: "assistant", text, timestamp });
    return;
  }

  if (ptype === "function_call" || ptype === "custom_tool_call") {
    const tool =
      typeof payload.name === "string" ? payload.name : String(ptype);
    const target = extractFunctionTarget(payload);
    sink.toolFacts.push({ tool, target, timestamp });
    const summary = (target ? `${tool} ${target}` : tool).trim();
    sink.signals.push(makeSignal(projectId, timestamp, "codex-tool", summary));
    return;
  }
  // function_call_output, custom_tool_call_output: discard body.
}

function handleEventMsg(
  projectId: string,
  entry: Record<string, unknown>,
  timestamp: string,
  sink: Sink
): void {
  const payload = entry.payload;
  if (!isRecord(payload)) return;
  const ptype = payload.type;

  if (ptype === "user_message" || ptype === "agent_message") {
    const text = typeof payload.message === "string" ? payload.message : "";
    if (!text) return;
    const role: "user" | "assistant" =
      ptype === "user_message" ? "user" : "assistant";
    sink.conversation.push({ role, text, timestamp });
    sink.signals.push(
      makeSignal(
        projectId,
        timestamp,
        role === "user" ? "codex-user-turn" : "codex-assistant-text",
        text
      )
    );
    return;
  }

  if (
    ptype === "exec_command_end" ||
    ptype === "exec_command_begin" ||
    ptype === "patch_apply_end" ||
    ptype === "patch_apply_begin"
  ) {
    const target = extractEventTarget(payload);
    sink.toolFacts.push({ tool: String(ptype), target, timestamp });
    const summary = (target ? `${ptype} ${target}` : String(ptype)).trim();
    sink.signals.push(makeSignal(projectId, timestamp, "codex-tool", summary));
    return;
  }
}

function makeSignal(
  projectId: string,
  timestamp: string,
  kind: string,
  text: string
): ActivitySignal {
  return {
    projectId,
    timestamp,
    kind,
    summary: text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) : text,
    safetyNotes: []
  };
}

function extractReasoningText(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text;
  if (Array.isArray(payload.summary)) {
    const parts: string[] = [];
    for (const block of payload.summary) {
      if (isRecord(block) && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function extractFunctionTarget(payload: Record<string, unknown>): string | undefined {
  const args = payload.arguments;
  if (typeof args !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return truncate(args, COMMAND_LIMIT);
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.file_path === "string") return parsed.file_path;
  if (typeof parsed.path === "string") return parsed.path;
  if (typeof parsed.command === "string") return truncate(parsed.command, COMMAND_LIMIT);
  if (Array.isArray(parsed.command)) {
    const joined = parsed.command.filter((x) => typeof x === "string").join(" ");
    return truncate(joined, COMMAND_LIMIT);
  }
  if (typeof parsed.url === "string") return parsed.url;
  return undefined;
}

function extractEventTarget(payload: Record<string, unknown>): string | undefined {
  if (Array.isArray(payload.command)) {
    const joined = payload.command.filter((x) => typeof x === "string").join(" ");
    if (joined) return truncate(joined, COMMAND_LIMIT);
  }
  if (typeof payload.command === "string") {
    return truncate(payload.command, COMMAND_LIMIT);
  }
  if (typeof payload.path === "string") return payload.path;
  if (typeof payload.cwd === "string") return payload.cwd;
  return undefined;
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit) : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
