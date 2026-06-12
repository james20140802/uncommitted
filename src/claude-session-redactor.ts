import type {
  ClaudeSessionParseResult,
  ConversationTurn,
  ToolFact
} from "./claude-session-parser.js";
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

export type ClaudeRedactionCategory = RedactionCategory | SecretCategory;

export type RedactedClaudeSession = {
  signals: ActivitySignal[];
  conversation: ConversationTurn[];
  toolFacts: ToolFact[];
  appliedCategories: ClaudeRedactionCategory[];
};

const COMBINED_ORDER: ClaudeRedactionCategory[] = [
  ...SECRET_CATEGORY_ORDER,
  ...REDACTION_CATEGORY_ORDER
];

function sortCategories(
  set: Set<ClaudeRedactionCategory>
): ClaudeRedactionCategory[] {
  return COMBINED_ORDER.filter((c) => set.has(c));
}

// SSH-style git URLs (git@host:path) collide with the email regex in
// sanitizeText — "git@github.com" satisfies the email local-part/domain
// shape and gets eaten as [redacted-email] before the URL rule runs.
// Catch and mask them up front so they're correctly attributed to
// "private URLs" instead of "emails".
const SSH_GIT_URL = /\b[\w.-]{1,64}@[\w.-]{1,253}:[^\s]{1,4096}/g;

function redactString(value: string): {
  value: string;
  categories: ClaudeRedactionCategory[];
} {
  const secretPass = detectSecrets(value);

  let preUrl = secretPass.value;
  const preUrlCategories = new Set<ClaudeRedactionCategory>();
  if (SSH_GIT_URL.test(preUrl)) {
    preUrlCategories.add("private URLs");
    SSH_GIT_URL.lastIndex = 0;
    preUrl = preUrl.replace(SSH_GIT_URL, "[redacted-url]");
  }

  const textPass = sanitizeText(preUrl);
  const set = new Set<ClaudeRedactionCategory>([
    ...secretPass.categories,
    ...preUrlCategories,
    ...textPass.categories
  ]);
  return { value: textPass.value, categories: sortCategories(set) };
}

export function redactClaudeSession(
  parsed: ClaudeSessionParseResult
): RedactedClaudeSession {
  const aggregate = new Set<ClaudeRedactionCategory>();

  const conversation = parsed.conversation.map((turn) => {
    const r = redactString(turn.text);
    r.categories.forEach((c) => aggregate.add(c));
    return { ...turn, text: r.value };
  });

  const signals = parsed.signals.map((sig) => {
    const r = redactString(sig.summary);
    r.categories.forEach((c) => aggregate.add(c));
    return {
      ...sig,
      summary: r.value,
      safetyNotes: r.categories
    };
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
