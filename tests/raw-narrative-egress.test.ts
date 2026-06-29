import { describe, it, expect } from "vitest";
import { revalidateTurnsForEgress } from "../src/raw-narrative-egress.js";
import {
  defaultTokenCounter,
  type NarrativeTurn
} from "../src/raw-narrative-projection.js";

function turn(text: string, overrides: Partial<NarrativeTurn> = {}): NarrativeTurn {
  return {
    source: "claude",
    text,
    timestamp: "2026-06-29T00:00:00.000Z",
    sessionId: "s1",
    hasCodeOrToolMarker: false,
    ...overrides
  };
}

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_PAT = "ghp_" + "a".repeat(36);
const HIGH_ENTROPY = "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ1234";

describe("revalidateTurnsForEgress", () => {
  it("drops a turn containing an AWS access key", () => {
    const result = revalidateTurnsForEgress([turn(`creds: ${AWS_KEY} here`)]);
    expect(result.kept).toEqual([]);
    expect(result.droppedTurns).toBe(1);
  });

  it("drops a turn containing a GitHub PAT", () => {
    const result = revalidateTurnsForEgress([turn(`token ${GITHUB_PAT} leaked`)]);
    expect(result.kept).toEqual([]);
    expect(result.droppedTurns).toBe(1);
  });

  it("drops a turn containing a high-entropy 40-char token", () => {
    const result = revalidateTurnsForEgress([turn(`opaque ${HIGH_ENTROPY} value`)]);
    expect(result.kept).toEqual([]);
    expect(result.droppedTurns).toBe(1);
  });

  it("keeps a clean prose turn unchanged (same text)", () => {
    const clean = turn("Refactored the activity summary and fixed a flaky test.");
    const result = revalidateTurnsForEgress([clean]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toBe(clean);
    expect(result.kept[0].text).toBe(clean.text);
    expect(result.droppedTurns).toBe(0);
    expect(result.droppedTokens).toBe(0);
  });

  it("computes exact drop count, dropped token sum, and preserves kept order", () => {
    const cleanA = turn("Started the morning by reviewing yesterday's notes.");
    const dirty1 = turn(`AWS key ${AWS_KEY} in the config`);
    const cleanB = turn("Then I paired on the renderer with no drama.");
    const dirty2 = turn(`PAT ${GITHUB_PAT} pasted by mistake`);

    const result = revalidateTurnsForEgress([cleanA, dirty1, cleanB, dirty2]);

    expect(result.kept).toEqual([cleanA, cleanB]);
    expect(result.droppedTurns).toBe(2);
    const expectedDroppedTokens =
      defaultTokenCounter.estimate(dirty1.text) +
      defaultTokenCounter.estimate(dirty2.text);
    expect(result.droppedTokens).toBe(expectedDroppedTokens);
  });

  it("leak guard: no kept turn contains any planted secret substring", () => {
    const secrets = [AWS_KEY, GITHUB_PAT, HIGH_ENTROPY];
    const turns = [
      turn("A perfectly innocent line about coffee."),
      turn(`AWS ${AWS_KEY}`),
      turn("Another clean reflection on the day."),
      turn(`PAT ${GITHUB_PAT}`),
      turn(`entropy ${HIGH_ENTROPY}`),
      turn("Wrapping up with a quiet commit.")
    ];

    const result = revalidateTurnsForEgress(turns);

    for (const kept of result.kept) {
      for (const secret of secrets) {
        expect(kept.text).not.toContain(secret);
      }
    }
  });

  it("drops a raw-code/tool turn even when it trips no secret signature", () => {
    // Plain code with no credential pattern — the project rule forbids raw code
    // reaching AI providers, so the egress filter must drop it on the marker.
    const code = turn("function renderCard() { return draw(slides); }", {
      hasCodeOrToolMarker: true
    });
    const result = revalidateTurnsForEgress([code]);
    expect(result.kept).toEqual([]);
    expect(result.droppedTurns).toBe(1);
    expect(result.droppedTokens).toBe(defaultTokenCounter.estimate(code.text));
  });

  it("keeps clean prose but drops a marked code turn in the same batch", () => {
    const prose = turn("Spent the morning untangling the selection policy.");
    const code = turn("const budget = readBudget()", {
      hasCodeOrToolMarker: true
    });
    const result = revalidateTurnsForEgress([prose, code]);
    expect(result.kept).toEqual([prose]);
    expect(result.droppedTurns).toBe(1);
  });

  it("returns a zeroed result for empty input", () => {
    expect(revalidateTurnsForEgress([])).toEqual({
      kept: [],
      droppedTurns: 0,
      droppedTokens: 0
    });
  });

  it("uses a provided token counter for dropped token accounting", () => {
    const fixed = { estimate: () => 7 };
    const result = revalidateTurnsForEgress(
      [turn(`AWS ${AWS_KEY}`), turn(`PAT ${GITHUB_PAT}`)],
      fixed
    );
    expect(result.droppedTokens).toBe(14);
  });
});
