// Harness / agent-infrastructure text that must never become an ActivitySignal.
const NOISE_TAG_NAMES = [
  "local-command-[\\w-]+",
  "command-(?:name|message|args)",
  "system-reminder",
  "task-notification"
];

const NOISE_TAG_START = new RegExp(`^<(?:${NOISE_TAG_NAMES.join("|")})\\b`);
const AGENTS_INSTRUCTIONS_START = /^(?:# AGENTS\.md instructions|<INSTRUCTIONS>)/;
const TOOL_EXEC_RESULT_START = /^\[\d+\]\s*tool exec result:/;
const AGENT_MESSAGE_START = /^Agent message from\b/;
// Approval JSON cut short (signal summaries and stored thread notes are
// truncated) no longer parses; its leading `risk_level` key still marks it.
const TRUNCATED_APPROVAL_JSON_START = /^\{\s*"risk_level"\s*:/;

export function isHarnessNoise(text: string): boolean {
  const t = text.trimStart();
  if (t === "") return false;
  if (NOISE_TAG_START.test(t)) return true;
  if (AGENTS_INSTRUCTIONS_START.test(t)) return true;
  if (TOOL_EXEC_RESULT_START.test(t)) return true;
  if (AGENT_MESSAGE_START.test(t) && t.includes("Message Type:")) return true;
  if (t.startsWith("{")) return isApprovalJson(t);
  return false;
}

function isApprovalJson(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "risk_level" in parsed &&
      "outcome" in parsed
    );
  } catch {
    return TRUNCATED_APPROVAL_JSON_START.test(text);
  }
}

const SLASH_COMMAND_START = /^<command-(?:message|name)>/;
const SLASH_COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const SLASH_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * A slash-command block (`<command-name>/babysit</command-name>` +
 * `<command-args>PR 145</command-args>`) is noise as raw markup, but its
 * args are what the user actually asked for. Returns `/name args`, or null
 * when the block is not a slash command or carries no args.
 */
export function extractSlashCommandRequest(block: string): string | null {
  if (!SLASH_COMMAND_START.test(block.trimStart())) return null;
  const name = SLASH_COMMAND_NAME.exec(block)?.[1]?.trim().replace(/^\/+/, "");
  const args = SLASH_COMMAND_ARGS.exec(block)?.[1]?.trim();
  if (!name || !args) return null;
  return `/${name} ${args}`;
}

/** Tool-call signal kinds (`claude-tool`, `codex-tool`, …): harness noise, not story material. */
export function isToolSignalKind(kind: string): boolean {
  return kind.endsWith("-tool");
}

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec",
  "exec_command",
  "ToolSearch",
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Agent",
  "Task",
  "WebFetch",
  "WebSearch",
  "apply_patch",
  "shell",
  "read_file"
]);

// `\w` already covers `_`, so one character class matches `mcp__server__tool`
// without nested repetition (which backtracks exponentially).
const MCP_TOOL_NAME = /^mcp__[\w-]+$/;
// No leading/trailing `\s*`: the caller trims instead, so long runs of spaces
// cannot trigger polynomial backtracking.
const SMALL_COUNT_SUFFIX = /(?::\s*\d+(?:st|nd|rd|th)\s+time|\(\s*[x×]\s*\d+\s*\)|[x×]\s*\d+)$/i;

/** A stored thread note that is only a harness tool name (optionally with a small count suffix). */
export function isToolNameOnlyNote(note: string): boolean {
  const base = note.trim().replace(SMALL_COUNT_SUFFIX, "").trimEnd();
  return MCP_TOOL_NAME.test(base) || KNOWN_TOOL_NAMES.has(base);
}

/** Read-time filter for memory threads: harness text or a bare tool name. */
export function isMemoryNoiseNote(note: string): boolean {
  return isHarnessNoise(note) || isToolNameOnlyNote(note);
}
