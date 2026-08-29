/**
 * Project-local persistence for short-term "threads" (recurring work topics
 * such as an ongoing bug, refactor, or running joke) tracked across days.
 *
 * Threads live at `project-root/.uncommitted/memory/threads.jsonl`, one JSON
 * object per line. Recency is modeled as an exponential decay of `lastSeen`
 * relative to a caller-supplied `now` — this module never reads the system
 * clock itself so every function stays deterministically testable.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError, isRecord } from "./type-guards.js";

export type ThreadKind = "bug" | "refactor" | "running-joke" | "blocker" | "win" | "other";
export type ThreadStatus = "active" | "expired";

export type MemoryThread = {
  id: string;
  firstSeen: string;
  lastSeen: string;
  kind: ThreadKind;
  note: string;
  status: ThreadStatus;
  decay: number;
  /**
   * UNC-229 / T1: 이 스레드가 등장한 **날짜 수**의 누적 카운터. 신호 횟수가
   * 아니라 날짜 수다(같은 날 여러 신호는 1회). 기존 `threads.jsonl` 레코드에는
   * 이 필드가 없으므로 optional이며, `readThreads`가 읽기 시 1로 정규화한다.
   */
  occurrenceCount?: number;
};

export const THREAD_MAX_ENTRIES = 50;
export const THREAD_LAST_N_DAYS = 14;
export const THREAD_TOP_K = 5;
export const THREAD_DECAY_HALF_LIFE_DAYS = 7;

const THREAD_KINDS: readonly ThreadKind[] = [
  "bug",
  "refactor",
  "running-joke",
  "blocker",
  "win",
  "other"
];

const MS_PER_DAY = 86_400_000;

export function memoryDir(projectRoot: string): string {
  return join(projectRoot, ".uncommitted", "memory");
}

export function threadsFilePath(projectRoot: string): string {
  return join(memoryDir(projectRoot), "threads.jsonl");
}

/**
 * Read all threads from `threadsFilePath(projectRoot)`. Returns `[]` when the
 * file does not exist. Malformed or structurally invalid lines are skipped
 * rather than failing the whole read.
 */
export async function readThreads(projectRoot: string): Promise<MemoryThread[]> {
  let text: string;

  try {
    text = await readFile(threadsFilePath(projectRoot), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const threads: MemoryThread[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "") {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (isMemoryThread(parsed)) {
        // UNC-229 / T1: 파일을 재작성하지 않고 읽기 시점에만 정규화한다.
        // 필드가 없는 레거시 레코드 = 최소 1회 관측이므로 1이 사실을 왜곡하지 않는다.
        threads.push({ ...parsed, occurrenceCount: parsed.occurrenceCount ?? 1 });
      }
    } catch {
      // Skip malformed JSONL lines instead of failing the whole read.
    }
  }

  return threads;
}

/**
 * Persist `threads` to `threadsFilePath(projectRoot)`, one JSON object per
 * line. Ensures `memoryDir(projectRoot)` exists first.
 */
export async function writeThreads(
  projectRoot: string,
  threads: MemoryThread[]
): Promise<void> {
  await mkdir(memoryDir(projectRoot), { recursive: true });

  const lines = threads.map((thread) => JSON.stringify(thread));
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";

  await writeFile(threadsFilePath(projectRoot), content, "utf8");
}

/**
 * Recency decay in `[0, 1]`, halving every `THREAD_DECAY_HALF_LIFE_DAYS`.
 * `lastSeen` timestamps in the future relative to `now` clamp `ageDays` to 0
 * (decay of 1) rather than producing a value above 1.
 */
export function recencyDecay(thread: MemoryThread, now: Date): number {
  const rawAgeDays = (now.getTime() - Date.parse(thread.lastSeen)) / MS_PER_DAY;
  const ageDays = Math.max(0, rawAgeDays);

  return 0.5 ** (ageDays / THREAD_DECAY_HALF_LIFE_DAYS);
}

/**
 * True when `thread.lastSeen` is more than `THREAD_LAST_N_DAYS` days before
 * `now`.
 */
export function isThreadExpired(thread: MemoryThread, now: Date): boolean {
  const ageDays = (now.getTime() - Date.parse(thread.lastSeen)) / MS_PER_DAY;

  return ageDays > THREAD_LAST_N_DAYS;
}

/**
 * Recompute decay/status for every thread against `now`, drop expired
 * threads, sort by decay descending (ties broken by most-recent `lastSeen`
 * first), and keep only the top `THREAD_MAX_ENTRIES`.
 */
export function applyThreadBounds(threads: MemoryThread[], now: Date): MemoryThread[] {
  const scored = threads.map((thread) => {
    const decay = recencyDecay(thread, now);
    const expired = isThreadExpired(thread, now);

    return {
      ...thread,
      decay,
      status: expired ? ("expired" as const) : ("active" as const)
    };
  });

  const active = scored.filter((thread) => thread.status === "active");

  active.sort((a, b) => {
    if (b.decay !== a.decay) {
      return b.decay - a.decay;
    }

    return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
  });

  return active.slice(0, THREAD_MAX_ENTRIES);
}

function isThreadKind(value: unknown): value is ThreadKind {
  return typeof value === "string" && (THREAD_KINDS as readonly string[]).includes(value);
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  return value === "active" || value === "expired";
}

/** Structural guard for a fully-formed `MemoryThread`. */
export function isMemoryThread(value: unknown): value is MemoryThread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.firstSeen === "string" &&
    typeof value.lastSeen === "string" &&
    isThreadKind(value.kind) &&
    typeof value.note === "string" &&
    isThreadStatus(value.status) &&
    typeof value.decay === "number" &&
    (value.occurrenceCount === undefined || typeof value.occurrenceCount === "number")
  );
}
