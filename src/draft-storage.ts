import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * composed in as well.
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
 * UNC-257 / T6 review follow-up: coverage here is bounded by whatever the
 * three composed detectors catch, not by a purpose-built diagnostics
 * redactor. Known gap — `detectSecrets` (credential-detector.ts) only
 * redacts a secret/token when it is either a recognized vendor signature,
 * assigned with an immediate `key:`/`key=` delimiter, or a bare run of
 * >=32 high-entropy characters. A secret leaked in prose with none of those
 * shapes (e.g. "here's the token sk-...") passes through unredacted. This
 * is deliberately NOT closed by widening `ASSIGNMENT_PATTERN` in
 * credential-detector.ts — that detector is shared with the
 * safety-report/export-blocking pipeline, and matching "keyword +
 * whitespace" would redact the next word after every ordinary use of
 * "secret"/"token"/"auth" in prose ("secret sauce", "token bucket"),
 * a product-wide false-positive regression. See the skipped case in
 * tests/draft-storage.test.ts ("[known gap] does not yet redact an
 * undelimited token in prose") for a reproduction.
 */
function redactDiagnosticText(value: string): string {
  const afterSanitize = sanitizeText(value).value;
  const afterArchitecture = redactArchitectureDisclosure(afterSanitize).value;

  return detectSecrets(afterArchitecture).value;
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
