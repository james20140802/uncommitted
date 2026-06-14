import type {
  CodexSessionParseResult,
  ConversationTurn,
  ToolFact
} from "./codex-session-parser.js";
import type { ActivitySignal } from "./event-source.js";
import {
  REDACTION_CATEGORY_ORDER,
  sanitizeText,
  type RedactionCategory
} from "./redaction.js";
import {
  detectSecrets,
  SECRET_CATEGORY_ORDER,
  type SecretCategory
} from "./credential-detector.js";

export type CodexRedactionCategory = RedactionCategory | SecretCategory;

export type RedactedCodexSession = {
  signals: ActivitySignal[];
  conversation: ConversationTurn[];
  toolFacts: ToolFact[];
  appliedCategories: CodexRedactionCategory[];
};

const COMBINED_ORDER: CodexRedactionCategory[] = [
  ...SECRET_CATEGORY_ORDER,
  ...REDACTION_CATEGORY_ORDER
];

function sortCategories(
  set: Set<CodexRedactionCategory>
): CodexRedactionCategory[] {
  return COMBINED_ORDER.filter((c) => set.has(c));
}

// Mirror the Claude adapter: catch SSH-style git URLs before the email
// regex eats them.
const SSH_GIT_URL = /\b[\w.-]{1,64}@[\w.-]{1,253}:[^\s]{1,4096}/g;

function redactString(value: string): {
  value: string;
  categories: CodexRedactionCategory[];
} {
  const secretPass = detectSecrets(value);

  let preUrl = secretPass.value;
  const preUrlCategories = new Set<CodexRedactionCategory>();
  if (SSH_GIT_URL.test(preUrl)) {
    preUrlCategories.add("private URLs");
    SSH_GIT_URL.lastIndex = 0;
    preUrl = preUrl.replace(SSH_GIT_URL, "[redacted-url]");
  }

  const textPass = sanitizeText(preUrl);
  const set = new Set<CodexRedactionCategory>([
    ...secretPass.categories,
    ...preUrlCategories,
    ...textPass.categories
  ]);
  return { value: textPass.value, categories: sortCategories(set) };
}

export function redactCodexSession(
  parsed: CodexSessionParseResult
): RedactedCodexSession {
  const aggregate = new Set<CodexRedactionCategory>();

  const conversation = parsed.conversation.map((turn) => {
    const r = redactString(turn.text);
    r.categories.forEach((c) => aggregate.add(c));
    return { ...turn, text: r.value };
  });

  const signals = parsed.signals.map((sig) => {
    const r = redactString(sig.summary);
    r.categories.forEach((c) => aggregate.add(c));
    return { ...sig, summary: r.value, safetyNotes: r.categories };
  });

  const toolFacts = parsed.toolFacts.map((fact) => {
    if (fact.target === undefined) return { ...fact };
    const r = redactString(fact.target);
    r.categories.forEach((c) => aggregate.add(c));
    return { ...fact, target: r.value };
  });

  return {
    signals,
    conversation,
    toolFacts,
    appliedCategories: sortCategories(aggregate)
  };
}
