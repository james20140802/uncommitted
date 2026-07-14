import { emailPattern } from "./redaction.js";
import {
  ARCHITECTURE_DISCLOSURE_REPLACEMENT,
  redactArchitectureDisclosure
} from "./architecture-disclosure.js";

export type SafetyStatus = "safe" | "warning" | "blocked";

export type SafetyRiskCategory =
  | "architecture-disclosure"
  | "database-credential"
  | "email"
  | "exploit-detail"
  | "local-path"
  | "phone-number"
  | "private-repo-remote"
  | "private-url"
  | "secret";

export type SafetyRiskSeverity = "warning" | "blocked";

export type SafetyRisk = {
  category: SafetyRiskCategory;
  severity: SafetyRiskSeverity;
  message: string;
};

export type SafetyRedaction = {
  category: SafetyRiskCategory;
  replacement: string;
  count: number;
};

export type SafetyReport = {
  schemaVersion: 1;
  status: SafetyStatus;
  risks: SafetyRisk[];
  redactionsApplied: SafetyRedaction[];
  exportAllowed: boolean;
  message: string;
};

export type SafetyCheckResult = {
  report: SafetyReport;
  redactedText: string;
};

type DetectionRule = {
  category: SafetyRiskCategory;
  severity: SafetyRiskSeverity;
  replacement: string;
  message: string;
  pattern: RegExp;
};

type DetectionResult = {
  value: string;
  count: number;
};

const exploitDetailRisk = {
  category: "exploit-detail",
  severity: "blocked",
  replacement: "[redacted-exploit-detail]",
  message: "Exploit detail was redacted."
} satisfies Omit<DetectionRule, "pattern">;

// Detection lives in architecture-disclosure.ts and runs as a supplemental
// pass (like redactScriptLikeContent) because it collects non-overlapping
// matches across several local patterns rather than a single regex.
// The replacement string itself is imported from architecture-disclosure.ts
// (ARCHITECTURE_DISCLOSURE_REPLACEMENT) so the two modules cannot diverge.

// UNC-207 / T3: severity is NOT a fixed "blocked". The core-vs-residual
// split is on the number of DISTINCT disclosure classes (admin-allowlist,
// route-guard, auth-checkpoint, server-side-authorization), NOT the raw
// occurrence count. This matters because the safety-report text concatenates
// the caption AND the diary slides, both generated from the same activity:
// a single genuinely-incidental fact (e.g. "fixed a route guard bug") is
// typically echoed in both a slide body and the caption, which would be two
// RAW matches but is still ONE disclosure class. Counting raw occurrences
// would wrongly block that (breaking parent AC1). Counting distinct classes
// keeps it a "warning" that still exports.
//
//   distinctClasses >= 2  -> "blocked": several different access-control
//     mechanisms co-occur, so the draft's core content IS the access-control
//     surface — the 2026-06-05 reproduction class (admin allowlist + route
//     guard + auth checkpoint + server-side authorization). Parent AC4.
//   distinctClasses == 1  -> "warning": a single incidental fact, sanitized
//     in place, even if echoed across multiple fields. Parent AC1.
//
// Deterministic, local (no AI call). It composes with the existing
// deriveStatus()/exportAllowed derivation below rather than adding a
// parallel gating path.
const ARCHITECTURE_DISCLOSURE_CORE_CLASS_THRESHOLD = 2;

const architectureDisclosureBlockedRisk = {
  category: "architecture-disclosure",
  severity: "blocked",
  replacement: ARCHITECTURE_DISCLOSURE_REPLACEMENT,
  message: "Security architecture detail was redacted."
} satisfies Omit<DetectionRule, "pattern">;

const architectureDisclosureWarningRisk = {
  category: "architecture-disclosure",
  severity: "warning",
  replacement: ARCHITECTURE_DISCLOSURE_REPLACEMENT,
  message:
    "Security architecture detail was redacted; residual mention should be reviewed before export."
} satisfies Omit<DetectionRule, "pattern">;

function resolveArchitectureDisclosureRisk(
  distinctClasses: number
): Omit<DetectionRule, "pattern"> {
  return distinctClasses >= ARCHITECTURE_DISCLOSURE_CORE_CLASS_THRESHOLD
    ? architectureDisclosureBlockedRisk
    : architectureDisclosureWarningRisk;
}

const detectionRules: DetectionRule[] = [
  {
    category: "database-credential",
    severity: "blocked",
    replacement: "[redacted-db-credential]",
    message: "Database credential was redacted.",
    pattern:
      /\b(?:DATABASE_URL|DB_URL|DATABASE_PASSWORD|DB_PASSWORD|PGPASSWORD|MYSQL_PWD)\s*=\s*\S+|\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi
  },
  {
    ...exploitDetailRisk,
    pattern:
      /(?:\b(?:sql injection|xss|ssrf|rce|remote code execution|exploit payload|payload)\b\s*[:-]?\s*)?(?:'\s*or\s*1\s*=\s*1\s*--|curl\s+\S+\s*\|\s*(?:sh|bash)|(?:rm\s+-rf\s+\/))/gi
  },
  {
    category: "secret",
    severity: "blocked",
    replacement: "[redacted-secret]",
    message: "Secret or token was redacted.",
    pattern:
      /\b(?:[A-Z][A-Z0-9]*[_-])*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)\s*=\s*\S+|\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|ghp|github_pat|glpat|xox[baprs])[-_A-Za-z0-9]{8,}/gi
  },
  {
    category: "private-repo-remote",
    severity: "warning",
    replacement: "[redacted-repo-url]",
    message: "Private repository remote was redacted.",
    pattern:
      /\bgit@[\w.-]+:[^\s]+|(?:git\+)?(?:https?|ssh|git):\/\/(?:[^/\s]+@)?(?:github\.com|gitlab\.com|bitbucket\.org|[\w.-]+)[:/][^\s]+\.git\b/gi
  },
  {
    category: "private-url",
    severity: "warning",
    replacement: "[redacted-url]",
    message: "Private URL was redacted.",
    pattern: /\b(?:https?|ssh|git):\/\/\S+/gi
  },
  {
    category: "email",
    severity: "warning",
    replacement: "[redacted-email]",
    message: "Email address was redacted.",
    // One shared instance is safe here: it is only ever consumed via
    // String.replace (applyRule), which resets lastIndex before and after
    // matching. Do NOT switch this to .test()/.exec(), which would carry
    // lastIndex across calls. Use emailPattern() for a fresh instance instead.
    pattern: emailPattern("gi")
  },
  {
    category: "phone-number",
    severity: "warning",
    replacement: "[redacted-phone]",
    message: "Phone number was redacted.",
    pattern:
      /(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}\b/g
  },
  {
    category: "local-path",
    severity: "warning",
    replacement: "[redacted-path]",
    message: "Local absolute path was redacted.",
    pattern:
      /(^(?:file:)?|[\s(["'=,:](?:file:)?)(?:\/[A-Za-z0-9._-]+(?:\/[^\s)"']+)+|[A-Za-z]:\\[^\s)"']+)/g
  }
];

export function createSafetyReport(text: string): SafetyReport {
  return checkDraftSafety(text).report;
}

export function checkDraftSafety(text: string): SafetyCheckResult {
  const risks = new Map<SafetyRiskCategory, SafetyRisk>();
  const redactions = new Map<SafetyRiskCategory, SafetyRedaction>();
  let redactedText = text;

  for (const rule of detectionRules) {
    const result = applyRule(redactedText, rule);

    if (result.count === 0) {
      continue;
    }

    redactedText = result.value;
    recordDetection(risks, redactions, rule, result.count);
  }

  const scriptResult = redactScriptLikeContent(redactedText);

  if (scriptResult.count > 0) {
    redactedText = scriptResult.value;
    recordDetection(risks, redactions, exploitDetailRisk, scriptResult.count);
  }

  const architectureResult = redactArchitectureDisclosure(redactedText);

  if (architectureResult.count > 0) {
    redactedText = architectureResult.value;
    recordDetection(
      risks,
      redactions,
      resolveArchitectureDisclosureRisk(architectureResult.distinctClasses),
      architectureResult.count
    );
  }

  const riskList = Array.from(risks.values());
  const status = deriveStatus(riskList);

  return {
    report: {
      schemaVersion: 1,
      status,
      risks: riskList,
      redactionsApplied: Array.from(redactions.values()),
      exportAllowed: status !== "blocked",
      message: buildSafetyMessage(status)
    },
    redactedText
  };
}

export function isSafetyReport(value: unknown): value is SafetyReport {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === 1 &&
    isSafetyStatus(value.status) &&
    Array.isArray(value.risks) &&
    value.risks.every(isSafetyRisk) &&
    Array.isArray(value.redactionsApplied) &&
    value.redactionsApplied.every(isSafetyRedaction) &&
    typeof value.exportAllowed === "boolean" &&
    typeof value.message === "string"
  );
}

function applyRule(
  value: string,
  rule: DetectionRule
): DetectionResult {
  let count = 0;

  const nextValue = value.replace(rule.pattern, (...args: unknown[]) => {
    count += 1;

    if (rule.category === "local-path") {
      return `${String(args[1])}${rule.replacement}`;
    }

    return rule.replacement;
  });

  return { value: nextValue, count };
}

function redactScriptLikeContent(value: string): DetectionResult {
  const lowerValue = value.toLowerCase();
  let count = 0;
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const openIndex = findScriptTagStart(lowerValue, cursor);

    if (openIndex === -1) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, openIndex);

    const closeStart = lowerValue.indexOf("</script", openIndex + "<script".length);

    if (closeStart === -1) {
      output += exploitDetailRisk.replacement;
      count += 1;
      break;
    }

    const closeEnd = value.indexOf(">", closeStart + "</script".length);

    if (closeEnd === -1) {
      output += exploitDetailRisk.replacement;
      count += 1;
      break;
    }

    output += exploitDetailRisk.replacement;
    count += 1;
    cursor = closeEnd + 1;
  }

  return count === 0 ? { value, count } : { value: output, count };
}

function findScriptTagStart(value: string, startIndex: number): number {
  let cursor = startIndex;

  while (cursor < value.length) {
    const openIndex = value.indexOf("<script", cursor);

    if (openIndex === -1) {
      return -1;
    }

    if (isHtmlTagNameBoundary(value[openIndex + "<script".length])) {
      return openIndex;
    }

    cursor = openIndex + "<script".length;
  }

  return -1;
}

function isHtmlTagNameBoundary(value: string | undefined): boolean {
  return value === undefined || !/[a-z0-9]/i.test(value);
}

function recordDetection(
  risks: Map<SafetyRiskCategory, SafetyRisk>,
  redactions: Map<SafetyRiskCategory, SafetyRedaction>,
  detection: Omit<DetectionRule, "pattern">,
  count: number
): void {
  risks.set(detection.category, {
    category: detection.category,
    severity: detection.severity,
    message: detection.message
  });

  const existingRedaction = redactions.get(detection.category);
  redactions.set(detection.category, {
    category: detection.category,
    replacement: detection.replacement,
    count: (existingRedaction?.count ?? 0) + count
  });
}

function deriveStatus(risks: SafetyRisk[]): SafetyStatus {
  if (risks.some((risk) => risk.severity === "blocked")) {
    return "blocked";
  }

  return risks.length > 0 ? "warning" : "safe";
}

function buildSafetyMessage(status: SafetyStatus): string {
  if (status === "blocked") {
    return "Remove blocked sensitive content.";
  }

  if (status === "warning") {
    return "Review redactions before export.";
  }

  return "Safety check passed.";
}

function isSafetyStatus(value: unknown): value is SafetyStatus {
  return value === "safe" || value === "warning" || value === "blocked";
}

function isSafetyRisk(value: unknown): value is SafetyRisk {
  return (
    isRecord(value) &&
    isSafetyRiskCategory(value.category) &&
    isSafetyRiskSeverity(value.severity) &&
    typeof value.message === "string"
  );
}

function isSafetyRedaction(value: unknown): value is SafetyRedaction {
  return (
    isRecord(value) &&
    isSafetyRiskCategory(value.category) &&
    typeof value.replacement === "string" &&
    typeof value.count === "number" &&
    Number.isInteger(value.count) &&
    value.count > 0
  );
}

function isSafetyRiskCategory(value: unknown): value is SafetyRiskCategory {
  return (
    value === "architecture-disclosure" ||
    value === "database-credential" ||
    value === "email" ||
    value === "exploit-detail" ||
    value === "local-path" ||
    value === "phone-number" ||
    value === "private-repo-remote" ||
    value === "private-url" ||
    value === "secret"
  );
}

function isSafetyRiskSeverity(value: unknown): value is SafetyRiskSeverity {
  return value === "warning" || value === "blocked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
