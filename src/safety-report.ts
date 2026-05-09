export type SafetyStatus = "safe" | "warning" | "blocked";

export type SafetyRiskCategory =
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
    category: "exploit-detail",
    severity: "blocked",
    replacement: "[redacted-exploit-detail]",
    message: "Exploit detail was redacted.",
    pattern:
      /(?:\b(?:sql injection|xss|ssrf|rce|remote code execution|exploit payload|payload)\b\s*[:-]?\s*)?(?:'\s*or\s*1\s*=\s*1\s*--|<script\b[^>]*>[\s\S]*?<\/script>|curl\s+\S+\s*\|\s*(?:sh|bash)|(?:rm\s+-rf\s+\/))/gi
  },
  {
    category: "secret",
    severity: "blocked",
    replacement: "[redacted-secret]",
    message: "Secret or token was redacted.",
    pattern:
      /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)\s*=\s*\S+|\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|ghp|github_pat|glpat|xox[baprs])[-_A-Za-z0-9]{8,}/gi
  },
  {
    category: "private-repo-remote",
    severity: "warning",
    replacement: "[redacted-repo-url]",
    message: "Private repository remote was redacted.",
    pattern:
      /\bgit@[\w.-]+:[^\s]+|(?:https?|ssh|git):\/\/(?:[^/\s]+@)?(?:github\.com|gitlab\.com|bitbucket\.org|[\w.-]+)[:/][^\s]+\.git\b/gi
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
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
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
      /(^|[\s(["'])(?:\/(?:Users|home|private|var|tmp|Volumes|opt|etc)\/[^\s)"']+|[A-Za-z]:\\[^\s)"']+)/g
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
    risks.set(rule.category, {
      category: rule.category,
      severity: rule.severity,
      message: rule.message
    });
    redactions.set(rule.category, {
      category: rule.category,
      replacement: rule.replacement,
      count: result.count
    });
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
): { value: string; count: number } {
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
