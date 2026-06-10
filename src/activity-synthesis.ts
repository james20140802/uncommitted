import type { ActivitySignal } from "./event-source.js";
import type { ActivityTheme } from "./activity-summary.js";

export type ActivitySynthesis = {
  smallWins: string[];
  blockersOrConfusion: string[];
  unfinishedThreads: string[];
  themes: Exclude<ActivityTheme, "mixed" | "quiet">[];
};

/**
 * Source-agnostic synthesis of an ActivitySignal stream.
 *
 * Derives only the 4 fields that have no source-shape dependency:
 *   - themes (used by dominantTheme)
 *   - smallWins
 *   - unfinishedThreads
 *   - blockersOrConfusion
 *
 * possibleJokes is derived separately because it depends on aggregate
 * presence/absence flags (hasBlockers, hasUncommittedChanges) rather than
 * on individual signals.
 *
 * Behavior is keyed on (kind, summary), never on source type. Unknown
 * kinds are treated as opaque — only the summary text drives synthesis.
 *
 * Rules:
 *  - "commit" signals: summary is always added to smallWins (matches the
 *    legacy `smallWins.push(sanitizedSubject.value)` rule in the git path).
 *  - "note" signals: summary is classified for smallWin / blocker /
 *    unfinished using the existing looksLike* predicates.
 *  - "dirty-file" signals: skipped entirely — no themes, smallWins,
 *    blockers, or threads. Their "<status>: <path>" summary is file-status
 *    context only and must not infer intent (e.g. a "src/fix-bug.ts" path
 *    must not set a debugging theme). The uncommitted-files thread aggregate
 *    is derived separately from the source-shaped uncommittedChanges output.
 *  - Themes: every non-dirty signal's summary is fed through classifyThemes.
 */
export function deriveSynthesisFromSignals(
  signals: ActivitySignal[]
): ActivitySynthesis {
  const smallWins: string[] = [];
  const blockersOrConfusion: string[] = [];
  const unfinishedThreads: string[] = [];
  const themes = new Set<Exclude<ActivityTheme, "mixed" | "quiet">>();

  for (const signal of signals) {
    // dirty-file summaries are "<status>: <path>" — file-status context only,
    // never intent. Skip them entirely (no themes, wins, blockers, threads) so
    // an uncommitted path like "src/fix-bug.ts" can't invent a dominant theme.
    if (signal.kind === "dirty-file") {
      continue;
    }

    for (const theme of classifyThemes(signal.summary)) {
      themes.add(theme);
    }

    if (signal.kind === "commit") {
      smallWins.push(signal.summary);
      continue;
    }

    // All other kinds (note, pr, future) are pattern-classified.
    if (looksLikeSmallWin(signal.summary)) {
      smallWins.push(signal.summary);
    }
    if (looksLikeBlocker(signal.summary)) {
      blockersOrConfusion.push(signal.summary);
    }
    if (looksUnfinished(signal.summary)) {
      unfinishedThreads.push(signal.summary);
    }
  }

  return {
    smallWins,
    blockersOrConfusion,
    unfinishedThreads,
    themes: sortThemes(themes)
  };
}

export function classifyThemes(text: string): Exclude<ActivityTheme, "mixed" | "quiet">[] {
  const lowerText = text.toLowerCase();
  const themes = new Set<Exclude<ActivityTheme, "mixed" | "quiet">>();

  if (/\b(refactor|cleanup|rename|restructure|simplify)\b/.test(lowerText)) {
    themes.add("refactoring");
  }

  if (/\b(plan|planned|planning|spec|design|milestone|todo|roadmap)\b/.test(lowerText)) {
    themes.add("planning");
  }

  if (/\b(blocked|bug|debug|error|exception|fail|failed|failing|fix|fixed|flaky|unclear)\b/.test(lowerText)) {
    themes.add("debugging");
  }

  if (/\b(add|build|command|feature|implement|implemented|test|update)\b/.test(lowerText)) {
    themes.add("coding");
  }

  return sortThemes(themes);
}

export function sortThemes(
  themes: Set<Exclude<ActivityTheme, "mixed" | "quiet">>
): Exclude<ActivityTheme, "mixed" | "quiet">[] {
  return Array.from(themes).sort((left, right) => left.localeCompare(right));
}

function looksLikeSmallWin(text: string): boolean {
  return /\b(add|built|fixed|implement|implemented|shipped|solved)\b/i.test(text);
}

function looksLikeBlocker(text: string): boolean {
  return /\b(blocked|confused|confusion|failed|failing|stuck|unclear)\b/i.test(text);
}

function looksUnfinished(text: string): boolean {
  return /\b(follow-up|later|todo|tomorrow|unfinished|wip)\b/i.test(text);
}
