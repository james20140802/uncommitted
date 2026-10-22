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
    return false;
  }
}
