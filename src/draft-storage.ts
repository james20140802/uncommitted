import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AiGenerationErrorCode } from "./ai-provider.js";
import { redactArchitectureDisclosure } from "./architecture-disclosure.js";
import { detectSecrets } from "./credential-detector.js";
import { sanitizeText } from "./redaction.js";

export type DraftStorageErrorCode =
  | "inspect-failed"
  | "invalid-json"
  | "invalid-pointer"
  | "write-failed";

export class DraftStorageError extends Error {
  constructor(
    message: string,
    public readonly code: DraftStorageErrorCode
  ) {
    super(message);
    this.name = "DraftStorageError";
  }
}

export type DraftRevision = {
  targetDate: string;
  revision: string;
  dateDir: string;
  outputDir: string;
  latestPointerPath: string;
  dateLatestPointerPath: string;
};

export type LatestDraftPointer = {
  schemaVersion: 1;
  targetDate: string;
  revision: string;
  path: string;
  updatedAt: string;
};

export type TextDraftRevisionInput = {
  draftRoot: string;
  targetDate: string;
  generatedAt: string;
  activitySummary: unknown;
  story: unknown;
  caption: string;
  metadata: unknown;
};

export type TextDraftWriteResult = DraftRevision & {
  files: string[];
};

const textDraftFiles = [
  "activity-summary.json",
  "story.json",
  "caption.txt",
  "metadata.json"
];

export async function writeTextDraftRevision(
  input: TextDraftRevisionInput
): Promise<TextDraftWriteResult> {
  const revision = await createDraftRevision({
    draftRoot: input.draftRoot,
    targetDate: input.targetDate
  });

  await writeDraftArtifactJson(
    revision,
    "activity-summary.json",
    input.activitySummary
  );
  await writeDraftArtifactJson(revision, "story.json", input.story);
  await writeDraftArtifactText(revision, "caption.txt", input.caption);
  await writeDraftArtifactJson(revision, "metadata.json", input.metadata);
  await writeLatestDraftPointer(revision, input.generatedAt);

  return {
    ...revision,
    files: [...textDraftFiles]
  };
}

export async function createDraftRevision(options: {
  draftRoot: string;
  targetDate: string;
}): Promise<DraftRevision> {
  const dateDir = join(options.draftRoot, options.targetDate);
  const revision = await allocateNextRevision(dateDir);
  const outputDir = join(dateDir, revision);

  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }

  return {
    targetDate: options.targetDate,
    revision,
    dateDir,
    outputDir,
    latestPointerPath: join(options.draftRoot, "latest.json"),
    dateLatestPointerPath: join(dateDir, "latest.json")
  };
}

export async function writeDraftArtifactJson(
  revision: DraftRevision,
  filename: string,
  value: unknown
): Promise<void> {
  let serialized: string;

  try {
    const nextSerialized = JSON.stringify(value, null, 2);

    if (nextSerialized === undefined) {
      throw new Error("JSON artifact is not serializable.");
    }

    JSON.parse(nextSerialized);
    serialized = nextSerialized;
  } catch {
    throw new DraftStorageError(
      "Draft artifact JSON is invalid.",
      "invalid-json"
    );
  }

  await writeDraftArtifactText(revision, filename, `${serialized}\n`);
}

export async function writeDraftArtifactText(
  revision: DraftRevision,
  filename: string,
  value: string
): Promise<void> {
  try {
    await writeFile(join(revision.outputDir, filename), value, "utf8");
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }
}

export async function writeDraftArtifactBinary(
  revision: DraftRevision,
  filename: string,
  value: Uint8Array
): Promise<void> {
  const path = join(revision.outputDir, filename);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }
}

/**
 * UNC-253 / T2: 캡션 단계에서 실패해 산출물이 반쪽만 남은 리비전을
 * 완성본과 구별되게 표시한다. 별도 마커 파일 대신 metadata.json 필드로
 * 남기는 이유는 소비자(render/export)가 이미 metadata.json을 게이팅
 * 지점으로 쓰고 있고, 드래프트 파일 목록을 늘리지 않기 때문이다.
 * latest.json 포인터는 의도적으로 건드리지 않는다 — 깨진 드래프트를
 * 가리키면 안 된다.
 */
export type IncompleteDraftStage = "caption";

export type IncompleteDraftMarkerInput = {
  stage: IncompleteDraftStage;
  reason: string;
  failedAt: string;
  targetDate: string;
};

/**
 * UNC-257 / T6: `reason` carries the raw provider/Error message straight
 * through from `generate-command.ts`'s catch block, and metadata.json is
 * written to disk unconditionally (including for exports gated later), so
 * it must go through the same redaction pipeline as the diagnostics file
 * rather than being persisted verbatim.
 */
export async function writeIncompleteDraftMarker(
  revision: DraftRevision,
  input: IncompleteDraftMarkerInput
): Promise<void> {
  await writeDraftArtifactJson(revision, "metadata.json", {
    schemaVersion: 1,
    targetDate: input.targetDate,
    date: input.targetDate,
    revision: revision.revision,
    status: "incomplete",
    exported: false,
    published: false,
    incomplete: {
      stage: input.stage,
      reason: redactDiagnosticText(input.reason),
      failedAt: input.failedAt
    }
  });
}

/**
 * UNC-257 / T6: 재시도(UNC-254)가 소진된 캡션 실패의 원인을 사후에
 * 확인할 수 있게 리비전 디렉토리에 남긴다. 2026-07-26 실패 때는 원본
 * 응답이 남지 않아 네 조건 중 무엇이 걸렸는지 끝내 확정할 수 없었다.
 * 타임스탬프를 반드시 포함한다 — schedule.stderr.log에 타임스탬프가
 * 없어 실행 귀속을 파일 mtime으로 역산해야 했다.
 *
 * Redaction reuses the project's existing utilities rather than a new
 * pattern-matching path: `sanitizeText` (emails / local absolute paths /
 * private URLs / raw code snippets), `redactArchitectureDisclosure`
 * (admin-allowlist / route-guard / auth-checkpoint / server-side-
 * authorization phrasing), and `detectSecrets` (vendor API tokens,
 * high-entropy tokens, and key:value/key=value assignment secrets) —
 * `sanitizeText` and `redactArchitectureDisclosure` alone do not cover the
 * secrets/tokens category, so `detectSecrets` from credential-detector.ts
 * (already used elsewhere in the project for exactly this purpose) is
 * composed in as well, followed by a local prefix-anchored token pass (see
 * `redactDiagnosticText` below) that closes a gap `detectSecrets` leaves
 * open for undelimited tokens in prose.
 */
export type CaptionFailureDiagnosticsInput = {
  failedAt: string;
  reason: string;
  violations: string[];
  attempts: number;
  rawResponseJson?: string;
};

export async function writeCaptionFailureDiagnostics(
  revision: DraftRevision,
  input: CaptionFailureDiagnosticsInput
): Promise<void> {
  await writeDraftArtifactJson(revision, "caption-failure.json", {
    schemaVersion: 1,
    stage: "caption",
    failedAt: input.failedAt,
    targetDate: revision.targetDate,
    revision: revision.revision,
    attempts: input.attempts,
    violations: input.violations,
    reason: redactDiagnosticText(input.reason),
    rawResponse:
      input.rawResponseJson === undefined
        ? null
        : redactDiagnosticText(input.rawResponseJson)
  });
}

/**
 * UNC-264 / T6: 카드 검증 실패의 사후 추적용 산출물.
 *
 * 캡션 진단(caption-failure.json)과 파일명 관례를 맞추되 **경로는 다르다**:
 * - `textDraftFiles`(필수 아티팩트 목록)에 넣지 않는다. 넣으면 "degrade해도
 *   드래프트는 완성된다"는 부모 AC4/AC5와 정면 충돌한다.
 * - `writeIncompleteDraftMarker`를 부르지 않는다. 카드 실패는 결코 리비전을
 *   미완성으로 만들지 않는다 — 그게 캡션 실패와 카드 실패의 성질 차이다.
 * - metadata.json은 건드리지 않는다. degrade 발생 신호는 이 파일의 존재
 *   여부로만 표현한다.
 *
 * 원본 응답은 기존 redactDiagnosticText를 그대로 통과시킨다 — 로그도 남는
 * 데이터이고, 새 redaction 규칙을 여기서 도입하지 않는다.
 *
 * providerFailure(T3에서 추가)는 재시도가 소진돼서가 아니라 프로바이더
 * 호출 자체가 죽어 루프가 끝난 경우를 구분해서 남긴다 — 카드가 슬롯 제약을
 * 계속 어겨서 degrade된 실행과 재시도 호출이 죽어서 degrade된 실행은
 * 사후 원인이 다르므로(부모 AC6), 선택 필드로 그대로 보존한다.
 */
export type StoryCardFailureCardRecord = {
  cardIndex: number;
  cardType: string | null;
  outcome: "degraded" | "dropped";
  violations: string[];
};

export type StoryCardFailureProviderFailure = {
  message: string;
  code: AiGenerationErrorCode;
};

export type StoryCardFailureDiagnosticsInput = {
  failedAt: string;
  attempts: number;
  cards: StoryCardFailureCardRecord[];
  rawResponseJson?: string;
  providerFailure?: StoryCardFailureProviderFailure;
};

export async function writeStoryCardFailureDiagnostics(
  revision: DraftRevision,
  input: StoryCardFailureDiagnosticsInput
): Promise<void> {
  await writeDraftArtifactJson(revision, "story-card-failure.json", {
    schemaVersion: 1,
    stage: "story-card",
    failedAt: input.failedAt,
    targetDate: revision.targetDate,
    revision: revision.revision,
    attempts: input.attempts,
    cards: input.cards.map((card) => ({
      cardIndex: card.cardIndex,
      cardType: card.cardType,
      outcome: card.outcome,
      violations: card.violations
    })),
    rawResponse:
      input.rawResponseJson === undefined
        ? null
        : redactDiagnosticText(input.rawResponseJson),
    ...(input.providerFailure === undefined
      ? {}
      : { providerFailure: input.providerFailure })
  });
}

/**
 * UNC-257 / T6 review follow-up: `detectSecrets` (credential-detector.ts)
 * only redacts a secret/token when it is either a recognized vendor
 * signature, assigned with an immediate `key:`/`key=` delimiter, or a bare
 * run of >=32 high-entropy characters. A secret leaked in prose with none
 * of those shapes (e.g. "here's the token sk-abcdef1234567890abcdef")
 * passed through unredacted — see the (formerly skipped) test in
 * tests/draft-storage.test.ts.
 *
 * This is closed here, not by widening `ASSIGNMENT_PATTERN` in
 * credential-detector.ts — that detector is shared with the
 * safety-report/export-blocking pipeline, and matching "keyword +
 * whitespace" would redact the next word after every ordinary use of
 * "secret"/"token"/"auth" in prose ("secret sauce", "token bucket"), a
 * product-wide false-positive regression. Instead, `redactPrefixAnchoredTokens`
 * below adds a *prefix-anchored* pass (matching on a vendor-specific token
 * prefix, not on a preceding keyword) that cannot produce that kind of
 * false positive, and keeps the pattern local to this module so
 * `credential-detector.ts` — and everything that shares it — is untouched.
 *
 * A token with no recognizable vendor prefix, shorter than 32 characters, and
 * with no `key:`/`key=` delimiter is caught by a further keyword-anchored pass
 * (`redactKeywordAnchoredTokens` below), which is fail-closed by shape rather
 * than by vocabulary and stays local to diagnostics for the same reason.
 *
 * Remaining boundary (still open, honestly): a token that appears with no
 * vendor prefix, no delimiter, under 32 characters, *and* no nearby credential
 * keyword — a bare string in free prose — remains undetectable without a
 * heuristic that would redact ordinary words. That residual gap is not closed
 * here.
 */
function redactDiagnosticText(value: string): string {
  const afterSanitize = sanitizeText(value).value;
  const afterArchitecture = redactArchitectureDisclosure(afterSanitize).value;
  const afterSecrets = detectSecrets(afterArchitecture).value;
  const afterPrefixTokens = redactPrefixAnchoredTokens(afterSecrets);

  return redactKeywordAnchoredTokens(afterPrefixTokens);
}

/**
 * UNC-257 / T6 review follow-up: prefix-anchored token redaction, local to
 * `draft-storage.ts` only — see the comment on `redactDiagnosticText` above
 * for why this doesn't live in `credential-detector.ts`. Anchoring on a
 * vendor-specific prefix (rather than a preceding keyword like "token"/
 * "secret") means these patterns cannot fire on ordinary prose, so they're
 * safe to keep loose about what follows the prefix.
 */
const PREFIX_ANCHORED_TOKEN_PATTERNS: RegExp[] = [
  // Generic "sk-" secret-key prefix used by OpenAI, Anthropic, and similar
  // vendors (also matches variants such as "sk-proj-...", "sk-ant-...").
  // Not covered by VENDOR_PATTERNS in credential-detector.ts, which only
  // recognizes the underscore-delimited Stripe form (`sk_live_...`).
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Stripe test-mode secret key. VENDOR_PATTERNS in credential-detector.ts
  // only covers the live-mode `sk_live_` form.
  /\bsk_test_[0-9a-zA-Z]{16,}\b/g
];

// Matches the `[redacted-secret]` placeholder convention `detectSecrets`
// already uses in credential-detector.ts, so diagnostics readers see one
// consistent marker for "a secret was here" regardless of which pass caught
// it.
const PREFIX_ANCHORED_TOKEN_PLACEHOLDER = "[redacted-secret]";

function redactPrefixAnchoredTokens(value: string): string {
  return PREFIX_ANCHORED_TOKEN_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, PREFIX_ANCHORED_TOKEN_PLACEHOLDER),
    value
  );
}

/**
 * UNC-257 review follow-up #2: closes the residual gap the passes above leave
 * open — a token with no recognized vendor prefix, shorter than the 32-char
 * high-entropy sweep, and with no `key:`/`key=` delimiter ("token
 * abc123def456ghi789") reached caption-failure.json verbatim.
 *
 * This still does not widen `credential-detector.ts`: that detector gates
 * export/safety-report decisions product-wide, where redacting the word after
 * every "token"/"secret" in prose would be a real regression. Here the blast
 * radius is one local diagnostics file that nothing publishes, so diagnostics
 * redaction is deliberately fail-closed — an over-redacted word costs a reader
 * one word of context, an under-redacted one persists a credential to disk.
 *
 * The false positive that matters ("token bucket", "secret sauce") is avoided
 * by shape rather than by vocabulary: only candidates that look like tokens —
 * at least 12 characters and either containing a digit or mixing letter case —
 * are redacted, so ordinary lowercase English words after a keyword survive.
 */
const KEYWORD_ANCHORED_TOKEN_PATTERN =
  /\b(?:api[_-]?keys?|keys?|tokens?|secrets?|passwords?|passphrases?|credentials?|auth|bearer)\b[ \t]+(?:is[ \t]+|was[ \t]+)?([A-Za-z0-9_\-./+=]{12,})/gi;

function redactKeywordAnchoredTokens(value: string): string {
  return value.replace(
    KEYWORD_ANCHORED_TOKEN_PATTERN,
    (match, candidate: string) => {
      if (!isTokenShaped(candidate)) {
        return match;
      }

      return match.replace(candidate, PREFIX_ANCHORED_TOKEN_PLACEHOLDER);
    }
  );
}

function isTokenShaped(candidate: string): boolean {
  const hasDigit = /\d/.test(candidate);
  const hasMixedCase = /[a-z]/.test(candidate) && /[A-Z]/.test(candidate);

  return hasDigit || hasMixedCase;
}

export async function writeLatestDraftPointer(
  revision: DraftRevision,
  updatedAt: string
): Promise<LatestDraftPointer> {
  const pointer: LatestDraftPointer = {
    schemaVersion: 1,
    targetDate: revision.targetDate,
    revision: revision.revision,
    path: revision.outputDir,
    updatedAt
  };

  await writeDraftPointer(revision.latestPointerPath, pointer);
  await writeDraftPointer(revision.dateLatestPointerPath, pointer);

  return pointer;
}

export async function readLatestDraftPointer(
  draftRoot: string
): Promise<LatestDraftPointer> {
  try {
    const parsed = JSON.parse(
      await readFile(join(draftRoot, "latest.json"), "utf8")
    ) as unknown;

    if (isLatestDraftPointer(parsed)) {
      return parsed;
    }
  } catch (error) {
    if (isNodeError(error) && error.code !== "ENOENT") {
      throw new DraftStorageError(
        "Latest draft pointer is invalid.",
        "invalid-pointer"
      );
    }
  }

  throw new DraftStorageError("Latest draft pointer is missing.", "invalid-pointer");
}

async function allocateNextRevision(dateDir: string): Promise<string> {
  let entries: string[];

  try {
    entries = await readdir(dateDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return formatRevision(1);
    }

    throw new DraftStorageError(
      "Could not inspect draft revisions.",
      "inspect-failed"
    );
  }

  const highestRevision = entries.reduce((highest, entry) => {
    const match = /^rev-(\d{3})$/.exec(entry);

    if (!match) {
      return highest;
    }

    return Math.max(highest, Number(match[1]));
  }, 0);

  return formatRevision(highestRevision + 1);
}

async function writeDraftPointer(
  path: string,
  pointer: LatestDraftPointer
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }
}

function formatRevision(value: number): string {
  return `rev-${String(value).padStart(3, "0")}`;
}

function isLatestDraftPointer(value: unknown): value is LatestDraftPointer {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.targetDate === "string" &&
    typeof value.revision === "string" &&
    /^rev-\d{3}$/.test(value.revision) &&
    typeof value.path === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
