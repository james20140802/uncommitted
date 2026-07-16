/**
 * Pre-injection safety gate for reflected memory (threads and persona core
 * facts) before they are folded into `buildActivitySummary`.
 *
 * Threads are derived from raw activity signals (see reflection.ts) and core
 * facts are durable persona notes (see persona-core-facts.ts) — both are
 * free-form text that may still carry sensitive content even after
 * `sanitizeText`. This module reuses the existing `checkDraftSafety` safety
 * pipeline (the same one used for caption/draft export) as a second,
 * independent gate: content whose `report.status` is `"blocked"` is dropped
 * entirely rather than injected into the generated summary, and content
 * whose status is `"warning"` is injected only in its redacted form.
 *
 * No new safety categories are introduced here — this module is a thin
 * consumer of `checkDraftSafety` from safety-report.ts.
 */
import type { MemoryThread } from "./memory-store.js";
import { checkDraftSafety } from "./safety-report.js";

/**
 * Gate a single memory thread for injection. Returns `null` when
 * `checkDraftSafety(thread.note)` reports `"blocked"` (the thread must never
 * be injected). Otherwise returns a copy of `thread` with `note` replaced by
 * the redacted text (a no-op replacement when the note was already safe).
 */
export function gateThreadForInjection(thread: MemoryThread): MemoryThread | null {
  const { report, redactedText } = checkDraftSafety(thread.note);

  if (report.status === "blocked") {
    return null;
  }

  return { ...thread, note: redactedText };
}

/**
 * Gate a single persona core fact for injection. Returns `null` when
 * `checkDraftSafety(fact)` reports `"blocked"`. Otherwise returns the
 * redacted text (a no-op replacement when the fact was already safe).
 */
export function gateCoreFactForInjection(fact: string): string | null {
  const { report, redactedText } = checkDraftSafety(fact);

  if (report.status === "blocked") {
    return null;
  }

  return redactedText;
}

export type MemoryForInjection = {
  threads: MemoryThread[];
  coreFacts: string[];
};

/**
 * Gate every thread and core fact in `input` through the safety pipeline,
 * returning only the surviving (non-null) items.
 */
export function gateMemoryForInjection(input: MemoryForInjection): MemoryForInjection {
  const threads = input.threads
    .map(gateThreadForInjection)
    .filter((thread): thread is MemoryThread => thread !== null);

  const coreFacts = input.coreFacts
    .map(gateCoreFactForInjection)
    .filter((fact): fact is string => fact !== null);

  return { threads, coreFacts };
}
