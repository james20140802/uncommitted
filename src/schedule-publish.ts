import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfigPaths } from "./config-paths.js";
import {
  autoPublishInstagram,
  type PublishDeps,
  type PublishIo,
  type PublishOutcome,
  type PublishSkipReason
} from "./instagram-publish.js";
import { isRecord } from "./type-guards.js";

/**
 * UNC-297: opt-in Instagram auto-publish at the end of `schedule run-now`.
 *
 * - The setting lives in `~/.uncommitted/schedule.json`, never in the launchd
 *   plist; secrets stay in the keychain / 0600 config and are read at publish
 *   time only.
 * - Each attempt appends one line to `~/.uncommitted/logs/schedule-publish.jsonl`;
 *   `schedule status` shows the last one.
 * - `uncommitted publish skip` drops `publish-skip.json` into the day's draft
 *   folder; the scheduled run checks it while waiting and right before publishing.
 */

export const SCHEDULE_SETTINGS_FILE = "schedule.json";
export const PUBLISH_SKIP_FILE = "publish-skip.json";
export const SCHEDULE_PUBLISH_LOG_FILE = "schedule-publish.jsonl";
/** Longest delay: keeps a delayed run from overlapping the next day's run. */
export const MAX_PUBLISH_DELAY_MINUTES = 12 * 60;
/** Wall-clock check interval while waiting out the publish delay. */
export const PUBLISH_DELAY_POLL_MS = 30_000;

export type SchedulePublishSetting = { platform: "instagram"; delayMinutes: number };

export type SchedulePublishLogEntry = { at: string; outcome: PublishOutcome };

const SKIP_REASON_LABELS: Record<PublishSkipReason, string> = {
  "safety-warning": "safety warning",
  "safety-blocked": "safety blocked",
  "incomplete-draft": "미완성 드래프트",
  "already-published": "이미 게시됨",
  "user-skip": "사용자 skip",
  "no-draft": "드래프트 없음"
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Parses `--publish-delay` (`30m`, `2h`, `0m`) into minutes. */
export function parsePublishDelay(value: string): number {
  const match = /^(\d+)(m|h)$/.exec(value.trim());
  const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : Number.NaN;
  if (!Number.isInteger(minutes) || minutes > MAX_PUBLISH_DELAY_MINUTES) {
    throw new Error(
      `--publish-delay는 30m이나 2h처럼 분(m)이나 시간(h)으로 쓰고, 최대 ${MAX_PUBLISH_DELAY_MINUTES / 60}h까지입니다.`
    );
  }
  return minutes;
}

function settingsPath(homeDir?: string): string {
  return join(resolveConfigPaths({ homeDir }).configDir, SCHEDULE_SETTINGS_FILE);
}

/** Auto-publish setting, or `null` when off, missing, or unreadable (fail closed). */
export async function readSchedulePublishSetting(
  homeDir?: string
): Promise<SchedulePublishSetting | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(settingsPath(homeDir), "utf8"));
  } catch {
    return null;
  }
  const publish = isRecord(parsed) ? parsed.publish : undefined;
  if (
    isRecord(publish) &&
    publish.platform === "instagram" &&
    typeof publish.delayMinutes === "number" &&
    Number.isInteger(publish.delayMinutes) &&
    publish.delayMinutes >= 0 &&
    publish.delayMinutes <= MAX_PUBLISH_DELAY_MINUTES
  ) {
    return { platform: "instagram", delayMinutes: publish.delayMinutes };
  }
  return null;
}

export async function writeScheduleSettings(
  homeDir: string | undefined,
  publish: SchedulePublishSetting | null
): Promise<void> {
  const path = settingsPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, publish }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

/** Deletes the settings file; returns the publish setting it held. */
export async function removeScheduleSettings(
  homeDir?: string
): Promise<SchedulePublishSetting | null> {
  const previous = await readSchedulePublishSetting(homeDir);
  await rm(settingsPath(homeDir), { force: true });
  return previous;
}

export function describePublishSetting(setting: SchedulePublishSetting | null): string {
  if (!setting) return "자동 게시: 꺼짐";
  const delay = setting.delayMinutes === 0 ? "지연 없음" : `지연 ${setting.delayMinutes}분`;
  return `자동 게시: 켜짐 (${setting.platform}, ${delay})`;
}

// ---------------------------------------------------------------------------
// Skip marker
// ---------------------------------------------------------------------------

function skipPath(draftRoot: string, date: string): string {
  return join(draftRoot, date, PUBLISH_SKIP_FILE);
}

/** Marks `date` so the scheduled run does not publish it. Works before the draft exists. */
export async function writePublishSkip(
  draftRoot: string,
  date: string,
  skippedAt: string
): Promise<string> {
  const path = skipPath(draftRoot, date);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, date, skippedAt }, null, 2)}\n`, "utf8");
  return path;
}

export async function isPublishSkipped(draftRoot: string, date: string): Promise<boolean> {
  try {
    await access(skipPath(draftRoot, date));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

/**
 * Wait until `delayMs` of wall-clock time has passed, checking the skip
 * marker every step. Short sleeps against a wall clock (not one long timer)
 * so a laptop that sleeps through the deadline publishes on wake instead of
 * waiting the remaining timer time.
 */
export async function waitForPublishDeadline(options: {
  delayMs: number;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  isSkipped: () => Promise<boolean>;
  pollMs?: number;
}): Promise<"ready" | "skipped"> {
  const pollMs = options.pollMs ?? PUBLISH_DELAY_POLL_MS;
  const deadline = options.clock() + options.delayMs;
  for (;;) {
    if (await options.isSkipped()) return "skipped";
    const remaining = deadline - options.clock();
    if (remaining <= 0) return "ready";
    await options.sleep(Math.min(remaining, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Scheduled publish
// ---------------------------------------------------------------------------

export async function runScheduledPublish(input: {
  targetDate: string;
  setting: SchedulePublishSetting;
  deps: PublishDeps;
  io: PublishIo;
}): Promise<PublishOutcome> {
  const { targetDate, setting, deps, io } = input;
  const isSkipped = () => isPublishSkipped(deps.draftRoot, targetDate);
  const userSkip: PublishOutcome = { kind: "skipped", reason: "user-skip", date: targetDate };

  if (setting.delayMinutes > 0) {
    io.stdout(
      `게시 대기: ${setting.delayMinutes}분 뒤 Instagram에 게시합니다. 그 전에 \`uncommitted publish skip\`으로 오늘 게시를 막을 수 있습니다.`
    );
    const waited = await waitForPublishDeadline({
      delayMs: setting.delayMinutes * 60_000,
      clock: deps.clock ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))),
      isSkipped
    });
    if (waited === "skipped") return userSkip;
  }

  // Checked again right before publishing (also covers the no-delay case).
  if (await isSkipped()) return userSkip;

  return autoPublishInstagram(deps, { date: targetDate }, io);
}

export function describePublishOutcome(outcome: PublishOutcome): string {
  switch (outcome.kind) {
    case "published":
      return `게시됨: ${outcome.permalink ?? `media ID ${outcome.mediaId}`}`;
    case "skipped":
      return `건너뜀: ${SKIP_REASON_LABELS[outcome.reason]}`;
    case "failed":
      return `실패 [${outcome.stage}]: ${outcome.message}`;
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

function logPath(homeDir?: string): string {
  return join(resolveConfigPaths({ homeDir }).logsDir, SCHEDULE_PUBLISH_LOG_FILE);
}

export async function appendSchedulePublishLog(
  homeDir: string | undefined,
  outcome: PublishOutcome,
  at: string
): Promise<void> {
  const path = logPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  const entry: SchedulePublishLogEntry = { at, outcome };
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readLastSchedulePublishLog(
  homeDir?: string
): Promise<SchedulePublishLogEntry | null> {
  let raw: string;
  try {
    raw = await readFile(logPath(homeDir), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (
        isRecord(parsed) &&
        typeof parsed.at === "string" &&
        isRecord(parsed.outcome) &&
        typeof parsed.outcome.kind === "string" &&
        typeof parsed.outcome.date === "string"
      ) {
        return parsed as SchedulePublishLogEntry;
      }
    } catch {
      // Skip a damaged line and fall back to the one before it.
    }
  }
  return null;
}
