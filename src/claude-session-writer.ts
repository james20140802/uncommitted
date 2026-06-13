import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivitySignal } from "./event-source.js";
import type { ConversationTurn, ToolFact } from "./claude-session-parser.js";

export type ClaudeSessionWriteInput = {
  projectRoot: string;
  targetDate: string;
  signals: ActivitySignal[];
  conversation: ConversationTurn[];
  toolFacts: ToolFact[];
};

export type ClaudeSessionWriteResult = {
  signalsFile: string;
  rawArchiveFile: string;
  signalCount: number;
  conversationCount: number;
  toolFactCount: number;
};

export async function writeClaudeSessionOutputs(
  input: ClaudeSessionWriteInput
): Promise<ClaudeSessionWriteResult> {
  const baseDir = join(input.projectRoot, ".uncommitted", "events", "claude");
  const rawDir = join(baseDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const signalsFile = join(baseDir, `${input.targetDate}.jsonl`);
  const rawArchiveFile = join(rawDir, `${input.targetDate}.jsonl`);

  const signalsBody = input.signals.length
    ? input.signals.map((s) => JSON.stringify(s)).join("\n") + "\n"
    : "";

  // Interleave conversation turns and tool facts by timestamp so the Tier 1
  // archive preserves the real session timeline (e.g. user -> tool -> assistant)
  // instead of writing all turns first and all tool facts last. The sort is
  // stable, so entries sharing a timestamp keep their original turn-before-tool
  // order (matches how the parser emits blocks within a single message).
  const rawEntries: { timestamp: string; line: string }[] = [];
  for (const turn of input.conversation) {
    rawEntries.push({
      timestamp: turn.timestamp,
      line: JSON.stringify({
        kind: "turn",
        role: turn.role,
        text: turn.text,
        timestamp: turn.timestamp
      })
    });
  }
  for (const fact of input.toolFacts) {
    const payload: Record<string, unknown> = {
      kind: "tool",
      tool: fact.tool,
      timestamp: fact.timestamp
    };
    if (fact.target !== undefined) {
      payload.target = fact.target;
    }
    rawEntries.push({ timestamp: fact.timestamp, line: JSON.stringify(payload) });
  }
  rawEntries.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
  const rawBody = rawEntries.length
    ? rawEntries.map((entry) => entry.line).join("\n") + "\n"
    : "";

  await writeFile(signalsFile, signalsBody, "utf8");
  await writeFile(rawArchiveFile, rawBody, { encoding: "utf8", mode: 0o600 });
  // Belt-and-suspenders: writeFile honors mode only when CREATING the file.
  // On rewrite, chmod ensures the 0600 invariant survives.
  await chmod(rawArchiveFile, 0o600);

  return {
    signalsFile,
    rawArchiveFile,
    signalCount: input.signals.length,
    conversationCount: input.conversation.length,
    toolFactCount: input.toolFacts.length
  };
}
