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

export type ClaudeSessionParseResult = {
  signals: ActivitySignal[];
  conversation: ConversationTurn[];
  toolFacts: ToolFact[];
};

export type ClaudeSessionParseInput = {
  projectId: string;
  contents: string;
};

const SUMMARY_LIMIT = 200;
const COMMAND_LIMIT = 200;

export function parseClaudeSession(
  input: ClaudeSessionParseInput
): ClaudeSessionParseResult {
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

    if (entry.type === "user") {
      const text = extractUserText(entry);
      if (text === null) continue;
      conversation.push({ role: "user", text, timestamp });
      signals.push(makeSignal(input.projectId, timestamp, "claude-user-turn", text));
      continue;
    }

    if (entry.type === "assistant") {
      const blocks = extractAssistantBlocks(entry);
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          conversation.push({ role: "assistant", text: block.text, timestamp });
          signals.push(
            makeSignal(input.projectId, timestamp, "claude-assistant-text", block.text)
          );
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          conversation.push({ role: "assistant", text: block.thinking, timestamp });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const target = extractToolTarget(block.input);
          toolFacts.push({ tool: block.name, target, timestamp });
          const summary = (target ? `${block.name} ${target}` : block.name).trim();
          signals.push(makeSignal(input.projectId, timestamp, "claude-tool", summary));
        }
      }
      continue;
    }
  }

  return { signals, conversation, toolFacts };
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

function extractUserText(entry: Record<string, unknown>): string | null {
  const message = entry.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return null;
}

function extractAssistantBlocks(entry: Record<string, unknown>): unknown[] {
  const message = entry.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content;
}

function extractToolTarget(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.command === "string") {
    return input.command.length > COMMAND_LIMIT
      ? input.command.slice(0, COMMAND_LIMIT)
      : input.command;
  }
  if (typeof input.url === "string") return input.url;
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
