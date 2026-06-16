import type {
  NormalizedGitHub,
  OwnAuthoredBody
} from "./github-event-normalizer.js";
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

export type GitHubRedactionCategory = RedactionCategory | SecretCategory;

export type RedactedGitHubEvents = {
  signals: ActivitySignal[];
  ownAuthoredBodies: OwnAuthoredBody[];
  appliedCategories: GitHubRedactionCategory[];
};

const COMBINED_ORDER: GitHubRedactionCategory[] = [
  ...SECRET_CATEGORY_ORDER,
  ...REDACTION_CATEGORY_ORDER
];

// Mirror the codex adapter: catch SSH-style git URLs before the email
// regex eats them.
const SSH_GIT_URL = /\b[\w.-]{1,64}@[\w.-]{1,253}:[^\s]{1,4096}/g;

function sortCategories(
  set: Set<GitHubRedactionCategory>
): GitHubRedactionCategory[] {
  return COMBINED_ORDER.filter((c) => set.has(c));
}

function redactString(
  value: string,
  visibility: "public" | "private"
): { value: string; categories: GitHubRedactionCategory[] } {
  const secretPass = detectSecrets(value);
  let working = secretPass.value;

  const preUrlCategories = new Set<GitHubRedactionCategory>();
  if (SSH_GIT_URL.test(working)) {
    preUrlCategories.add("private URLs");
    SSH_GIT_URL.lastIndex = 0;
    working = working.replace(SSH_GIT_URL, "[redacted-url]");
  }

  const textPass = sanitizeText(working);
  let finalText = textPass.value;
  const all = new Set<GitHubRedactionCategory>([
    ...secretPass.categories,
    ...preUrlCategories,
    ...textPass.categories
  ]);

  if (visibility === "private") {
    const second = detectSecrets(finalText);
    finalText = second.value;
    second.categories.forEach((c) => all.add(c));
  }

  return { value: finalText, categories: sortCategories(all) };
}

export function redactGitHubEvents(
  input: NormalizedGitHub
): RedactedGitHubEvents {
  const aggregate = new Set<GitHubRedactionCategory>();

  const signals: ActivitySignal[] = input.signals.map((sig) => {
    const r = redactString(sig.summary, "public");
    r.categories.forEach((c) => aggregate.add(c));
    return { ...sig, summary: r.value, safetyNotes: r.categories };
  });

  const ownAuthoredBodies: OwnAuthoredBody[] = input.ownAuthoredBodies.map(
    (body) => {
      const r = redactString(body.text, body.visibility);
      r.categories.forEach((c) => aggregate.add(c));
      return { ...body, text: r.value };
    }
  );

  return {
    signals,
    ownAuthoredBodies,
    appliedCategories: sortCategories(aggregate)
  };
}
