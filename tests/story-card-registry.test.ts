import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../src/activity-summary.js";
import { escapeHtml } from "../src/html-escape.js";
import {
  getStoryCardSlotSchemas,
  listStoryCardCandidates,
  listStoryCardKindIds,
  storyCardRegistry,
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

function createSummary(): ActivitySummary {
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
    uncertaintyNotes: []
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
