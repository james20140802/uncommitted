// src/codex-session-attribution.ts
import { readFile } from "node:fs/promises";

export async function readCodexSessionCwd(path: string): Promise<string | null> {
  const contents = await readFile(path, "utf8");
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const top = parsed as Record<string, unknown>;
    if (top.type !== "session_meta" && top.type !== "turn_context") continue;
    const payload = top.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const cwd = (payload as Record<string, unknown>).cwd;
    if (typeof cwd === "string") return cwd;
  }
  return null;
}

// Re-export the shared attribution function so the Codex command does not
// need to import from a Claude-named module. Implementation lives in
// claude-session-attribution.ts and is source-agnostic.
export { attributeCwdToProject } from "./claude-session-attribution.js";
export type { ClaudeSessionAttribution as CodexSessionAttribution } from "./claude-session-attribution.js";
