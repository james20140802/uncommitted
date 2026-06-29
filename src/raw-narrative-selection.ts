// Tier 2 deterministic turn selection (UNC-162).
//
// This module is PURE, RULE-BASED, and contains NO LLM. The only LLM in the
// pipeline is the downstream caption writer; selection here is a fixed-rule
// reducer so the same input always yields the same output.
//
// We pick which raw narrative turns to hand to
// `assembleRawNarrativeProjection` under a token budget. Precedence is FIXED:
//
//   (1) session-boundary completeness  >  (2) recency  >  (3) signal density
//
// Algorithm:
//   1. Group turns by `sessionId`, preserving each turn's original index so we
//      can break every tie deterministically.
//   2. Order sessions by recency: a session's recency = its newest turn
//      timestamp. Sessions with only empty timestamps sort oldest. Ties on
//      recency are broken by sessionId, then first original index.
//   3. Walk sessions most-recent-first, greedily filling the budget:
//        - If the WHOLE session fits the remaining budget, keep it whole
//          (completeness preference).
//        - If it does not fully fit, apply intra-session budget pressure:
//          evict that session's LOWEST-signal-density turns first (drop lowest
//          density until the remaining turns fit). Density ties are broken by
//          original index (keep earlier-arriving turns).
//          Kept turns are emitted in chronological (timestamp) order, with
//          original index as a stable tie-break.
//        - After a partial eviction the budget is usually exhausted, but the
//          walk continues while `remaining > 0`: any leftover slack flows to
//          strictly-older sessions (which may be kept whole or partially), so
//          newer sessions are always served first.
//   4. Output is concatenated session-by-session in keep-priority (recency)
//      order, ready for `assembleRawNarrativeProjection` (which re-applies a
//      hard cap as a safety net).
//
// Density is only used to decide WHICH turns survive intra-session pressure; it
// never overrides completeness or recency. Density does NOT mutate text — T3
// owns actual secret egress dropping.

import {
  defaultTokenCounter,
  type NarrativeTurn,
  type TokenCounter
} from "./raw-narrative-projection.js";
import { detectSecrets } from "./credential-detector.js";

// --- Documented, tunable density weights -----------------------------------

// Weight applied to the length proxy (tokenEstimate). Kept at 1 so a turn's
// baseline density tracks its information volume one-for-one; the two boolean
// boosts below are expressed relative to roughly one token of length each.
export const DENSITY_WEIGHT_LENGTH = 1;

// Boost for turns carrying a code/tool marker. Concrete diffs, commands, and
// tool calls are the highest-signal narrative material, so they should survive
// intra-session eviction ahead of equal-length prose.
export const DENSITY_WEIGHT_CODE_OR_TOOL = 50;

// Boost for turns whose text trips the secret detector. Such turns describe
// real credential/config work (high narrative signal even though the secret
// itself is redacted later), so we bias toward keeping them rather than
// silently dropping the context. (Text is NOT mutated here.)
export const DENSITY_WEIGHT_SECRET_TRIGGER = 25;

/**
 * Lightweight presence check for a redaction/secret-trigger marker in text.
 * Uses the shared detector so density agrees with the egress policy.
 */
export function hasSecretTriggerMarker(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  return detectSecrets(text).categories.length > 0;
}

/**
 * Weighted-sum signal density for a single turn:
 *   length-proxy + (code/tool boost) + (secret-trigger boost)
 */
export function signalDensity(
  turn: NarrativeTurn,
  tokenCounter: TokenCounter = defaultTokenCounter
): number {
  const lengthProxy = tokenCounter.estimate(turn.text);
  return (
    DENSITY_WEIGHT_LENGTH * lengthProxy +
    (turn.hasCodeOrToolMarker ? DENSITY_WEIGHT_CODE_OR_TOOL : 0) +
    (hasSecretTriggerMarker(turn.text) ? DENSITY_WEIGHT_SECRET_TRIGGER : 0)
  );
}

type IndexedTurn = {
  turn: NarrativeTurn;
  originalIndex: number;
  tokens: number;
  density: number;
};

type SessionGroup = {
  sessionId: string;
  turns: IndexedTurn[]; // sorted chronologically (timestamp, then index)
  recency: string; // newest timestamp in the session; "" => oldest
  firstIndex: number; // first original index, for stable tie-breaks
};

/**
 * Deterministic chronological order within a session: by timestamp, then by
 * original index for stable ties. Empty timestamps sort earliest (oldest).
 */
function chronological(a: IndexedTurn, b: IndexedTurn): number {
  const ta = a.turn.timestamp;
  const tb = b.turn.timestamp;
  if (ta !== tb) {
    return ta < tb ? -1 : 1;
  }
  return a.originalIndex - b.originalIndex;
}

/**
 * Select an ordered subset of turns that fits `budget`, in keep-priority
 * (recency) order, applying the fixed completeness > recency > density policy.
 */
export function selectTurns(
  turns: NarrativeTurn[],
  options: { budget: number; tokenCounter?: TokenCounter }
): NarrativeTurn[] {
  const { budget } = options;
  const tokenCounter = options.tokenCounter ?? defaultTokenCounter;

  if (turns.length === 0 || budget <= 0) {
    return [];
  }

  // 1. Index + score every turn.
  const indexed: IndexedTurn[] = turns.map((turn, originalIndex) => ({
    turn,
    originalIndex,
    tokens: tokenCounter.estimate(turn.text),
    density: signalDensity(turn, tokenCounter)
  }));

  // 2. Group by sessionId, preserving input order within each group.
  const groups = new Map<string, SessionGroup>();
  for (const item of indexed) {
    const id = item.turn.sessionId;
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        sessionId: id,
        turns: [],
        recency: item.turn.timestamp,
        firstIndex: item.originalIndex
      };
      groups.set(id, group);
    }
    group.turns.push(item);
    // recency = newest (max) timestamp; empty timestamps never raise it.
    if (item.turn.timestamp > group.recency) {
      group.recency = item.turn.timestamp;
    }
  }

  // Sort each session's turns chronologically for deterministic emission
  // independent of input arrival order.
  for (const group of groups.values()) {
    group.turns.sort(chronological);
  }

  // 3. Order sessions most-recent-first. Empty recency sorts oldest. Ties:
  //    sessionId, then firstIndex — all stable + deterministic.
  const orderedSessions = [...groups.values()].sort((a, b) => {
    if (a.recency !== b.recency) {
      // Empty string is lexicographically smallest -> treat as oldest (last).
      return a.recency < b.recency ? 1 : -1;
    }
    if (a.sessionId !== b.sessionId) {
      return a.sessionId < b.sessionId ? -1 : 1;
    }
    return a.firstIndex - b.firstIndex;
  });

  // 4. Two-phase fill honoring completeness > recency.
  //
  //   Phase 1: walk sessions most-recent-first and keep every session that fits
  //            WHOLE in the remaining budget. A session that does not fit whole
  //            is skipped here; the FIRST (most-recent) such session is the sole
  //            candidate for a partial fill, all older non-fitting sessions are
  //            dropped.
  //   Phase 2: partial-fill that candidate into any leftover slack.
  //
  // Doing whole-session keeps first means a budget that cannot fit the newest
  // session but CAN fit an older session completely emits the complete older
  // session instead of a fragment of the newer one — the documented
  // completeness-outranks-recency rule (UNC-156 review).
  const keptBySession = new Map<string, NarrativeTurn[]>();
  let remaining = budget;
  let partialCandidate: SessionGroup | undefined;

  for (const session of orderedSessions) {
    const sessionTokens = session.turns.reduce((sum, t) => sum + t.tokens, 0);
    if (sessionTokens <= remaining) {
      keptBySession.set(
        session.sessionId,
        session.turns.map((item) => item.turn)
      );
      remaining -= sessionTokens;
      continue;
    }
    if (partialCandidate === undefined) {
      partialCandidate = session;
    }
  }

  if (partialCandidate !== undefined && remaining > 0) {
    const survivors = evictToFit(partialCandidate, remaining);
    if (survivors.length > 0) {
      keptBySession.set(partialCandidate.sessionId, survivors);
    }
  }

  // 5. Emit in keep-priority (recency) order.
  const result: NarrativeTurn[] = [];
  for (const session of orderedSessions) {
    const kept = keptBySession.get(session.sessionId);
    if (kept !== undefined) {
      result.push(...kept);
    }
  }

  return result;
}

/**
 * Intra-session budget pressure: evict a session's lowest-density turns first
 * until the rest fit `remaining`. Eviction order is ascending density; ties
 * broken by LATER original index (drop later turns, keep earlier ones).
 * Survivors are returned in chronological (original input) order.
 */
function evictToFit(
  session: SessionGroup,
  remaining: number
): NarrativeTurn[] {
  const evictionOrder = [...session.turns].sort((a, b) => {
    if (a.density !== b.density) {
      return a.density - b.density; // lowest density first to drop
    }
    return b.originalIndex - a.originalIndex; // drop later turns on ties
  });

  const dropped = new Set<number>();
  let kept = session.turns.reduce((sum, t) => sum + t.tokens, 0);
  for (const item of evictionOrder) {
    if (kept <= remaining) {
      break;
    }
    dropped.add(item.originalIndex);
    kept -= item.tokens;
  }

  const survivors: NarrativeTurn[] = [];
  for (const item of session.turns) {
    if (!dropped.has(item.originalIndex)) {
      survivors.push(item.turn);
    }
  }
  return survivors;
}
