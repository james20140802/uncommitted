/**
 * Reflection: turns redacted `ActivitySignal`s into recurring `MemoryThread`s
 * (an ongoing bug, refactor, running joke, blocker, or win tracked across
 * days). This module is the boundary between "raw-ish" signal summaries and
 * the long-lived thread store — every note that leaves it has been re-run
 * through `sanitizeText` (see `deriveThreadNote`), so it can never persist
 * more than the signal's own already-redacted `summary` allowed.
 *
 * `reflectThreads` is pure and deterministic: no `Math.random()`, no
 * `Date.now()` — every timestamp comes from the caller-supplied `now`, and
 * every thread `id` is derived from its content so the same signal always
 * maps to the same thread.
 */
import { applyThreadBounds, type MemoryThread, type ThreadKind } from "./memory-store.js";
import { readThreads, writeThreads } from "./memory-store.js";
import { sanitizeText } from "./redaction.js";
import type { ActivitySignal } from "./event-source.js";

const BUG_PATTERN = /\b(fix|bug|broken|crash|error|race condition)\b/i;
const REFACTOR_PATTERN = /\b(refactor|clean\s?up|restructure|simplify|rework)\b/i;
const BLOCKER_PATTERN = /\b(block(?:ed|er)?|stuck|waiting on|can'?t proceed)\b/i;
const WIN_PATTERN = /\b(ship(?:ped)?|launch(?:ed)?|release[d]?|done|complete[d]?|win)\b/i;
const JOKE_PATTERN = /\b(lol|again\??|really\?|sigh|classic)\b/i;

/**
 * Deterministic, local classification of a signal into a `ThreadKind`.
 * Never calls out to an AI provider — this is pure string matching on
 * already-redacted text so it stays cheap and offline-safe.
 */
export function signalThreadKind(kind: string, summary: string): ThreadKind {
  if (kind === "note") {
    if (BUG_PATTERN.test(summary)) {
      return "bug";
    }

    if (BLOCKER_PATTERN.test(summary)) {
      return "blocker";
    }

    if (WIN_PATTERN.test(summary)) {
      return "win";
    }

    return "other";
  }

  if (BUG_PATTERN.test(summary)) {
    return "bug";
  }

  if (REFACTOR_PATTERN.test(summary)) {
    return "refactor";
  }

  if (BLOCKER_PATTERN.test(summary)) {
    return "blocker";
  }

  if (WIN_PATTERN.test(summary)) {
    return "win";
  }

  if (JOKE_PATTERN.test(summary)) {
    return "running-joke";
  }

  return "other";
}

/**
 * Re-sanitizes an already-redacted `summary` before it can become a thread
 * `note`. This is the hard block against ever persisting raw code, diffs, or
 * secrets into the thread store: even if an upstream signal producer regresses
 * and leaks raw text into `summary`, this defensive pass strips it again.
 * There is no raw source available to reflection — only `signal.summary` — so
 * this function's input is the full extent of what a thread note can ever
 * contain.
 */
export function deriveThreadNote(summary: string): string {
  return sanitizeText(summary).value;
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "note";
}

function threadKey(kind: ThreadKind, note: string): string {
  return `${kind}:${note}`;
}

function threadId(kind: ThreadKind, note: string): string {
  return `${kind}:${slug(note)}`;
}

/**
 * Pure core: fold `signals` into `threads`, matching existing threads by the
 * normalized `(kind, note)` key. A match bumps `lastSeen` to `now` (keeping
 * the original `firstSeen`); a miss creates a new thread with a
 * content-derived `id`, `firstSeen = lastSeen = now`, `status = "active"`,
 * `decay = 1`. `applyThreadBounds` is applied to the result before it is
 * returned, so decay/expiry/ordering/cap are always up to date.
 */
export function reflectThreads(input: {
  threads: MemoryThread[];
  signals: ActivitySignal[];
  now: Date;
}): MemoryThread[] {
  const { signals, now } = input;
  const byKey = new Map<string, MemoryThread>();

  for (const thread of input.threads) {
    byKey.set(threadKey(thread.kind, thread.note), thread);
  }

  const nowIso = now.toISOString();

  for (const signal of signals) {
    const kind = signalThreadKind(signal.kind, signal.summary);
    const note = deriveThreadNote(signal.summary);
    const key = threadKey(kind, note);
    const existing = byKey.get(key);

    if (existing) {
      byKey.set(key, { ...existing, lastSeen: nowIso });
      continue;
    }

    byKey.set(key, {
      id: threadId(kind, note),
      firstSeen: nowIso,
      lastSeen: nowIso,
      kind,
      note,
      status: "active",
      decay: 1
    });
  }

  return applyThreadBounds([...byKey.values()], now);
}

/**
 * Persistence wrapper for generate wiring: read the project's stored
 * threads, fold `signals` into them via `reflectThreads`, persist the result,
 * and return it so the caller (generate) can pass it on to injection.
 */
export async function reflectProjectThreads(
  projectRoot: string,
  signals: ActivitySignal[],
  now: Date
): Promise<MemoryThread[]> {
  const threads = await readThreads(projectRoot);
  const reflected = reflectThreads({ threads, signals, now });

  await writeThreads(projectRoot, reflected);

  return reflected;
}
