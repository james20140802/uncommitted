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

// The four disclosure classes. Each match carries the class it belongs to so
// downstream severity logic (safety-report.ts) can dedupe by distinct
// disclosure FACT rather than by raw occurrence count: the same fact echoed
// across a slide body and the caption is one class, not two.
export type ArchitectureDisclosureClass =
  | "admin-allowlist"
  | "route-guard"
  | "auth-checkpoint"
  | "server-side-authorization";

export type ArchitectureDisclosureMatch = {
  value: string;
  index: number;
  length: number;
  reason: "architecture-disclosure";
  disclosureClass: ArchitectureDisclosureClass;
};

export type ArchitectureDisclosureRedaction = {
  value: string;
  count: number;
  // Number of DISTINCT disclosure classes present across all matches. Used by
  // the core-vs-residual severity heuristic; count of raw occurrences alone
  // over-blocks when one fact is repeated across draft + caption.
  distinctClasses: number;
};

export const ARCHITECTURE_DISCLOSURE_REPLACEMENT = "[redacted-architecture]";
export const ARCHITECTURE_DISCLOSURE_REASON = "architecture-disclosure" as const;

// Four disclosure classes, each requiring explicit access-control-mechanism
// context (not just an adjacent generic word). Sources are compiled into
// fresh RegExp instances per call (see architectureDisclosurePatterns()).
const ARCHITECTURE_DISCLOSURE_PATTERN_SOURCES: Array<{
  disclosureClass: ArchitectureDisclosureClass;
  source: string;
}> = [
  // admin allowlist (e.g. "admin allowlist", "allowlisted admins", isAdmin
  // gate lists)
  { disclosureClass: "admin-allowlist", source: "\\badmin\\s+allowlist\\b" },
  { disclosureClass: "admin-allowlist", source: "\\ballowlisted\\s+admins?\\b" },
  { disclosureClass: "admin-allowlist", source: "\\bisAdmin\\s+gate\\s+lists?\\b" },
  // route-guard behavior (route guard, routeGuard, beforeEnter auth
  // redirect, canActivate)
  { disclosureClass: "route-guard", source: "\\broute[\\s-]?guard\\b" },
  { disclosureClass: "route-guard", source: "\\bbeforeEnter\\s+auth\\s+redirect\\b" },
  { disclosureClass: "route-guard", source: "\\bcanActivate\\b" },
  // auth checkpoint (auth checkpoint, authentication middleware,
  // requireAuth, ensureAuthenticated)
  { disclosureClass: "auth-checkpoint", source: "\\bauth\\s+checkpoint\\b" },
  { disclosureClass: "auth-checkpoint", source: "\\bauthentication\\s+middleware\\b" },
  { disclosureClass: "auth-checkpoint", source: "\\brequireAuth\\b" },
  { disclosureClass: "auth-checkpoint", source: "\\bensureAuthenticated\\b" },
  // server-side authorization logic (server-side authorization,
  // authorization check, RBAC rule, permission check describing
  // where/how access is enforced)
  { disclosureClass: "server-side-authorization", source: "\\bserver-side\\s+authorization\\b" },
  { disclosureClass: "server-side-authorization", source: "\\bauthorization\\s+check\\b" },
  { disclosureClass: "server-side-authorization", source: "\\bRBAC\\s+rules?\\b" },
  { disclosureClass: "server-side-authorization", source: "\\bpermission\\s+checks?\\b" }
];

function architectureDisclosurePatterns(): Array<{
  disclosureClass: ArchitectureDisclosureClass;
  pattern: RegExp;
}> {
  return ARCHITECTURE_DISCLOSURE_PATTERN_SOURCES.map((entry) => ({
    disclosureClass: entry.disclosureClass,
    pattern: new RegExp(entry.source, "gi")
  }));
}

export function detectArchitectureDisclosure(
  text: string
): ArchitectureDisclosureMatch[] {
  if (text.length === 0) {
    return [];
  }

  const matches: ArchitectureDisclosureMatch[] = [];
  const claimedRanges: Array<{ start: number; end: number }> = [];

  for (const { disclosureClass, pattern } of architectureDisclosurePatterns()) {
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
          reason: ARCHITECTURE_DISCLOSURE_REASON,
          disclosureClass
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
    return { value: text, count: 0, distinctClasses: 0 };
  }

  let value = "";
  let cursor = 0;

  for (const match of matches) {
    value += text.slice(cursor, match.index);
    value += ARCHITECTURE_DISCLOSURE_REPLACEMENT;
    cursor = match.index + match.length;
  }

  value += text.slice(cursor);

  const distinctClasses = new Set(
    matches.map((match) => match.disclosureClass)
  ).size;

  return { value, count: matches.length, distinctClasses };
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
