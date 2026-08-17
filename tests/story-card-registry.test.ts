import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import { escapeHtml } from "../src/html-escape.js";
import {
  getStoryCardSlotSchemas,
  listStoryCardCandidateProjections,
  listStoryCardCandidates,
  listStoryCardKindIds,
  storyCardRegistry,
  type StoryCardCandidate,
  type StoryCardDefinition
} from "../src/story-card-registry.js";
import { renderStoryCardDocument } from "../src/story-card-chrome.js";

describe("escapeHtml", () => {
  it("escapes every character the carousel renderer relied on", () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;"
    );
  });
});

const chrome = {
  projectMarker: "uncommitted",
  targetDate: "2026-08-02",
  pageNumber: 2,
  pageCount: 6
};

describe("story card chrome", () => {
  it("wraps kind markup in the shared card shell", () => {
    const html = renderStoryCardDocument({
      kindId: "demo",
      title: "제목",
      stageHtml: `<p class="demo">본문</p>`,
      stageStyles: ".demo { color: red; }",
      chrome
    });

    expect(html).toContain(`data-story-card-kind="demo"`);
    expect(html).toContain("uncommitted");
    expect(html).toContain("2026-08-02");
    expect(html).toContain("Uncommitted");
    expect(html).toContain("2 / 6");
    expect(html).toContain(`<p class="demo">본문</p>`);
    expect(html).toContain(".demo { color: red; }");
  });

  it("keeps the data-layout-fit contract that applyLayoutFit rewrites", () => {
    const html = renderStoryCardDocument({
      kindId: "demo",
      title: "제목",
      stageHtml: "<p>x</p>",
      stageStyles: "",
      chrome
    });

    expect(html).toMatch(/<article\b[^>]*\sdata-layout-fit="base"/);
    expect(html).toContain(`.card[data-layout-fit="tight"]`);
    expect(html).toContain(`.card[data-layout-fit="compact"]`);
  });

  it("escapes chrome values", () => {
    const html = renderStoryCardDocument({
      kindId: "demo",
      title: "제목",
      stageHtml: "<p>x</p>",
      stageStyles: "",
      chrome: { ...chrome, projectMarker: `<img src=x onerror="alert(1)">` }
    });

    expect(html).not.toContain(`<img src=x`);
    expect(html).toContain("&lt;img src=x");
  });
});

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

describe("story card registry contract", () => {
  it("gives every registered kind the full id/requires/slots/render shape", () => {
    expect(storyCardRegistry.length).toBeGreaterThan(0);

    for (const kind of storyCardRegistry) {
      expect(typeof kind.id).toBe("string");
      expect(kind.id.length).toBeGreaterThan(0);
      expect(typeof kind.requires).toBe("function");
      expect(typeof kind.render).toBe("function");
      expect(Object.keys(kind.slots).length).toBeGreaterThan(0);
    }
  });

  it("registers typo", () => {
    expect(listStoryCardKindIds()).toContain("typo");
  });
});

describe("story card registry extensibility (parent AC2)", () => {
  const dummy: StoryCardDefinition = {
    id: "dummy-seventh",
    requires: () => true,
    slots: { headline: { type: "text", required: true } },
    buildDefaultSlots: () => ({ headline: "dummy" }),
    render: (slots, chrome) =>
      renderStoryCardDocument({
        kindId: "dummy-seventh",
        title: "dummy",
        stageHtml: `<p>${escapeHtml(String(slots.headline ?? ""))}</p>`,
        stageStyles: "",
        chrome
      })
  };

  const extended = [...storyCardRegistry, dummy];

  it("propagates a new kind into the id enumeration with no other code change", () => {
    expect(listStoryCardKindIds(extended)).toContain("dummy-seventh");
  });

  it("propagates a new kind into the slot schema map", () => {
    expect(getStoryCardSlotSchemas(extended)["dummy-seventh"]).toEqual({
      headline: { type: "text", required: true }
    });
  });

  it("propagates a new kind into the candidate list", () => {
    const ids = listStoryCardCandidates(createSummary(), extended).map(
      (kind) => kind.id
    );
    expect(ids).toContain("dummy-seventh");
  });

  it("filters candidates by each kind's own requires()", () => {
    const never: StoryCardDefinition = { ...dummy, id: "never", requires: () => false };
    const ids = listStoryCardCandidates(createSummary(), [never]).map((k) => k.id);
    expect(ids).toEqual([]);
  });
});

describe("story card slot injection regression (parent AC4)", () => {
  const hostile = `<script>alert("pwned")</script>`;

  it("never emits an executable script tag from any registered kind", () => {
    for (const kind of storyCardRegistry) {
      const slots: Record<string, string | string[]> = {};
      for (const [name, spec] of Object.entries(kind.slots)) {
        slots[name] = spec.type === "lines" ? [hostile] : hostile;
      }

      const html = kind.render(slots, chrome);

      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;alert(&quot;pwned&quot;)");
    }
  });
});

describe("story card registry completeness (parent AC1)", () => {
  it("registers all six card kinds", () => {
    expect(listStoryCardKindIds().sort()).toEqual(
      ["chat", "checkboard", "diff", "modal", "terminal", "typo"].sort()
    );
  });
});

describe("typo card (parent AC3)", () => {
  it("renders representative slot values escaped into the output", () => {
    const typo = storyCardRegistry.find((kind) => kind.id === "typo");
    if (!typo) throw new Error("typo kind not registered");

    const html = typo.render(
      { headline: "커밋 0건 & 평온", kicker: "조용한 날" },
      chrome
    );

    expect(html).toContain("커밋 0건 &amp; 평온");
    expect(html).toContain("조용한 날");
    expect(html).toContain(`data-story-card-kind="typo"`);
  });
});

type MaterialCase = {
  readonly kindId: string;
  readonly present: Partial<ActivitySummary>;
  readonly absent: Partial<ActivitySummary>;
};

// typo는 requires가 무조건 true 라 "재료 없음"이 설계상 없다 — 아래 별도 테스트에서 다룬다.
const materialCases: readonly MaterialCase[] = [
  {
    kindId: "terminal",
    present: {
      commitSignals: {
        totalCommits: 3,
        filesChanged: 4,
        insertions: 40,
        deletions: 2,
        subjects: ["fix: 로그인"],
        themes: []
      }
    },
    absent: {}
  },
  {
    kindId: "diff",
    present: {
      commitSignals: {
        totalCommits: 1,
        filesChanged: 2,
        insertions: 10,
        deletions: 1,
        subjects: ["chore: 정리"],
        themes: []
      }
    },
    absent: {}
  },
  {
    kindId: "chat",
    present: { manualContext: { noteCount: 2, notes: [] } },
    absent: {}
  },
  {
    kindId: "checkboard",
    present: { smallWins: ["테스트 통과"] },
    absent: {}
  },
  {
    kindId: "modal",
    // 조용한 날 or 조건 때문에 modal의 유일한 탈락 경로는 "바쁜데 blocker·미완 스레드 없음"이다.
    present: { activityLevel: "high", blockersOrConfusion: ["CI가 계속 죽음"] },
    absent: { activityLevel: "high" }
  }
];

describe("candidate filter material check (UNC-232 AC2)", () => {
  for (const testCase of materialCases) {
    it(`includes ${testCase.kindId} when its material is present`, () => {
      const ids = listStoryCardCandidates(createSummary(testCase.present)).map(
        (kind) => kind.id
      );
      expect(ids).toContain(testCase.kindId);
    });

    it(`excludes ${testCase.kindId} when its material is absent`, () => {
      const ids = listStoryCardCandidates(createSummary(testCase.absent)).map(
        (kind) => kind.id
      );
      expect(ids).not.toContain(testCase.kindId);
    });
  }

  it("covers every registered kind except typo, which has no material condition by design", () => {
    const covered = new Set(materialCases.map((testCase) => testCase.kindId));
    const uncovered = listStoryCardKindIds().filter((id) => !covered.has(id));
    expect(uncovered).toEqual(["typo"]);
  });

  it("keeps typo a candidate no matter what the summary holds", () => {
    const quiet = listStoryCardCandidates(createSummary()).map((kind) => kind.id);
    const busy = listStoryCardCandidates(
      createSummary({
        activityLevel: "high",
        commitSignals: {
          totalCommits: 9,
          filesChanged: 20,
          insertions: 300,
          deletions: 80,
          subjects: ["feat: 대공사"],
          themes: []
        }
      })
    ).map((kind) => kind.id);

    expect(quiet).toContain("typo");
    expect(busy).toContain("typo");
  });
});

describe("candidate filter on a completely quiet day (UNC-232 AC3)", () => {
  it("never returns an empty candidate list when activityLevel is none", () => {
    const candidates = listStoryCardCandidates(createSummary({ activityLevel: "none" }));

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((kind) => kind.id)).toContain("typo");
  });

  it("keeps modal available on the quiet day so the sparse day has more than one option", () => {
    const ids = listStoryCardCandidates(createSummary({ activityLevel: "none" })).map(
      (kind) => kind.id
    );

    expect(ids).toContain("modal");
  });
});

describe("candidate filter determinism (UNC-232 AC4)", () => {
  it("returns the same kind ids in the same order for the same summary", () => {
    const summary = createSummary({
      activityLevel: "medium",
      smallWins: ["플레이키 테스트 잡음"],
      manualContext: { noteCount: 1, notes: [] },
      commitSignals: {
        totalCommits: 2,
        filesChanged: 5,
        insertions: 60,
        deletions: 12,
        subjects: ["fix: 경합"],
        themes: []
      }
    });

    const first = listStoryCardCandidates(summary).map((kind) => kind.id);
    const second = listStoryCardCandidates(summary).map((kind) => kind.id);

    expect(second).toEqual(first);
  });

  it("returns the same kind ids for two structurally equal summaries", () => {
    const overrides = { activityLevel: "low" } as const;

    const first = listStoryCardCandidates(createSummary(overrides)).map((kind) => kind.id);
    const second = listStoryCardCandidates(createSummary(overrides)).map((kind) => kind.id);

    expect(second).toEqual(first);
  });

  it("does not mutate the summary it was given", () => {
    const summary = createSummary({ activityLevel: "medium", smallWins: ["작은 승리"] });
    const before = JSON.stringify(summary);

    listStoryCardCandidates(summary);

    expect(JSON.stringify(summary)).toBe(before);
  });
});

describe("candidate filter purity (UNC-232 AC1)", () => {
  // 카드 종류가 늘어날 때마다 이 목록을 손으로 갱신하면 언젠가 빠뜨린다 —
  // src/story-card-* 글롭으로 대상을 도출해 "새 종류 추가 시 다른 코드는
  // 안 바뀐다"는 레지스트리의 계약을 이 테스트도 그대로 따르게 한다.
  // story-card-generator.ts(UNC-261 / T3)는 이 계약의 예외다 — 후보 목록을
  // 프로바이더 프롬프트로 옮기는 provider-facing 절반으로 설계됐고,
  // ai-provider 결합이 그 파일의 존재 이유다. 순수해야 하는 건 카드 종류
  // 정의·검증·레지스트리 쪽이지 이 글롭 전체가 아니므로 이름으로 제외한다.
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const cardSourceFiles = readdirSync(srcDir).filter(
    (name) => name.startsWith("story-card-") && name !== "story-card-generator.ts"
  );

  for (const fileName of cardSourceFiles) {
    it(`keeps ${fileName} free of any ai-provider import`, () => {
      const path = fileURLToPath(new URL(`../src/${fileName}`, import.meta.url));
      const source = readFileSync(path, "utf8");

      expect(source).not.toMatch(/from\s+["'][^"']*ai-provider/);
    });
  }

  it("keeps requires() referentially transparent across repeated calls", () => {
    // requires()가 순수함을 행동으로 확인한다 — 같은 입력, 같은 출력.
    const summary = createSummary({ activityLevel: "low" });

    for (const kind of storyCardRegistry) {
      expect(kind.requires(summary)).toBe(kind.requires(summary));
    }
  });
});

describe("candidate projection for prompt and validation handoff", () => {
  it("projects each candidate down to its id and slot schema", () => {
    const projections = listStoryCardCandidateProjections(
      createSummary({ activityLevel: "none" })
    );

    expect(projections.length).toBeGreaterThan(0);

    for (const projection of projections) {
      expect(Object.keys(projection).sort()).toEqual(["id", "slots"]);
      expect(typeof projection.id).toBe("string");
      expect(Object.keys(projection.slots).length).toBeGreaterThan(0);
    }
  });

  it("survives a JSON round trip unchanged", () => {
    const projections = listStoryCardCandidateProjections(
      createSummary({ activityLevel: "none" })
    );
    const roundTripped = JSON.parse(JSON.stringify(projections)) as StoryCardCandidate[];

    expect(roundTripped).toEqual(projections);
  });

  it("carries no render closure that JSON.stringify would silently drop", () => {
    const projections = listStoryCardCandidateProjections(
      createSummary({ activityLevel: "none" })
    );

    for (const projection of projections) {
      expect("render" in projection).toBe(false);
      expect("requires" in projection).toBe(false);
    }
  });

  it("stays aligned with the candidate list it projects", () => {
    const summary = createSummary({
      activityLevel: "medium",
      smallWins: ["플레이키 테스트 잡음"],
      commitSignals: {
        totalCommits: 2,
        filesChanged: 5,
        insertions: 60,
        deletions: 12,
        subjects: ["fix: 경합"],
        themes: []
      }
    });

    const candidateIds = listStoryCardCandidates(summary).map((kind) => kind.id);
    const projectedIds = listStoryCardCandidateProjections(summary).map(
      (projection) => projection.id
    );

    expect(projectedIds).toEqual(candidateIds);
  });

  it("reflects a newly registered kind with no change to the projection function", () => {
    const dummy: StoryCardDefinition = {
      id: "dummy-projected",
      requires: () => true,
      slots: { headline: { type: "text", required: true } },
      buildDefaultSlots: () => ({ headline: "dummy" }),
      render: () => "<article></article>"
    };

    const projections = listStoryCardCandidateProjections(createSummary(), [
      ...storyCardRegistry,
      dummy
    ]);

    expect(projections).toContainEqual({
      id: "dummy-projected",
      slots: { headline: { type: "text", required: true } }
    });
  });
});
