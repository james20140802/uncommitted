/**
 * Local, pattern-based detector for security-architecture disclosure.
 *
 * Publishable drafts (caption/slides/image prompts) must never reveal *how*
 * access control is implemented — admin allowlists, route guards, auth
 * checkpoints, or server-side authorization logic. Roasting "fixed an admin
 * bug" is fine; describing the allowlist/guard/checkpoint mechanism itself is
 * not, because it hands a reader a map of the access-control surface.
 *
 * Detection is local regex/keyword matching only — no AI provider call, ever
 * (see project safety rules). Each pattern requires access-control-mechanism
 * context, not just a bare word like "admin", so benign copy such as "admin
 * dashboard styling" does not fire.
 *
 * Follows the ReDoS-safe style from redaction.ts: patterns are anchored with
 * bounded/alternation-based quantifiers (no nested unbounded `+`/`*` over the
 * same character class), and every call constructs a FRESH RegExp so
 * `lastIndex` is never shared across invocations.
 */

export type ArchitectureDisclosureMatch = {
  value: string;
  index: number;
  length: number;
  reason: "architecture-disclosure";
};

export type ArchitectureDisclosureRedaction = {
  value: string;
  count: number;
};

export const ARCHITECTURE_DISCLOSURE_REPLACEMENT = "[redacted-architecture]";
export const ARCHITECTURE_DISCLOSURE_REASON = "architecture-disclosure" as const;

// Four disclosure classes, each requiring explicit access-control-mechanism
// context (not just an adjacent generic word). Sources are compiled into
// fresh RegExp instances per call (see architectureDisclosurePatterns()).
const ARCHITECTURE_DISCLOSURE_PATTERN_SOURCES: string[] = [
  // admin allowlist (e.g. "admin allowlist", "allowlisted admins", isAdmin
  // gate lists)
  "\\badmin\\s+allowlist\\b",
  "\\ballowlisted\\s+admins?\\b",
  "\\bisAdmin\\s+gate\\s+lists?\\b",
  // route-guard behavior (route guard, routeGuard, beforeEnter auth
  // redirect, canActivate)
  "\\broute[\\s-]?guard\\b",
  "\\bbeforeEnter\\s+auth\\s+redirect\\b",
  "\\bcanActivate\\b",
  // auth checkpoint (auth checkpoint, authentication middleware,
  // requireAuth, ensureAuthenticated)
  "\\bauth\\s+checkpoint\\b",
  "\\bauthentication\\s+middleware\\b",
  "\\brequireAuth\\b",
  "\\bensureAuthenticated\\b",
  // server-side authorization logic (server-side authorization,
  // authorization check, RBAC rule, permission check describing
  // where/how access is enforced)
  "\\bserver-side\\s+authorization\\b",
  "\\bauthorization\\s+check\\b",
  "\\bRBAC\\s+rules?\\b",
  "\\bpermission\\s+checks?\\b"
];

function architectureDisclosurePatterns(): RegExp[] {
  return ARCHITECTURE_DISCLOSURE_PATTERN_SOURCES.map(
    (source) => new RegExp(source, "gi")
  );
}

export function detectArchitectureDisclosure(
  text: string
): ArchitectureDisclosureMatch[] {
  if (text.length === 0) {
    return [];
  }

  const matches: ArchitectureDisclosureMatch[] = [];
  const claimedRanges: Array<{ start: number; end: number }> = [];

  for (const pattern of architectureDisclosurePatterns()) {
    let execResult: RegExpExecArray | null;

    while ((execResult = pattern.exec(text)) !== null) {
      const start = execResult.index;
      const end = start + execResult[0].length;

      // Guard against a zero-length match looping forever.
      if (execResult[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }

      if (!overlapsClaimedRange(claimedRanges, start, end)) {
        claimedRanges.push({ start, end });
        matches.push({
          value: execResult[0],
          index: start,
          length: execResult[0].length,
          reason: ARCHITECTURE_DISCLOSURE_REASON
        });
      }
    }
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

export function redactArchitectureDisclosure(
  text: string
): ArchitectureDisclosureRedaction {
  const matches = detectArchitectureDisclosure(text);

  if (matches.length === 0) {
    return { value: text, count: 0 };
  }

  let value = "";
  let cursor = 0;

  for (const match of matches) {
    value += text.slice(cursor, match.index);
    value += ARCHITECTURE_DISCLOSURE_REPLACEMENT;
    cursor = match.index + match.length;
  }

  value += text.slice(cursor);

  return { value, count: matches.length };
}

function overlapsClaimedRange(
  claimedRanges: Array<{ start: number; end: number }>,
  start: number,
  end: number
): boolean {
  return claimedRanges.some(
    (range) => start < range.end && end > range.start
  );
}
