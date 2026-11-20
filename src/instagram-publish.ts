import { access, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftStorageError, readLatestDraftPointer } from "./draft-storage.js";
import {
  RevisionFormatError,
  resolveLatestRevForDate,
  resolveSpecificRev
} from "./draft-revision-resolver.js";
import {
  assertDraftIsComplete,
  ExportCommandError,
  exportErrorExitCode,
  readSafetyInfo
} from "./export-command.js";
import {
  DEFAULT_QUOTA_TOTAL,
  GRAPH_API_BASE,
  type GraphFetch,
  type InstagramDeps,
  resolvePublishAccount
} from "./instagram-account.js";
import {
  type HostingDeps,
  HostingError,
  resolveImageHost,
  withHostedImages
} from "./instagram-hosting.js";
import { InstagramMediaError, prepareInstagramMedia } from "./instagram-media.js";
import type { SafetyStatus } from "./safety-report.js";
import { isRecord } from "./type-guards.js";

/**
 * UNC-296: `uncommitted publish instagram` — publish a draft revision as an
 * Instagram carousel through the Graph API (graph.facebook.com, System User
 * token). Flow: media prep (UNC-294) → hosted upload (UNC-295) → one child
 * container per image → wait for FINISHED → CAROUSEL container →
 * media_publish → permalink → hosting cleanup. `publish-record.json` in the
 * revision folder marks a revision as published and blocks re-publishing.
 */

/** Exit code for a publish that failed after local validation (AGENTS.md). */
export const PUBLISH_FAILED_EXIT_CODE = 7;
export const PUBLISH_RECORD_FILE = "publish-record.json";
/** Per-revision lock held from the record check until the record is written. */
export const PUBLISH_LOCK_FILE = "publish.lock";
export const CONTAINER_POLL_INTERVAL_MS = 60_000;
export const CONTAINER_POLL_TIMEOUT_MS = 5 * 60_000;
const CAPTION_PREVIEW_CHARS = 80;
/** UNC-298: failure record in the revision folder, read by `--retry`. */
export const PUBLISH_ATTEMPT_FILE = "publish-attempt.json";
/** Meta keeps an unpublished container for 24 hours. */
export const CONTAINER_REUSE_WINDOW_MS = 24 * 60 * 60_000;
/** Backoff before each retry of a 5xx or network failure (so at most 2 retries). */
export const TRANSIENT_RETRY_DELAYS_MS = [2_000, 5_000];

export const PUBLISH_USAGE =
  "Usage: uncommitted publish instagram [--yes] [--dry-run] [--retry] [--date YYYY-MM-DD [--revision rev-NNN]]";

export type PublishRecord = {
  platform: "instagram";
  mediaId: string;
  permalink: string | null;
  publishedAt: string;
  safetyStatus: SafetyStatus;
};

export type PublishIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type PublishDeps = InstagramDeps &
  Pick<HostingDeps, "hostingFetch"> & {
    draftRoot: string;
    /** ISO timestamp for `publishedAt`. */
    now?: () => string;
    /** Asks the user; `undefined` means no interactive terminal. */
    confirm?: (question: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    /** Milliseconds clock for the polling deadline. */
    clock?: () => number;
  };

type PublishArgs = {
  yes: boolean;
  dryRun: boolean;
  retry: boolean;
  date?: string;
  revision?: string;
};

/** What `publish-attempt.json` holds. No token, secret or hosted URL. */
export type PublishAttempt = {
  platform: "instagram";
  stage: string;
  message: string;
  failedAt: string;
  carouselContainerId?: string;
  containerCreatedAt?: string;
};

/** A failure with the stage it happened in; printed as one line. */
class PublishStop extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stage?: string
  ) {
    super(message);
  }
}

export async function runPublishInstagram(
  args: string[],
  deps: PublishDeps,
  rawIo: PublishIo
): Promise<number> {
  const secrets: string[] = [];
  const io = scrubbedIo(rawIo, secrets);

  try {
    const parsed = parseArgs(args);
    const draft = await resolveDraft(deps.draftRoot, parsed);
    const result = await executePublish(draft, parsed, deps, io, secrets);
    if (result.kind === "published") {
      io.stdout(`게시됨: ${result.permalink ?? `media ID ${result.mediaId}`}`);
    }
    return 0;
  } catch (error) {
    const stop = toPublishStop(error);
    io.stderr(
      stop.stage
        ? `게시 실패 [${stop.stage}]: ${stop.message}${stop.stage === "게시" || stop.stage === "게시 기록 저장" ? "" : " Instagram에는 게시되지 않았습니다."}`
        : stop.message
    );
    return stop.exitCode;
  }
}

// ---------------------------------------------------------------------------
// Scheduled auto-publish (UNC-297)
// ---------------------------------------------------------------------------

/** Why a scheduled run did not publish. A skip is not a failure. */
export type PublishSkipReason =
  | "safety-warning"
  | "safety-blocked"
  | "no-safety-report"
  | "incomplete-draft"
  | "already-published"
  | "user-skip"
  | "no-draft";

/** Result of one automatic publish attempt; drives `schedule status` and the log. */
export type PublishOutcome =
  | {
      kind: "published";
      date: string;
      revision: string;
      mediaId: string;
      permalink: string | null;
    }
  | { kind: "skipped"; reason: PublishSkipReason; date: string; revision?: string }
  | { kind: "failed"; stage: string; message: string; date: string; revision?: string };

/** Stage name when a failure happens before any Graph API step (account, hosting config). */
export const PUBLISH_PREPARE_STAGE = "게시 준비";

/**
 * Publish the latest revision of `date` without asking (`--yes` semantics).
 * Never throws: skip conditions come back as `skipped` before any account,
 * keychain or network access, and every failure comes back as `failed` with
 * the stage it happened in. Progress lines go to `io`, scrubbed of secrets.
 */
export async function autoPublishInstagram(
  deps: PublishDeps,
  options: { date: string },
  rawIo: PublishIo
): Promise<PublishOutcome> {
  const secrets: string[] = [];
  const io = scrubbedIo(rawIo, secrets);
  const date = options.date;
  let revision: string | undefined;

  try {
    const resolved = await resolveLatestRevForDate(deps.draftRoot, date);
    if (!resolved) {
      return { kind: "skipped", reason: "no-draft", date };
    }
    revision = resolved.revision;
    const draft: ResolvedDraft = { targetDate: date, revision, path: resolved.outputDir };

    if (await readPublishRecord(draft.path)) {
      return { kind: "skipped", reason: "already-published", date, revision };
    }
    if (!(await isDraftComplete(draft.path))) {
      return { kind: "skipped", reason: "incomplete-draft", date, revision };
    }
    // Unattended publishing needs an affirmative `safe` result: a missing or
    // unreadable report is not treated as safe here (manual publish still is).
    const safetyStatus = await readExistingSafetyStatus(draft.path);
    if (safetyStatus === null) {
      return { kind: "skipped", reason: "no-safety-report", date, revision };
    }
    if (safetyStatus !== "safe") {
      return {
        kind: "skipped",
        reason: safetyStatus === "blocked" ? "safety-blocked" : "safety-warning",
        date,
        revision
      };
    }

    const result = await executePublish(
      draft,
      { yes: true, dryRun: false, retry: false },
      deps,
      io,
      secrets
    );
    if (result.kind === "published") {
      return {
        kind: "published",
        date,
        revision,
        mediaId: result.mediaId,
        permalink: result.permalink
      };
    }
    // A concurrent run published it between our check and the lock.
    return { kind: "skipped", reason: "already-published", date, revision };
  } catch (error) {
    const stop =
      error instanceof PublishStop ||
      error instanceof ExportCommandError ||
      error instanceof HostingError
        ? toPublishStop(error)
        : new PublishStop(
            error instanceof Error ? error.message : String(error),
            PUBLISH_FAILED_EXIT_CODE
          );
    return {
      kind: "failed",
      stage: stop.stage ?? PUBLISH_PREPARE_STAGE,
      message: scrubOutput(stop.message, secrets),
      date,
      ...(revision ? { revision } : {})
    };
  }
}

/** Status from a present, valid `safety-report.json`; `null` when missing or unreadable. */
async function readExistingSafetyStatus(draftPath: string): Promise<SafetyStatus | null> {
  try {
    await access(join(draftPath, "safety-report.json"));
    return (await readSafetyInfo(draftPath)).status;
  } catch {
    return null;
  }
}

/** Draft has a carousel and caption and is not marked incomplete. */
async function isDraftComplete(draftPath: string): Promise<boolean> {
  try {
    await assertDraftIsComplete(draftPath);
    await readFile(join(draftPath, "caption.txt"), "utf8");
    const pngs = (await readdir(join(draftPath, "carousel"))).filter((name) =>
      name.toLowerCase().endsWith(".png")
    );
    return pngs.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared publish flow
// ---------------------------------------------------------------------------

type ExecuteResult =
  | { kind: "already-published" }
  | { kind: "dry-run" }
  | { kind: "cancelled" }
  | { kind: "published"; mediaId: string; permalink: string | null };

/**
 * Record check → lock → safety → account → (`--retry`: reusable container?) →
 * hosting → media prep → quota → preview → confirm → carousel publish →
 * record. Throws {@link PublishStop} with the stage on failure; a failure
 * after the account step also leaves `publish-attempt.json` (UNC-298).
 */
async function executePublish(
  draft: ResolvedDraft,
  parsed: Pick<PublishArgs, "yes" | "dryRun" | "retry">,
  deps: PublishDeps,
  io: PublishIo,
  secrets: string[]
): Promise<ExecuteResult> {
  let workDir: string | undefined;
  let lockPath: string | undefined;
  const now = deps.now ?? (() => new Date().toISOString());
  /** Carousel container this run created or reused; goes into the failure record. */
  let container: { id: string; createdAt: string } | undefined;
  let recordFailure = false;
  try {
    const existing = await readPublishRecord(draft.path);
    if (existing) {
      io.stdout(`이미 게시됨: ${existing.permalink ?? `(permalink 없음, media ID ${existing.mediaId})`}`);
      return { kind: "already-published" };
    }

    if (!parsed.dryRun) {
      lockPath = await acquireRevisionLock(draft.path);
      // Re-check under the lock: a concurrent run may have just finished.
      const raced = await readPublishRecord(draft.path);
      if (raced) {
        io.stdout(`이미 게시됨: ${raced.permalink ?? `(permalink 없음, media ID ${raced.mediaId})`}`);
        return { kind: "already-published" };
      }
    }

    const safety = await readSafetyInfo(draft.path);
    if (safety.status === "blocked") {
      throw new PublishStop(
        "게시 거절: safety 상태가 blocked입니다. safety-report.json을 확인하세요.",
        6
      );
    }

    const account = await resolvePublishAccount(deps);
    if (!account.ok) {
      throw new PublishStop(account.message, account.exitCode);
    }
    secrets.push(account.accessToken);
    const poll = {
      sleep: deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
      clock: deps.clock ?? (() => Date.now())
    };
    const graph = createGraphClient(deps.graphFetch, account.accessToken, poll.sleep);
    recordFailure = !parsed.dryRun;

    if (parsed.retry && !parsed.dryRun) {
      container = await findReusableContainer(draft.path, graph, Date.parse(now()), io);
    }

    const host = container
      ? undefined
      : await resolveImageHost({
          homeDir: deps.homeDir,
          keychainRunner: deps.keychainRunner,
          hostingFetch: deps.hostingFetch
        });

    workDir = await mkdtemp(join(tmpdir(), "uncommitted-publish-"));
    const media = await prepareInstagramMedia({ draftPath: draft.path, outputDir: workDir }).catch(
      (error: unknown) => {
        if (error instanceof InstagramMediaError) {
          throw new PublishStop(error.message, PUBLISH_FAILED_EXIT_CODE, "미디어 준비");
        }
        throw error;
      }
    );

    const quota = await readPublishingQuota(graph, account.igUserId);
    if (quota.usage >= quota.total) {
      throw new PublishStop(
        `24시간 게시 한도에 도달했습니다 (${quota.usage}/${quota.total}). 한도가 풀린 뒤 다시 실행하세요.`,
        PUBLISH_FAILED_EXIT_CODE,
        "게시 한도 확인"
      );
    }

    const warning = media.warnings[0];
    io.stdout(`드래프트: ${draft.targetDate} ${draft.revision}`);
    io.stdout(`장수: ${media.images.length}장`);
    io.stdout(`캡션: ${captionPreview(media.caption)}`);
    io.stdout(`safety: ${media.safetyStatus}`);
    io.stdout(`게시 한도: ${quota.usage}/${quota.total} (24시간)`);
    if (container) {
      io.stdout("재시도: 기존 컨테이너로 게시합니다. 이미지를 다시 올리지 않습니다.");
    }

    if (parsed.dryRun) {
      if (warning) io.stderr(warning);
      io.stdout("검증 통과. dry-run이라 업로드와 게시를 하지 않았습니다.");
      return { kind: "dry-run" };
    }

    if (parsed.yes) {
      if (warning) io.stderr(warning);
    } else {
      if (!deps.confirm) {
        recordFailure = false;
        throw new PublishStop(
          "확인할 대화형 터미널이 없습니다. 확인 없이 게시하려면 --yes를 붙이세요.",
          1
        );
      }
      const question = warning
        ? `${warning}\n경고가 있습니다. 그래도 Instagram에 게시할까요? [y/N]`
        : "Instagram에 게시할까요? [y/N]";
      if (!(await deps.confirm(question))) {
        io.stdout("게시를 취소했습니다. 아무것도 올리지 않았습니다.");
        return { kind: "cancelled" };
      }
    }

    const publishedAt = now();
    const baseRecord = { platform: "instagram" as const, publishedAt, safetyStatus: media.safetyStatus };

    let stage = "이미지 업로드";
    const publishCarousel = async (carousel: string): Promise<string> => {
      stage = "캐러셀 컨테이너 처리";
      await waitUntilFinished(graph, [carousel], stage, poll);

      stage = "게시";
      const published = requireId(
        await graph.post(`/${account.igUserId}/media_publish`, { creation_id: carousel }, stage, {
          // A dropped response may hide a successful publish: never post twice.
          beforeRetry: async () => {
            const body = await graph.get(`/${carousel}`, { fields: "status_code" }, stage);
            if (body.status_code === "PUBLISHED") {
              throw new PublishStop(ALREADY_PUBLISHED_CONTAINER_MESSAGE, PUBLISH_FAILED_EXIT_CODE, stage);
            }
          }
        }),
        stage
      );
      // The post is live: persist it before cleanup or permalink lookup, so
      // an interrupted run can never publish this revision again.
      recordFailure = false;
      stage = "게시 기록 저장";
      await writePublishRecord(draft.path, { ...baseRecord, mediaId: published, permalink: null });
      return published;
    };

    let mediaId: string;
    if (container) {
      mediaId = await publishCarousel(container.id);
    } else {
      const files = await Promise.all(
        media.images.map(async (image) => ({
          bytes: new Uint8Array(await readFile(image.path)),
          contentType: "image/jpeg"
        }))
      );
      mediaId = await withHostedImages(
        host!,
        files,
        async (urls) => {
          secrets.push(...urls);
          stage = "하위 컨테이너 생성";
          const children: string[] = [];
          for (const url of urls) {
            const child = await graph.post(`/${account.igUserId}/media`, {
              image_url: url,
              is_carousel_item: "true"
            }, stage);
            children.push(requireId(child, stage));
          }

          stage = "하위 컨테이너 처리";
          await waitUntilFinished(graph, children, stage, poll);

          stage = "캐러셀 컨테이너 생성";
          const carousel = requireId(
            await graph.post(`/${account.igUserId}/media`, {
              media_type: "CAROUSEL",
              children: children.join(","),
              caption: media.caption
            }, stage),
            stage
          );
          container = { id: carousel, createdAt: now() };
          return publishCarousel(carousel);
        },
        { onWarning: (message) => io.stderr(message) }
      ).catch((error: unknown) => {
        if (error instanceof HostingError) {
          throw new PublishStop(error.message, PUBLISH_FAILED_EXIT_CODE, stage);
        }
        throw error;
      });
    }
    await rm(join(draft.path, PUBLISH_ATTEMPT_FILE), { force: true });

    let permalink: string | null = null;
    try {
      const body = await graph.get(`/${mediaId}`, { fields: "permalink" }, "permalink 조회");
      permalink = typeof body.permalink === "string" ? body.permalink : null;
    } catch {
      io.stderr("게시는 됐지만 permalink를 읽지 못했습니다. Instagram 앱에서 확인하세요.");
    }
    if (permalink) {
      await writePublishRecord(draft.path, { ...baseRecord, mediaId, permalink }).catch(() => {
        io.stderr(`게시 기록에 permalink를 추가하지 못했습니다 (media ID ${mediaId}는 기록됨).`);
      });
    }

    return { kind: "published", mediaId, permalink };
  } catch (error) {
    if (recordFailure) {
      const stop = error instanceof PublishStop ? error : undefined;
      // Keep the last container when this run made none, so a refused or
      // pre-upload failure never hides a container that may already be live.
      const previous = container ? null : await readPublishAttempt(draft.path);
      if (previous?.carouselContainerId && previous.containerCreatedAt) {
        container = { id: previous.carouselContainerId, createdAt: previous.containerCreatedAt };
      }
      await writePublishAttempt(draft.path, {
        platform: "instagram",
        stage: stop?.stage ?? PUBLISH_PREPARE_STAGE,
        message: scrubOutput(error instanceof Error ? error.message : String(error), secrets),
        failedAt: now(),
        ...(container
          ? { carouselContainerId: container.id, containerCreatedAt: container.createdAt }
          : {})
      });
    }
    throw error;
  } finally {
    if (lockPath) {
      await rm(lockPath, { force: true });
    }
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

const ALREADY_PUBLISHED_CONTAINER_MESSAGE =
  "이 컨테이너는 이미 게시됐습니다. 중복 게시를 막으려고 멈춥니다. Instagram에서 게시물을 확인하고, 맞다면 publish-record.json을 직접 남기세요.";

/**
 * `--retry`: the carousel container from the last failure, if it is younger
 * than 24 hours and still publishable. PUBLISHED stops the run (never post
 * twice); anything else unusable falls back to a fresh upload.
 */
async function findReusableContainer(
  draftPath: string,
  graph: GraphClient,
  nowMs: number,
  io: PublishIo
): Promise<{ id: string; createdAt: string } | undefined> {
  const attempt = await readPublishAttempt(draftPath);
  const id = attempt?.carouselContainerId;
  const createdAt = attempt?.containerCreatedAt;
  const age = createdAt ? nowMs - Date.parse(createdAt) : NaN;
  if (!id || !createdAt || !(age >= 0 && age < CONTAINER_REUSE_WINDOW_MS)) {
    io.stdout("재시도: 다시 쓸 컨테이너가 없어 처음부터 게시합니다.");
    return undefined;
  }

  const stage = "컨테이너 재사용 확인";
  const code = await graph
    .get(`/${id}`, { fields: "status_code" }, stage)
    .then((body) => (typeof body.status_code === "string" ? body.status_code : ""))
    .catch(() => "");
  if (code === "PUBLISHED") {
    throw new PublishStop(ALREADY_PUBLISHED_CONTAINER_MESSAGE, PUBLISH_FAILED_EXIT_CODE, stage);
  }
  if (code === "FINISHED" || code === "IN_PROGRESS") {
    return { id, createdAt };
  }
  io.stdout("재시도: 기존 컨테이너를 쓸 수 없어 처음부터 게시합니다.");
  return undefined;
}

async function readPublishAttempt(draftPath: string): Promise<PublishAttempt | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(draftPath, PUBLISH_ATTEMPT_FILE), "utf8")
    );
    if (!isRecord(parsed)) return null;
    return {
      platform: "instagram",
      stage: typeof parsed.stage === "string" ? parsed.stage : "",
      message: typeof parsed.message === "string" ? parsed.message : "",
      failedAt: typeof parsed.failedAt === "string" ? parsed.failedAt : "",
      ...(typeof parsed.carouselContainerId === "string"
        ? { carouselContainerId: parsed.carouselContainerId }
        : {}),
      ...(typeof parsed.containerCreatedAt === "string"
        ? { containerCreatedAt: parsed.containerCreatedAt }
        : {})
    };
  } catch {
    return null;
  }
}

/** Best effort: a failed write must not hide the original publish error. */
async function writePublishAttempt(draftPath: string, attempt: PublishAttempt): Promise<void> {
  await writeFile(
    join(draftPath, PUBLISH_ATTEMPT_FILE),
    `${JSON.stringify(attempt, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
}

function scrubbedIo(rawIo: PublishIo, secrets: string[]): PublishIo {
  return {
    stdout: (line) => rawIo.stdout(scrubOutput(line, secrets)),
    stderr: (line) => rawIo.stderr(scrubOutput(line, secrets))
  };
}

// ---------------------------------------------------------------------------
// Arguments and draft resolution
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): PublishArgs {
  const [platform, ...rest] = args;
  if (platform !== "instagram") {
    throw new PublishStop(PUBLISH_USAGE, 1);
  }
  const parsed: PublishArgs = { yes: false, dryRun: false, retry: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--retry") {
      parsed.retry = true;
    } else if ((arg === "--date" || arg === "--revision") && rest[i + 1] && !rest[i + 1].startsWith("-")) {
      if (arg === "--date") parsed.date = rest[++i];
      else parsed.revision = rest[++i];
    } else {
      throw new PublishStop(PUBLISH_USAGE, 1);
    }
  }
  if (parsed.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    throw new PublishStop(`--date는 YYYY-MM-DD 형식이어야 합니다. ${PUBLISH_USAGE}`, 1);
  }
  if (parsed.revision !== undefined && parsed.date === undefined) {
    throw new PublishStop(`--revision은 --date와 함께 써야 합니다. ${PUBLISH_USAGE}`, 1);
  }
  return parsed;
}

type ResolvedDraft = { targetDate: string; revision: string; path: string };

async function resolveDraft(draftRoot: string, args: PublishArgs): Promise<ResolvedDraft> {
  if (args.date === undefined) {
    try {
      const pointer = await readLatestDraftPointer(draftRoot);
      return { targetDate: pointer.targetDate, revision: pointer.revision, path: pointer.path };
    } catch (error) {
      if (error instanceof DraftStorageError) {
        throw new PublishStop(
          "게시할 latest 드래프트가 없습니다. `uncommitted generate today`와 `uncommitted render latest`를 먼저 실행하세요.",
          1
        );
      }
      throw error;
    }
  }

  let resolved;
  try {
    resolved =
      args.revision === undefined
        ? await resolveLatestRevForDate(draftRoot, args.date)
        : await resolveSpecificRev(draftRoot, args.date, args.revision);
  } catch (error) {
    if (error instanceof RevisionFormatError) {
      throw new PublishStop(`${error.message} ${PUBLISH_USAGE}`, 1);
    }
    throw error;
  }
  if (!resolved) {
    throw new PublishStop(
      `${args.date}${args.revision ? ` ${args.revision}` : ""} 드래프트를 찾을 수 없습니다.`,
      1
    );
  }
  return { targetDate: args.date, revision: resolved.revision, path: resolved.outputDir };
}

async function writePublishRecord(draftPath: string, record: PublishRecord): Promise<void> {
  try {
    await writeFile(
      join(draftPath, PUBLISH_RECORD_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // The post is live; say so, or a re-run would post it twice.
    throw new PublishStop(
      `게시는 됐지만 ${PUBLISH_RECORD_FILE}을 쓰지 못했습니다 (media ID ${record.mediaId}). 다시 실행하기 전에 기록을 직접 남기세요.`,
      PUBLISH_FAILED_EXIT_CODE,
      "게시 기록 저장"
    );
  }
}

/** Exclusive create: a second concurrent run for the same revision refuses. */
async function acquireRevisionLock(draftPath: string): Promise<string> {
  const lockPath = join(draftPath, PUBLISH_LOCK_FILE);
  try {
    const handle = await open(lockPath, "wx");
    await handle.close();
    return lockPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PublishStop(
        `이 리비전을 다른 게시가 진행 중입니다 (${PUBLISH_LOCK_FILE}). 진행 중인 게시가 없다면 Instagram에서 게시 여부를 확인한 뒤 ${PUBLISH_LOCK_FILE}을 지우고 다시 실행하세요.`,
        1
      );
    }
    throw error;
  }
}

async function readPublishRecord(draftPath: string): Promise<PublishRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(draftPath, PUBLISH_RECORD_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || typeof parsed.mediaId !== "string") {
    // Something is there; never risk a duplicate post on a damaged record.
    throw new PublishStop(
      `${PUBLISH_RECORD_FILE}을 읽지 못했습니다. 이미 게시됐는지 Instagram에서 확인한 뒤 파일을 고치거나 지우세요.`,
      1
    );
  }
  return {
    platform: "instagram",
    mediaId: parsed.mediaId,
    permalink: typeof parsed.permalink === "string" ? parsed.permalink : null,
    publishedAt: typeof parsed.publishedAt === "string" ? parsed.publishedAt : "",
    safetyStatus: (parsed.safetyStatus as SafetyStatus) ?? "safe"
  };
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

type CallOptions = {
  /** Runs before each transient retry; may throw to stop retrying. */
  beforeRetry?: () => Promise<void>;
};

type GraphClient = {
  get(path: string, params: Record<string, string>, stage: string): Promise<Record<string, unknown>>;
  post(
    path: string,
    params: Record<string, string>,
    stage: string,
    options?: CallOptions
  ): Promise<Record<string, unknown>>;
};

/**
 * Graph API calls with short retries (UNC-298): a network error or 5xx is
 * retried after each {@link TRANSIENT_RETRY_DELAYS_MS} delay; a 4xx or a
 * Meta error on a 2xx fails at once.
 */
function createGraphClient(
  graphFetch: GraphFetch | undefined,
  accessToken: string,
  sleep: (ms: number) => Promise<void>
): GraphClient {
  const fetchImpl: GraphFetch = graphFetch ?? ((url, init) => fetch(url, init));

  const once = async (
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
    stage: string
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; transient: boolean; stop: PublishStop }> => {
    const url = new URL(`${GRAPH_API_BASE}${path}`);
    const form = new URLSearchParams({ ...params, access_token: accessToken });
    let response: Response;
    let body: unknown;
    try {
      if (method === "GET") {
        for (const [key, value] of form) url.searchParams.set(key, value);
        response = await fetchImpl(url.toString());
      } else {
        // Writes carry the token in the body so it never lands in a URL.
        response = await fetchImpl(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString()
        });
      }
      body = await response.json().catch(() => ({}));
    } catch {
      // The underlying error may carry the request URL; never surface it.
      return {
        ok: false,
        transient: true,
        stop: new PublishStop(
          "Meta Graph API에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.",
          PUBLISH_FAILED_EXIT_CODE,
          stage
        )
      };
    }
    const record = isRecord(body) ? body : {};
    if (response.ok && !isRecord(record.error)) {
      return { ok: true, body: record };
    }
    return {
      ok: false,
      transient: response.status >= 500,
      stop: new PublishStop(metaErrorMessage(record), PUBLISH_FAILED_EXIT_CODE, stage)
    };
  };

  const call = async (
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
    stage: string,
    options: CallOptions = {}
  ) => {
    for (let attempt = 0; ; attempt++) {
      const result = await once(method, path, params, stage);
      if (result.ok) return result.body;
      const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (!result.transient || delay === undefined) throw result.stop;
      await options.beforeRetry?.();
      await sleep(delay);
    }
  };

  return {
    get: (path, params, stage) => call("GET", path, params, stage),
    post: (path, params, stage, options) => call("POST", path, params, stage, options)
  };
}

function metaErrorMessage(body: Record<string, unknown>): string {
  const error = isRecord(body.error) ? body.error : {};
  const message =
    (typeof error.error_user_msg === "string" && error.error_user_msg) ||
    (typeof error.message === "string" && error.message) ||
    "알 수 없는 에러";
  const code = typeof error.code === "number" ? ` (Graph API 에러 ${error.code})` : "";
  return `${message}${code}`;
}

function requireId(body: Record<string, unknown>, stage: string): string {
  if (typeof body.id === "string" && body.id !== "") {
    return body.id;
  }
  throw new PublishStop("Graph API 응답에 ID가 없습니다.", PUBLISH_FAILED_EXIT_CODE, stage);
}

async function readPublishingQuota(
  graph: GraphClient,
  igUserId: string
): Promise<{ usage: number; total: number }> {
  const stage = "게시 한도 확인";
  const body = await graph.get(
    `/${igUserId}/content_publishing_limit`,
    { fields: "quota_usage,config" },
    stage
  );
  const entry = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : undefined;
  if (!entry || typeof entry.quota_usage !== "number") {
    throw new PublishStop("게시 한도 응답을 읽지 못했습니다.", PUBLISH_FAILED_EXIT_CODE, stage);
  }
  const config = isRecord(entry.config) ? entry.config : {};
  const total = typeof config.quota_total === "number" ? config.quota_total : DEFAULT_QUOTA_TOTAL;
  return { usage: entry.quota_usage, total };
}

/**
 * Check every container now, then once a minute, until all are FINISHED.
 * ERROR/EXPIRED stops immediately with Meta's status text; still pending
 * after {@link CONTAINER_POLL_TIMEOUT_MS} is a timeout.
 */
async function waitUntilFinished(
  graph: GraphClient,
  ids: string[],
  stage: string,
  poll: { sleep: (ms: number) => Promise<void>; clock: () => number }
): Promise<void> {
  const start = poll.clock();
  let pending = [...ids];
  for (;;) {
    const stillPending: string[] = [];
    for (const id of pending) {
      const body = await graph.get(`/${id}`, { fields: "status_code,status" }, stage);
      const code = typeof body.status_code === "string" ? body.status_code : "";
      if (code === "FINISHED" || code === "PUBLISHED") continue;
      if (code === "ERROR" || code === "EXPIRED") {
        const detail = typeof body.status === "string" && body.status !== "" ? body.status : code;
        throw new PublishStop(
          `컨테이너가 ${code} 상태가 됐습니다: ${detail}`,
          PUBLISH_FAILED_EXIT_CODE,
          stage
        );
      }
      stillPending.push(id);
    }
    pending = stillPending;
    if (pending.length === 0) return;
    if (poll.clock() - start + CONTAINER_POLL_INTERVAL_MS > CONTAINER_POLL_TIMEOUT_MS) {
      throw new PublishStop(
        `컨테이너가 ${CONTAINER_POLL_TIMEOUT_MS / 60_000}분 안에 FINISHED가 되지 않았습니다. 잠시 뒤 다시 실행하세요.`,
        PUBLISH_FAILED_EXIT_CODE,
        stage
      );
    }
    await poll.sleep(CONTAINER_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function captionPreview(caption: string): string {
  const flat = caption.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > CAPTION_PREVIEW_CHARS
    ? `${chars.slice(0, CAPTION_PREVIEW_CHARS).join("")}…`
    : flat;
}

function toPublishStop(error: unknown): PublishStop {
  if (error instanceof PublishStop) return error;
  if (error instanceof ExportCommandError) {
    return new PublishStop(error.message, exportErrorExitCode(error));
  }
  if (error instanceof HostingError) {
    return new PublishStop(error.message, error.exitCode);
  }
  throw error;
}

/**
 * Last line of defense for AC7: drop known secrets (token, hosted URLs) and
 * any presigned query string (`X-Amz-*`, which carries the access key ID).
 */
function scrubOutput(line: string, secrets: string[]): string {
  const withoutSecrets = secrets.reduce(
    (text, secret) => (secret.length >= 8 ? text.split(secret).join("[redacted]") : text),
    line
  );
  // One greedy pass per query string (linear), then check for a signature.
  return withoutSecrets.replace(/\?[^\s"'<>]*/g, (query) =>
    query.includes("X-Amz-") ? "?[redacted]" : query
  );
}
