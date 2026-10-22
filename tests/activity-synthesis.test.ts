import { describe, expect, it } from "vitest";
import { deriveSynthesisFromSignals } from "../src/activity-synthesis.js";
import type { ActivitySignal } from "../src/event-source.js";

function signal(overrides: Partial<ActivitySignal> = {}): ActivitySignal {
  return {
    projectId: "p1",
    timestamp: "2026-07-15T09:00:00.000Z",
    kind: "note",
    summary: "implement todo later failed",
    safetyNotes: [],
    ...overrides
  };
}

describe("deriveSynthesisFromSignals tool signals", () => {
  it("puts the same text from a note into wins, blockers and unfinished (control)", () => {
    const out = deriveSynthesisFromSignals([signal()]);
    expect(out.smallWins).toEqual(["implement todo later failed"]);
    expect(out.blockersOrConfusion).toEqual(["implement todo later failed"]);
    expect(out.unfinishedThreads).toEqual(["implement todo later failed"]);
  });

  it.each(["claude-tool", "codex-tool"])(
    "does not turn %s signals into wins, blockers or unfinished threads",
    (kind) => {
      const out = deriveSynthesisFromSignals([signal({ kind })]);
      expect(out.smallWins).toEqual([]);
      expect(out.blockersOrConfusion).toEqual([]);
      expect(out.unfinishedThreads).toEqual([]);
    }
  );

  it("still counts tool signals toward themes", () => {
    const out = deriveSynthesisFromSignals([
      signal({ kind: "claude-tool", summary: "refactor src/a.ts" })
    ]);
    expect(out.themes).toContain("refactoring");
  });
});
