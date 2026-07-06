/**
 * Canonical text redaction shared by every activity source.
 *
 * One sanitizer, one category vocabulary, one ordering — so the git
 * EventSource (git-activity-collector.ts) and the summary synthesis
 * (activity-summary.ts) can never drift on what counts as sensitive or on
 * how a sanitized signal reports its safetyNotes. Before this module the two
 * producers each kept their own regex block and category list, which let a
 * commit signal leak raw code that the summary path would have masked.
 */

export type RedactionCategory =
  | "emails"
  | "local absolute paths"
  | "private URLs"
  | "raw code snippets";

/**
 * Stable display/compare order for redaction categories. Both producers sort
 * safetyNotes through this list so equal inputs yield byte-equal arrays.
 */
export const REDACTION_CATEGORY_ORDER: RedactionCategory[] = [
  "emails",
  "local absolute paths",
  "private URLs",
  "raw code snippets"
];

export type RedactionResult = {
  value: string;
  categories: RedactionCategory[];
};

// Single source of the email-matching pattern for every redaction path.
// The local part is terminated by the literal '@' and each domain label by a
// literal '.', so no quantified class overlaps the naive `[A-Z0-9.-]+\.[A-Z]`
// form that CodeQL flags as js/polynomial-redos. The leading negative
// look-behind anchors the match at the true start of the local-part run: this
// keeps the unbounded `+` linear (interior positions are rejected in O(1)
// instead of re-scanning the run) and — unlike the previous {1,64}/{1,255}
// bounds — guarantees the WHOLE address is consumed, so an over-length local
// part or domain can never leave a leading fragment (e.g. "a[redacted-email]")
// exposed. Returns a FRESH RegExp each call so callers never share lastIndex
// across .test()/.replace().
const EMAIL_PATTERN_SOURCE =
  "(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\\.)+[A-Z]{2,24}";

export function emailPattern(flags = "gi"): RegExp {
  return new RegExp(EMAIL_PATTERN_SOURCE, flags);
}

/**
 * Full 4-rule sanitizer for raw text (commit subjects before collector
 * redaction, dirty-file paths, manual notes). Applies, in order, email →
 * absolute-path → private-URL → raw-code redaction and reports every
 * category that fired.
 */
export function sanitizeText(value: string): RedactionResult {
  const categories = new Set<RedactionCategory>();
  let sanitized = value;

  // emailPattern anchors the match at the token start and consumes the whole
  // address (see redaction.ts), so matching stays linear/ReDoS-safe and an
  // over-length local part or domain leaves no leading fragment behind.
  if (emailPattern("i").test(sanitized)) {
    categories.add("emails");
    sanitized = sanitized.replace(emailPattern("gi"), "[redacted-email]");
  }

  if (/(^|[\s(["'])\/[^\s)"']+/.test(sanitized)) {
    categories.add("local absolute paths");
    sanitized = sanitized.replace(
      /(^|[\s(["'])\/[^\s)"']+/g,
      "$1[redacted-path]"
    );
  }

  if (/\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/.test(sanitized)) {
    categories.add("private URLs");
    sanitized = sanitized.replace(
      /\b(?:https?|ssh|git):\/\/\S+|git@[\w.-]+:[^\s]+/g,
      "[redacted-url]"
    );
  }

  if (containsRawCodeSnippet(sanitized)) {
    categories.add("raw code snippets");
    sanitized = redactRawCodeSnippets(sanitized);
  }

  return { value: sanitized, categories: sortCategories(categories) };
}

/**
 * Categorize a subject that the collector already redacted with the 3-rule
 * pass (emails / absolute paths / private URLs), then redact any raw code the
 * collector left intact. Email/path/URL categories are recovered from the
 * redaction markers; raw code is detected fresh on the remaining text.
 *
 * This is how commit signals are built in both producers: collectGitActivity
 * masks emails/paths/URLs first, so re-running the email/path/URL rules here
 * would no longer match the markers — but raw code never got a rule in that
 * pass and must still be removed before the signal ships.
 */
export function categorizeRedactedSubject(redactedSubject: string): RedactionResult {
  const categories = new Set<RedactionCategory>();

  if (redactedSubject.includes("[redacted-email]")) {
    categories.add("emails");
  }
  if (redactedSubject.includes("[redacted-path]")) {
    categories.add("local absolute paths");
  }
  if (redactedSubject.includes("[redacted-url]")) {
    categories.add("private URLs");
  }

  let value = redactedSubject;
  if (containsRawCodeSnippet(value)) {
    categories.add("raw code snippets");
    value = redactRawCodeSnippets(value);
  }

  return { value, categories: sortCategories(categories) };
}

export function sortCategories(
  categories: Set<RedactionCategory>
): RedactionCategory[] {
  return REDACTION_CATEGORY_ORDER.filter((category) => categories.has(category));
}

function containsRawCodeSnippet(value: string): boolean {
  return redactRawCodeSnippets(value) !== value;
}

function redactRawCodeSnippets(value: string): string {
  return value
    .replace(/\bdiff --git\b[^\n]*/g, "[redacted-code]")
    .replace(/`[^`]+`/g, "[redacted-code]")
    .replace(
      /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:process\.env\.[A-Z0-9_]+|["'][^"']*["']|[A-Za-z0-9_$.[\]]+)/g,
      "[redacted-code]"
    )
    .replace(/\bprocess\.env\.[A-Z0-9_]+\b/g, "[redacted-code]");
}
