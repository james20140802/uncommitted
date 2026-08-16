import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import {
  listStoryCardCandidateProjections,
  storyCardRegistry
} from "../src/story-card-registry.js";

function createSummary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-08-17",
    generatedAt: "2026-08-17T00:00:00.000Z",
    activityLevel: "none",
    dominantTheme: "quiet",
    projects: [],
    commitSignals: {
      totalCommits: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      subjects: [],
      themes: []
    },
    uncommittedChanges: {
      totalFiles: 0,
      byStatus: {
        modified: 0,
        added: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        untracked: 0,
        other: 0
      },
      files: []
    },
    manualContext: { noteCount: 0, notes: [] },
    smallWins: [],
    blockersOrConfusion: [],
    unfinishedThreads: [],
    possibleJokes: [],
    publicSafetyNotes: [],
    privateItemsToAvoid: [],
    uncertaintyNotes: [],
    ...overrides
  };
}

describe("story card slot limits", () => {
  it("declares a concrete maxLength on every slot of every registered kind", () => {
    for (const kind of storyCardRegistry) {
      for (const [slotName, spec] of Object.entries(kind.slots)) {
        expect(
          spec.maxLength,
          `${kind.id}.${slotName} must declare maxLength`
        ).toBeTypeOf("number");
        expect(spec.maxLength).toBeGreaterThan(0);
      }
    }
  });

  it("declares maxLines on every lines-typed slot", () => {
    for (const kind of storyCardRegistry) {
      for (const [slotName, spec] of Object.entries(kind.slots)) {
        if (spec.type !== "lines") continue;

        expect(
          spec.maxLines,
          `${kind.id}.${slotName} must declare maxLines`
        ).toBeTypeOf("number");
        expect(spec.maxLines).toBeGreaterThan(0);
      }
    }
  });

  it("carries the limits through the serializable candidate projection", () => {
    const busy = createSummary({
      activityLevel: "high",
      commitSignals: {
        totalCommits: 4,
        filesChanged: 9,
        insertions: 120,
        deletions: 30,
        subjects: ["fix things"],
        themes: []
      }
    });
    const projections = listStoryCardCandidateProjections(busy);
    const terminal = projections.find((candidate) => candidate.id === "terminal");

    expect(terminal).toBeDefined();
    expect(terminal?.slots.command.maxLength).toBeTypeOf("number");
    expect(terminal?.slots.output.maxLines).toBeTypeOf("number");
  });

  it("survives JSON round-tripping so the prompt sees the same limits", () => {
    const projections = listStoryCardCandidateProjections(createSummary());
    const roundTripped = JSON.parse(JSON.stringify(projections));

    expect(roundTripped).toEqual(projections);
    expect(roundTripped[0].slots.headline.maxLength).toBeTypeOf("number");
  });
});
