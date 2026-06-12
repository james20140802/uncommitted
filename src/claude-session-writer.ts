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

  const rawLines: string[] = [];
  for (const turn of input.conversation) {
    rawLines.push(
      JSON.stringify({
        kind: "turn",
        role: turn.role,
        text: turn.text,
        timestamp: turn.timestamp
      })
    );
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
    rawLines.push(JSON.stringify(payload));
  }
  const rawBody = rawLines.length ? rawLines.join("\n") + "\n" : "";

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
