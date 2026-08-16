import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import { validateStoryCardPlanEntries } from "../src/story-card-plan.js";
import { storyCardRegistry } from "../src/story-card-registry.js";
import { readSlotLines, readSlotText } from "../src/story-card-slots.js";

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

const busySummary = createSummary({
  activityLevel: "high",
  dominantTheme: "coding",
  commitSignals: {
    totalCommits: 5,
    filesChanged: 12,
    insertions: 200,
    deletions: 40,
    subjects: ["카드 슬롯 검증 추가", "재시도 루프 배선"],
    themes: []
  },
  smallWins: ["테스트 다 통과", "린트 정리"],
  unfinishedThreads: ["렌더 경로 배선 남음"],
  blockersOrConfusion: ["스키마 하나가 애매함"],
  possibleJokes: ["오늘도 TODO는 늘었다"],
  manualContext: { noteCount: 2, notes: [] }
});

describe("story card default slots", () => {
  it("gives every registered kind a default slot builder", () => {
    for (const kind of storyCardRegistry) {
      expect(typeof kind.buildDefaultSlots, kind.id).toBe("function");
    }
  });

  for (const summaryName of ["quiet", "busy"] as const) {
    it(`produces defaults that satisfy their own constraints on a ${summaryName} day`, () => {
      const summary = summaryName === "quiet" ? createSummary() : busySummary;

      for (const kind of storyCardRegistry) {
        const slots = kind.buildDefaultSlots({ summary });
        const wireSlots = Object.entries(slots).map(([name, value]) => ({
          name,
          lines: Array.isArray(value) ? value : [value]
        }));
        const outcomes = validateStoryCardPlanEntries(
          [{ type: kind.id, slots: wireSlots }],
          [{ id: kind.id, slots: kind.slots }]
        );

        expect(
          outcomes[0].status,
          `${kind.id} default slots on a ${summaryName} day: ${JSON.stringify(
            outcomes[0]
          )}`
        ).toBe("accepted");
      }
    });
  }

  it("fills every required slot with non-empty content even on a quiet day", () => {
    const summary = createSummary();

    for (const kind of storyCardRegistry) {
      const slots = kind.buildDefaultSlots({ summary });

      for (const [slotName, spec] of Object.entries(kind.slots)) {
        if (!spec.required) continue;

        const filled =
          spec.type === "lines"
            ? readSlotLines(slots, slotName).length > 0
            : readSlotText(slots, slotName).trim().length > 0;

        expect(filled, `${kind.id}.${slotName}`).toBe(true);
      }
    }
  });

  it("is deterministic — the same summary yields the same slots", () => {
    for (const kind of storyCardRegistry) {
      const first = kind.buildDefaultSlots({ summary: busySummary });
      const second = kind.buildDefaultSlots({ summary: busySummary });

      expect(second).toEqual(first);
    }
  });

  it("prefers already-derived material over the fixed quiet-day copy when it exists", () => {
    const checkboard = storyCardRegistry.find((kind) => kind.id === "checkboard");

    expect(checkboard).toBeDefined();
    if (!checkboard) return;

    const slots = checkboard.buildDefaultSlots({ summary: busySummary });

    expect(readSlotLines(slots, "done").join(" ")).toContain("테스트");
  });

  // UNC-263 T5 리뷰 반영: `??`나 `list.length > 0 ? list : fixed` 형태의
  // 선택 로직은 공백뿐인 문자열을 "값 있음"으로 오판해 승인된 고정 문구를
  // 밀어낸다. 그 결과 필수 슬롯이 빈 문자열/빈 배열로 끝나 자기 검증에
  // 실패할 수 있다 — degrade 경로 자체가 무력해지는 시나리오.
  const whitespaceOnlySummary = createSummary({
    activityLevel: "high",
    commitSignals: {
      totalCommits: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      subjects: ["   "],
      themes: []
    },
    smallWins: ["   "],
    unfinishedThreads: ["   "],
    blockersOrConfusion: ["   "],
    possibleJokes: ["   "],
    manualContext: { noteCount: 1, notes: [] }
  });

  it("still produces valid defaults when every candidate field is whitespace-only", () => {
    for (const kind of storyCardRegistry) {
      const slots = kind.buildDefaultSlots({ summary: whitespaceOnlySummary });
      const wireSlots = Object.entries(slots).map(([name, value]) => ({
        name,
        lines: Array.isArray(value) ? value : [value]
      }));
      const outcomes = validateStoryCardPlanEntries(
        [{ type: kind.id, slots: wireSlots }],
        [{ id: kind.id, slots: kind.slots }]
      );

      expect(
        outcomes[0].status,
        `${kind.id} default slots with whitespace-only material: ${JSON.stringify(
          outcomes[0]
        )}`
      ).toBe("accepted");
    }
  });
});
