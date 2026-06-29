import { describe, expect, it } from "vitest";
import {
  DENSITY_WEIGHT_CODE_OR_TOOL,
  DENSITY_WEIGHT_LENGTH,
  DENSITY_WEIGHT_SECRET_TRIGGER,
  selectTurns,
  signalDensity
} from "../src/raw-narrative-selection.js";
import {
  defaultTokenCounter
} from "../src/raw-narrative-projection.js";
import type { NarrativeTurn } from "../src/raw-narrative-projection.js";

function turn(overrides: Partial<NarrativeTurn>): NarrativeTurn {
  return {
    source: "claude",
    text: "x",
    timestamp: "",
    sessionId: "s",
    hasCodeOrToolMarker: false,
    ...overrides
  };
}

// An obvious vendor secret (GitHub PAT: ghp_ + 36 chars) — fires the
// secret-trigger category in credential-detector's detectSecrets.
const SECRET_TEXT = "leaked ghp_" + "a".repeat(36) + " here";

describe("signalDensity", () => {
  it("scores longer text higher (length proxy = tokenEstimate)", () => {
    const short = turn({ text: "hi" });
    const long = turn({ text: "x".repeat(400) });
    expect(signalDensity(long)).toBeGreaterThan(signalDensity(short));
  });

  it("adds the code/tool weight when hasCodeOrToolMarker is set", () => {
    const plain = turn({ text: "same text body here", hasCodeOrToolMarker: false });
    const marked = turn({ text: "same text body here", hasCodeOrToolMarker: true });
    expect(signalDensity(marked) - signalDensity(plain)).toBeCloseTo(
      DENSITY_WEIGHT_CODE_OR_TOOL
    );
  });

  it("adds the secret-trigger weight when text contains an obvious secret", () => {
    const clean = turn({ text: "leaked nothing here at all today" });
    const leaked = turn({ text: SECRET_TEXT });
    // Isolate the secret contribution by matching token length closely is hard;
    // instead assert the secret turn includes the secret weight on top of its
    // own length + (no code marker).
    const cleanLen = DENSITY_WEIGHT_LENGTH * defaultTokenCounter.estimate(clean.text);
    const leakedLen = DENSITY_WEIGHT_LENGTH * defaultTokenCounter.estimate(leaked.text);
    expect(signalDensity(leaked) - leakedLen).toBeCloseTo(
      DENSITY_WEIGHT_SECRET_TRIGGER
    );
    expect(signalDensity(clean) - cleanLen).toBeCloseTo(0);
  });

  it("composes weights as a sum (length + code + secret)", () => {
    const t = turn({ text: SECRET_TEXT, hasCodeOrToolMarker: true });
    const expected =
      DENSITY_WEIGHT_LENGTH * defaultTokenCounter.estimate(t.text) +
      DENSITY_WEIGHT_CODE_OR_TOOL +
      DENSITY_WEIGHT_SECRET_TRIGGER;
    expect(signalDensity(t)).toBeCloseTo(expected);
  });
});

describe("selectTurns precedence", () => {
  it("keeps the more-recent session when budget forces a choice", () => {
    // Two whole sessions; budget fits only one.
    const older = turn({
      sessionId: "old",
      timestamp: "2026-01-01T00:00:00Z",
      text: "o".repeat(40) // ~10 tokens
    });
    const newer = turn({
      sessionId: "new",
      timestamp: "2026-06-01T00:00:00Z",
      text: "n".repeat(40) // ~10 tokens
    });
    const kept = selectTurns([older, newer], { budget: 10 });
    expect(kept.map((t) => t.sessionId)).toEqual(["new"]);
  });

  it("prefers a complete session over a partial older one", () => {
    // newest session has 2 turns (~5 tokens each = 10), older has 1 (~5).
    // budget 12 fits the whole newest session but not all three turns.
    const a1 = turn({ sessionId: "new", timestamp: "2026-06-01T00:00:01Z", text: "a".repeat(20) });
    const a2 = turn({ sessionId: "new", timestamp: "2026-06-01T00:00:02Z", text: "b".repeat(20) });
    const b1 = turn({ sessionId: "old", timestamp: "2026-01-01T00:00:00Z", text: "c".repeat(20) });
    const kept = selectTurns([b1, a1, a2], { budget: 12 });
    // Whole "new" session kept; "old" dropped because it wouldn't fit whole.
    expect(new Set(kept.map((t) => t.sessionId))).toEqual(new Set(["new"]));
    expect(kept).toHaveLength(2);
  });

  it("backfills an older session into slack left after a partial eviction", () => {
    // Newest session: two 7-token turns (28 chars each) = 14 tokens, over the
    // budget of 10, so it cannot be kept whole. Phase 1 keeps the older
    // session's single 2-token turn whole (recency order, fits the budget),
    // leaving 8 tokens; phase 2 partial-fills the newest session into that
    // slack — its lowest-density turn is evicted, so the code-marked turn
    // (higher density) survives at 7 tokens. Result: newest fragment + whole
    // older session.
    const newKept = turn({
      sessionId: "new",
      timestamp: "2026-06-01T00:00:02Z",
      text: "n".repeat(28),
      hasCodeOrToolMarker: true
    });
    const newEvicted = turn({
      sessionId: "new",
      timestamp: "2026-06-01T00:00:01Z",
      text: "m".repeat(28),
      hasCodeOrToolMarker: false
    });
    const oldSmall = turn({
      sessionId: "old",
      timestamp: "2026-01-01T00:00:00Z",
      text: "o".repeat(8) // ~2 tokens
    });
    const kept = selectTurns([oldSmall, newEvicted, newKept], { budget: 10 });
    expect(kept.map((t) => t.sessionId)).toEqual(["new", "old"]);
    expect(kept.map((t) => t.text)).toEqual([newKept.text, oldSmall.text]);
    const total = kept.reduce(
      (sum, t) => sum + defaultTokenCounter.estimate(t.text),
      0
    );
    expect(total).toBeLessThanOrEqual(10);
  });

  it("prefers a whole older session over a fragment of the newest one", () => {
    // Newest session is one 14-token turn that cannot fit the budget of 10.
    // An older session is one 10-token turn that fits whole. Completeness
    // outranks recency, so the whole older session must win over a (here
    // impossible anyway) fragment of the newer one — and crucially the newer
    // session must NOT be partial-filled ahead of the fitting older session.
    const newerOversized = turn({
      sessionId: "new",
      timestamp: "2026-06-01T00:00:00Z",
      text: "n".repeat(56) // 14 tokens, > budget
    });
    const olderWhole = turn({
      sessionId: "old",
      timestamp: "2026-01-01T00:00:00Z",
      text: "o".repeat(40) // 10 tokens, == budget
    });
    const kept = selectTurns([newerOversized, olderWhole], { budget: 10 });
    expect(kept.map((t) => t.sessionId)).toEqual(["old"]);
    expect(kept.map((t) => t.text)).toEqual([olderWhole.text]);
  });

  it("lets recency beat raw density when they conflict", () => {
    // Older session has a very high-density turn; newer session is plain.
    // Budget fits only one whole session -> recency wins.
    const olderDense = turn({
      sessionId: "old",
      timestamp: "2026-01-01T00:00:00Z",
      text: SECRET_TEXT,
      hasCodeOrToolMarker: true
    });
    const newerPlain = turn({
      sessionId: "new",
      timestamp: "2026-06-01T00:00:00Z",
      text: "n".repeat(40)
    });
    const budget = defaultTokenCounter.estimate(newerPlain.text);
    const kept = selectTurns([olderDense, newerPlain], { budget });
    expect(kept.map((t) => t.sessionId)).toEqual(["new"]);
  });
});

describe("selectTurns intra-session eviction", () => {
  it("drops the lowest-density turns first when a session overflows", () => {
    // One session, three turns of equal length; one carries a secret + code
    // marker (highest density), one carries a code marker (mid), one plain.
    const plain = turn({
      sessionId: "s",
      timestamp: "2026-06-01T00:00:01Z",
      text: "p".repeat(40),
      hasCodeOrToolMarker: false
    });
    const mid = turn({
      sessionId: "s",
      timestamp: "2026-06-01T00:00:02Z",
      text: "m".repeat(40),
      hasCodeOrToolMarker: true
    });
    const high = turn({
      sessionId: "s",
      timestamp: "2026-06-01T00:00:03Z",
      text: "h".repeat(34) + " ghp_" + "a".repeat(36),
      hasCodeOrToolMarker: true
    });
    // plain=10 tok (density 10), mid=10 tok (density 60),
    // high=19 tok (density 94). Budget fits mid+high (29) but not plain too.
    const budget =
      defaultTokenCounter.estimate(mid.text) +
      defaultTokenCounter.estimate(high.text);
    const kept = selectTurns([plain, mid, high], { budget });
    const keptTexts = new Set(kept.map((t) => t.text));
    expect(keptTexts.has(plain.text)).toBe(false); // lowest density evicted
    expect(keptTexts.has(high.text)).toBe(true);
    expect(keptTexts.has(mid.text)).toBe(true);
  });

  it("keeps within-session output in chronological order", () => {
    const t1 = turn({ sessionId: "s", timestamp: "2026-06-01T00:00:01Z", text: "1".repeat(20) });
    const t2 = turn({ sessionId: "s", timestamp: "2026-06-01T00:00:02Z", text: "2".repeat(20) });
    const t3 = turn({ sessionId: "s", timestamp: "2026-06-01T00:00:03Z", text: "3".repeat(20) });
    const kept = selectTurns([t3, t1, t2], { budget: 1000 });
    expect(kept.map((t) => t.text)).toEqual([t1.text, t2.text, t3.text]);
  });
});

describe("selectTurns budget", () => {
  it("keeps total tokens within budget", () => {
    const turns: NarrativeTurn[] = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push(
        turn({
          sessionId: `s${i % 3}`,
          timestamp: `2026-06-01T00:00:0${i}Z`,
          text: "z".repeat(40 + i)
        })
      );
    }
    const budget = 30;
    const kept = selectTurns(turns, { budget });
    const total = kept.reduce(
      (sum, t) => sum + defaultTokenCounter.estimate(t.text),
      0
    );
    expect(total).toBeLessThanOrEqual(budget);
  });

  it("returns empty for non-positive budget", () => {
    const t = turn({ text: "hello", sessionId: "s", timestamp: "2026-06-01T00:00:00Z" });
    expect(selectTurns([t], { budget: 0 })).toEqual([]);
  });
});

describe("selectTurns determinism", () => {
  it("produces identical output for shuffled input", () => {
    const base: NarrativeTurn[] = [
      turn({ sessionId: "a", timestamp: "2026-06-01T00:00:01Z", text: "aaa".repeat(10) }),
      turn({ sessionId: "a", timestamp: "2026-06-01T00:00:02Z", text: "bbb".repeat(10) }),
      turn({ sessionId: "b", timestamp: "2026-05-01T00:00:01Z", text: "ccc".repeat(10) }),
      turn({ sessionId: "c", timestamp: "", text: "ddd".repeat(10) })
    ];
    const order1 = selectTurns(base, { budget: 40 });
    const shuffled = [base[3], base[1], base[0], base[2]];
    const order2 = selectTurns(shuffled, { budget: 40 });
    expect(order2.map((t) => t.text)).toEqual(order1.map((t) => t.text));
    // Repeated call is stable too.
    const order3 = selectTurns(base, { budget: 40 });
    expect(order3.map((t) => t.text)).toEqual(order1.map((t) => t.text));
  });
});
