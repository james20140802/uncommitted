import { emailPattern } from "./redaction.js";
import {
  ARCHITECTURE_DISCLOSURE_REPLACEMENT,
  redactArchitectureDisclosure
} from "./architecture-disclosure.js";
import type { StoryCardPlan, StoryCardPlanCard } from "./story-card-plan.js";

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
  /** UNC-269: 카드 슬롯 단위 발견. 전부 severity "warning"이다. */
  storyCardSlots?: StoryCardSlotFinding[];
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

export type StoryCardSlotFinding = {
  schemaVersion: 1;
  cardIndex: number;
  cardType: string;
  slot: string;
  category: SafetyRiskCategory;
  /**
   * UNC-269 A4(i): 카드 슬롯 발견은 **warning 고정**이다. blocked로
   * 승격하지 않는다 — 승격하면 카드 한 장의 secret 모양 문자열 하나가
   * exit 6으로 그날 드래프트 전체를 죽인다(2026-07-26 사고와 같은 모양).
   */
  severity: "warning";
  message: string;
};

export type StoryCardPlanSafetyResult = {
  /** 슬롯 원문이 in-place 마스킹된 계획. */
  plan: StoryCardPlan;
  findings: StoryCardSlotFinding[];
};

/**
 * UNC-269 A4(ii): 마스킹과 warning 기록을 **함께** 한다.
 * 원문을 그대로 두고 경고만 남기면 export된 PNG에 비밀이 그대로 찍혀
 * "공개 산출물에 secret 금지"라는 하드 규칙을 위반한다. 반대로 blocked로
 * 올리면 그날이 죽는다. 둘을 동시에 만족시키는 조합은 이것뿐이다.
 */
export function checkStoryCardPlanSafety(
  plan: StoryCardPlan
): StoryCardPlanSafetyResult {
  const findings: StoryCardSlotFinding[] = [];

  const cards: StoryCardPlanCard[] = plan.cards.map((card, cardIndex) => {
    const slots: Record<string, string | string[]> = {};

    for (const [slotName, value] of Object.entries(card.slots)) {
      if (typeof value === "string") {
        const checked = checkDraftSafety(value);

        collectSlotFindings(findings, cardIndex, card.type, slotName, checked.report.risks);
        slots[slotName] = checked.redactedText;
        continue;
      }

      slots[slotName] = value.map((line) => {
        const checked = checkDraftSafety(line);

        collectSlotFindings(findings, cardIndex, card.type, slotName, checked.report.risks);

        return checked.redactedText;
      });
    }

    return { ...card, slots };
  });

  return { plan: { ...plan, cards }, findings };
}

function collectSlotFindings(
  findings: StoryCardSlotFinding[],
  cardIndex: number,
  cardType: string,
  slot: string,
  risks: readonly SafetyRisk[]
): void {
  for (const risk of risks) {
    const alreadyRecorded = findings.some(
      (finding) =>
        finding.cardIndex === cardIndex &&
        finding.slot === slot &&
        finding.category === risk.category
    );

    if (alreadyRecorded) continue;

    findings.push({
      schemaVersion: 1,
      cardIndex,
      cardType,
      slot,
      category: risk.category,
      severity: "warning",
      message: risk.message
    });
  }
}

/**
 * UNC-269 A4(iii): 발견은 슬롯 단위로 남기고, 드래프트 종합 등급은
 * **최대 warning까지만** 올린다. 이미 blocked인 보고서는 그대로 둔다 —
 * 그 blocked는 카드가 아니라 슬라이드·캡션에서 온 것이고, 카드 발견이
 * 그 판정을 뒤집어서는 안 된다.
 */
export function mergeStoryCardSlotFindings(
  report: SafetyReport,
  findings: readonly StoryCardSlotFinding[]
): SafetyReport {
  if (findings.length === 0) {
    return report;
  }

  const status: SafetyStatus = report.status === "blocked" ? "blocked" : "warning";

  return {
    ...report,
    status,
    // exportAllowed는 원래 보고서의 판정을 그대로 잇는다. 카드 슬롯 발견은
    // export를 절대 막지 않는다.
    exportAllowed: report.exportAllowed,
    message: buildSafetyMessage(status),
    storyCardSlots: [...findings]
  };
}

export type StoryCardPlanRescanResult = {
  /** 재검증 뒤 다시 마스킹까지 끝낸, 실제로 내보낼 계획. */
  plan: StoryCardPlan;
  findings: StoryCardSlotFinding[];
};

/**
 * UNC-269 T5 리뷰 반영 (Critical 1): `revalidateStoryCardPlan`의 degrade
 * 경로(`degradeToDefaults` → `buildDefaultSlots`)는 그날의 활동 요약에서
 * **마스킹을 거치지 않은** 원문을 새로 끌어온다 — 터미널 카드의
 * command/output이 커밋 subject·smallWins 원문 그대로인 것이 그 예다.
 * 그 원문이 secret 모양이면 재검증을 거친 계획에 마스킹되지 않은 채로
 * 남아 story.json / 렌더 산출물로 나간다. 그래서 재검증 뒤 계획은
 * **한 번 더** checkStoryCardPlanSafety를 통과해야 한다 — 이 두 번째
 * 통과는 그 자체로 다시 캐스케이드되지 않는다: buildDefaultSlots의
 * 결과는 이미 fitSlotText/fitSlotLines로 슬롯 길이에 맞춰져 있고,
 * degradeToDefaults가 그 결과를 다시 검증기로 재검사한 뒤에만 채택하기
 * 때문이다.
 *
 * UNC-269 T5 리뷰 반영 (Important 3): 재검증이 카드를 통째로 바꾸거나
 * (degrade) 떨어뜨리면(drop) 1차 마스킹 때 기록한 발견의 cardIndex가
 * 최종 계획과 어긋난다. 그래서 1차 발견을 무조건 이어 붙이지 않는다 —
 * 재검증 전/후 계획을 카드 내용(type + slots)으로 매칭해, **내용이 그대로
 * 살아남은 카드의 발견만** 그 카드의 최종 위치로 인덱스를 다시 맞춰
 * 이어 붙인다. 내용이 바뀐(=degrade된) 카드의 1차 발견은 버리고, 대신
 * 이 함수의 2차 스캔이 그 카드의 최종 내용에서 새로 찾아낸 발견으로
 * 대체한다 — 그 카드가 더 이상 1차 발견이 가리키던 내용을 담고 있지
 * 않기 때문이다.
 */
export function rescanStoryCardPlanAfterRevalidation(options: {
  maskedPlan: StoryCardPlan;
  preRevalidationFindings: readonly StoryCardSlotFinding[];
  revalidatedPlan: StoryCardPlan;
}): StoryCardPlanRescanResult {
  const { plan, findings: freshFindings } = checkStoryCardPlanSafety(
    options.revalidatedPlan
  );

  const indexMap = mapSurvivingCardIndices(options.maskedPlan, plan);

  const carriedForward = options.preRevalidationFindings.flatMap((finding) => {
    const finalIndex = indexMap.get(finding.cardIndex);

    if (finalIndex === undefined) return [];

    return [{ ...finding, cardIndex: finalIndex }];
  });

  return { plan, findings: [...carriedForward, ...freshFindings] };
}

/**
 * 재검증 전 계획의 각 카드가 재검증 뒤 계획의 어느 인덱스로 살아남았는지
 * (type + slots가 완전히 그대로인 경우에만) 매핑한다. 위치가 아니라
 * **내용**으로 매칭하므로 앞쪽 카드가 drop되어 뒤쪽 카드들이 통째로
 * 한 칸씩 당겨지는 경우에도 올바른 최종 인덱스를 찾는다. 이미 매칭된
 * 최종 카드는 다시 매칭되지 않도록 소비한다 — 내용이 우연히 같은 카드가
 * 여럿이어도 1:1로만 대응시키기 위해서다.
 */
function mapSurvivingCardIndices(
  before: StoryCardPlan,
  after: StoryCardPlan
): Map<number, number> {
  const availableAfterIndices = after.cards.map((_, index) => index);
  const indexMap = new Map<number, number>();

  for (const [beforeIndex, beforeCard] of before.cards.entries()) {
    const matchPosition = availableAfterIndices.findIndex((afterIndex) =>
      isSameCardContent(beforeCard, after.cards[afterIndex])
    );

    if (matchPosition === -1) continue;

    indexMap.set(beforeIndex, availableAfterIndices[matchPosition]);
    availableAfterIndices.splice(matchPosition, 1);
  }

  return indexMap;
}

function isSameCardContent(
  a: StoryCardPlanCard,
  b: StoryCardPlanCard
): boolean {
  return a.type === b.type && JSON.stringify(a.slots) === JSON.stringify(b.slots);
}
