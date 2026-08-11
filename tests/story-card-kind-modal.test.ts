import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import { modalStoryCard } from "../src/story-card-kind-modal.js";
import { storyCardRegistry } from "../src/story-card-registry.js";

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 3,
  pageCount: 6
};

function createSummary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    schemaVersion: 1,
    targetDate: "2026-08-02",
    generatedAt: "2026-08-02T00:00:00.000Z",
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

describe("modal story card", () => {
  it("is registered in the shared registry", () => {
    expect(storyCardRegistry.map((kind) => kind.id)).toContain("modal");
  });

  it("declares the full registry contract", () => {
    expect(modalStoryCard.id).toBe("modal");
    expect(typeof modalStoryCard.requires).toBe("function");
    expect(typeof modalStoryCard.render).toBe("function");
    expect(Object.keys(modalStoryCard.slots)).toContain("primaryAction");
  });

  it("renders representative slot values escaped into the output", () => {
    const html = modalStoryCard.render(
      {
        title: "변경사항을 버릴까요?",
        body: "커밋 안 한 파일 <3개>가 사라집니다 & 되돌릴 수 없습니다",
        primaryAction: "버리기",
        secondaryAction: "취소"
      },
      chrome
    );

    expect(html).toContain("변경사항을 버릴까요?");
    expect(html).toContain("커밋 안 한 파일 &lt;3개&gt;가 사라집니다 &amp;");
    expect(html).toContain("버리기");
    expect(html).toContain("취소");
    expect(html).toContain(`data-story-card-kind="modal"`);
    expect(html).toMatch(/<article\b[^>]*\sdata-layout-fit="base"/);
  });

  it("renders without the optional secondary action", () => {
    const html = modalStoryCard.render(
      { title: "확인", body: "본문", primaryAction: "확인" },
      chrome
    );

    expect(html).toContain("확인");
  });
});

describe("modal card material check", () => {
  it("stays a candidate on a fully quiet day so the sparse day still has a card", () => {
    expect(modalStoryCard.requires(createSummary({ activityLevel: "none" }))).toBe(true);
  });

  it("stays a candidate on a low-activity day", () => {
    expect(modalStoryCard.requires(createSummary({ activityLevel: "low" }))).toBe(true);
  });

  it("stays a candidate on a busy day that has blockers", () => {
    expect(
      modalStoryCard.requires(
        createSummary({ activityLevel: "high", blockersOrConfusion: ["빌드가 안 됨"] })
      )
    ).toBe(true);
  });

  it("stays a candidate on a busy day that has unfinished threads", () => {
    expect(
      modalStoryCard.requires(
        createSummary({ activityLevel: "medium", unfinishedThreads: ["리팩토링 중단"] })
      )
    ).toBe(true);
  });

  it("drops out on a busy day with neither blockers nor unfinished threads", () => {
    expect(
      modalStoryCard.requires(
        createSummary({
          activityLevel: "high",
          blockersOrConfusion: [],
          unfinishedThreads: []
        })
      )
    ).toBe(false);
  });
});
