import { describe, expect, it } from "vitest";
import {
  buildActivitySummary,
  isActivitySummary,
  type ActivitySummaryInput
} from "../src/activity-summary.js";
import { deriveSynthesisFromSignals } from "../src/activity-summary.js";
import type { ActivitySignal } from "../src/event-source.js";

describe("activity summary", () => {
  it("summarizes an active Git day with safe project, commit, and dirty signals", () => {
    const input = createInput({
      gitEvents: [
        createGitEvent({
          projectId: "cli",
          projectName: "CLI",
          commits: [
            createCommit({
              subject: "implement collect git command",
              filesChanged: 4,
              insertions: 80,
              deletions: 10
            }),
            createCommit({
              subject: "fix flaky collector path handling",
              filesChanged: 2,
              insertions: 12,
              deletions: 5
            })
          ],
          dirtyFiles: [
            { path: "src/activity-summary.ts", status: "modified" },
            { path: "tests/activity-summary.test.ts", status: "untracked" }
          ]
        }),
        createGitEvent({
          targetDate: "2026-05-11",
          projectId: "old",
          projectName: "Old Work",
          commits: [
            createCommit({
              subject: "implement unrelated prior day feature",
              filesChanged: 10,
              insertions: 300,
              deletions: 40
            })
          ],
          dirtyFiles: [{ path: "src/old.ts", status: "modified" }]
        })
      ]
    });

    const summary = buildActivitySummary(input);

    expect(isActivitySummary(summary)).toBe(true);
    expect(summary).toMatchObject({
      schemaVersion: 1,
      targetDate: "2026-05-12",
      generatedAt: "2026-05-12T23:30:00.000Z",
      activityLevel: "high",
      dominantTheme: "mixed",
      commitSignals: {
        totalCommits: 2,
        filesChanged: 6,
        insertions: 92,
        deletions: 15,
        subjects: [
          "implement collect git command",
          "fix flaky collector path handling"
        ],
        themes: ["coding", "debugging"]
      },
      uncommittedChanges: {
        totalFiles: 2
      }
    });
    expect(summary.projects).toEqual([
      expect.objectContaining({
        projectId: "cli",
        projectName: "CLI",
        repositoryName: "cli-repo",
        commitCount: 2,
        manualNoteCount: 0,
        uncommittedChangeCount: 2,
        themes: ["coding", "debugging"]
      })
    ]);
    expect(summary.projects).not.toContainEqual(
      expect.objectContaining({
        projectId: "old"
      })
    );
    expect(summary.smallWins).toEqual([
      "implement collect git command",
      "fix flaky collector path handling"
    ]);
    expect(summary.unfinishedThreads).toContain(
      "2 uncommitted files remain in CLI."
    );
    expect(summary.possibleJokes).toContain(
      "The working tree kept a few tabs open for tomorrow."
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("const ");
    expect(serialized).not.toContain("prior day");
  });

  it("treats quiet days as valid summaries without inventing work", () => {
    const summary = buildActivitySummary(createInput());

    expect(isActivitySummary(summary)).toBe(true);
    expect(summary.activityLevel).toBe("none");
    expect(summary.dominantTheme).toBe("quiet");
    expect(summary.projects).toEqual([]);
    expect(summary.commitSignals.totalCommits).toBe(0);
    expect(summary.manualContext.noteCount).toBe(0);
    expect(summary.smallWins).toEqual([]);
    expect(summary.blockersOrConfusion).toEqual([]);
    expect(summary.unfinishedThreads).toEqual([]);
    expect(summary.possibleJokes).toEqual([
      "Quiet day, but the draft still has to admit nothing exploded."
    ]);
    expect(summary.uncertaintyNotes).toContain(
      "No Git activity or manual notes were found for 2026-05-12."
    );
  });

  it("represents manual-note-only days without requiring Git commits", () => {
    const summary = buildActivitySummary(
      createInput({
        manualNotes: [
          {
            schemaVersion: 1,
            id: "note-1",
            timestamp: "2026-05-12T09:00:00.000Z",
            date: "2026-05-12",
            projectId: "cli",
            text: "Planned activity summary shape with dev@example.com in /Users/me/private and https://github.com/acme/private",
            source: "manual"
          }
        ]
      })
    );

    expect(summary.activityLevel).toBe("low");
    expect(summary.dominantTheme).toBe("planning");
    expect(summary.projects).toEqual([
      expect.objectContaining({
        projectId: "cli",
        projectName: "cli",
        commitCount: 0,
        manualNoteCount: 1,
        themes: ["planning"]
      })
    ]);
    expect(summary.manualContext.notes).toEqual([
      expect.objectContaining({
        projectId: "cli",
        text: "Planned activity summary shape with [redacted-email] in [redacted-path] and [redacted-url]"
      })
    ]);
    expect(summary.publicSafetyNotes).toContain(
      "Manual notes were sanitized for private details."
    );
    expect(summary.privateItemsToAvoid).toEqual([
      "emails",
      "local absolute paths",
      "private URLs"
    ]);
    expect(summary.uncertaintyNotes).toContain(
      "Git activity was not provided; summary relies on manual notes."
    );

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("dev@example.com");
    expect(serialized).not.toContain("/Users/me/private");
    expect(serialized).not.toContain("github.com/acme/private");
  });

  it("merges mixed Git and manual context without raw diffs or raw code", () => {
    const summary = buildActivitySummary(
      createInput({
        gitEvents: [
          createGitEvent({
            projectId: "cli",
            projectName: "CLI",
            commits: [
              createCommit({
                subject: "refactor note parsing",
                filesChanged: 3,
                insertions: 20,
                deletions: 18
              })
            ],
            dirtyFiles: [{ path: "src/note-command.ts", status: "modified" }]
          })
        ],
        manualNotes: [
          {
            schemaVersion: 1,
            id: "note-2",
            timestamp: "2026-05-12T15:00:00.000Z",
            date: "2026-05-12",
            projectId: "cli",
            text: "Blocked by unclear edge case. TODO revisit const token = process.env.SECRET tomorrow.",
            source: "manual"
          }
        ]
      })
    );

    expect(summary.activityLevel).toBe("medium");
    expect(summary.dominantTheme).toBe("mixed");
    expect(summary.projects).toEqual([
      expect.objectContaining({
        projectId: "cli",
        projectName: "CLI",
        commitCount: 1,
        manualNoteCount: 1,
        uncommittedChangeCount: 1,
        themes: ["debugging", "planning", "refactoring"]
      })
    ]);
    expect(summary.blockersOrConfusion).toEqual([
      "Blocked by unclear edge case. TODO revisit [redacted-code] tomorrow."
    ]);
    expect(summary.unfinishedThreads).toEqual([
      "1 uncommitted file remains in CLI.",
      "Blocked by unclear edge case. TODO revisit [redacted-code] tomorrow."
    ]);
    expect(summary.privateItemsToAvoid).toContain("raw code snippets");

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("const token");
    expect(serialized).not.toContain("process.env.SECRET");
    expect(serialized).not.toContain("diff --git");
  });
});

function createInput(
  overrides: Partial<ActivitySummaryInput> = {}
): ActivitySummaryInput {
  return {
    targetDate: "2026-05-12",
    generatedAt: "2026-05-12T23:30:00.000Z",
    gitEvents: [],
    manualNotes: [],
    ...overrides
  };
}

function createGitEvent(
  options: {
    targetDate?: string;
    projectId: string;
    projectName: string;
    commits?: ActivitySummaryInput["gitEvents"][number]["activity"]["commits"];
    dirtyFiles?: ActivitySummaryInput["gitEvents"][number]["activity"]["dirty"]["files"];
  }
): ActivitySummaryInput["gitEvents"][number] {
  const commits = options.commits ?? [];
  const dirtyFiles = options.dirtyFiles ?? [];
  const targetDate = options.targetDate ?? "2026-05-12";

  return {
    schemaVersion: 1,
    source: "git",
    targetDate,
    collectedAt: "2026-05-12T23:00:00.000Z",
    project: {
      id: options.projectId,
      name: options.projectName
    },
    activity: {
      schemaVersion: 1,
      targetDate,
      repository: {
        rootName: `${options.projectId}-repo`
      },
      commits,
      totals: commits.reduce(
        (totals, commit) => ({
          commits: totals.commits + 1,
          filesChanged: totals.filesChanged + commit.stats.filesChanged,
          insertions: totals.insertions + commit.stats.insertions,
          deletions: totals.deletions + commit.stats.deletions
        }),
        { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 }
      ),
      dirty: {
        files: dirtyFiles,
        totals: {
          modified: dirtyFiles.filter((file) => file.status === "modified").length,
          added: dirtyFiles.filter((file) => file.status === "added").length,
          deleted: dirtyFiles.filter((file) => file.status === "deleted").length,
          renamed: dirtyFiles.filter((file) => file.status === "renamed").length,
          copied: dirtyFiles.filter((file) => file.status === "copied").length,
          untracked: dirtyFiles.filter((file) => file.status === "untracked").length,
          other: dirtyFiles.filter((file) => file.status === "other").length
        }
      }
    }
  };
}

function createCommit(options: {
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}): ActivitySummaryInput["gitEvents"][number]["activity"]["commits"][number] {
  return {
    hash: "1234567890abcdef1234567890abcdef12345678",
    shortHash: "1234567",
    authorName: "Fixture Dev",
    authoredAt: "2026-05-12T12:00:00.000Z",
    subject: options.subject,
    stats: {
      filesChanged: options.filesChanged,
      insertions: options.insertions,
      deletions: options.deletions
    }
  };
}

describe("activity summary — signal-driven synthesis (UNC-135)", () => {
  it("derives smallWins, unfinishedThreads, possibleJokes, dominantTheme from kind+summary alone", () => {
    const signals: ActivitySignal[] = [
      {
        projectId: "cli",
        timestamp: "2026-05-12T10:00:00.000Z",
        kind: "commit",
        summary: "implement collect git command",
        safetyNotes: []
      },
      {
        projectId: "cli",
        timestamp: "2026-05-12T11:00:00.000Z",
        kind: "commit",
        summary: "fix flaky collector path handling",
        safetyNotes: []
      },
      {
        projectId: "cli",
        timestamp: "2026-05-12T12:00:00.000Z",
        kind: "note",
        summary: "TODO revisit edge case tomorrow",
        safetyNotes: []
      }
    ];

    const synthesis = deriveSynthesisFromSignals(signals);

    expect(synthesis.smallWins).toEqual(
      expect.arrayContaining([
        "implement collect git command",
        "fix flaky collector path handling"
      ])
    );
    expect(synthesis.unfinishedThreads).toContain("TODO revisit edge case tomorrow");
    expect(synthesis.themes).toEqual(expect.arrayContaining(["coding", "debugging"]));
  });

  it("treats an unknown future kind as opaque — uses summary text only, no branching", () => {
    const signals: ActivitySignal[] = [
      {
        projectId: "cli",
        timestamp: "2026-05-12T10:00:00.000Z",
        kind: "claude-session" as ActivitySignal["kind"],
        summary: "refactor note parsing for clarity",
        safetyNotes: []
      }
    ];

    const synthesis = deriveSynthesisFromSignals(signals);
    expect(synthesis.themes).toContain("refactoring");
    expect(synthesis.smallWins).toEqual([]); // no "add/built/fixed/..." in summary
  });

  it("ignores dirty-file signals for smallWins (they are not wins)", () => {
    const signals: ActivitySignal[] = [
      {
        projectId: "cli",
        timestamp: "2026-05-12T00:00:00.000Z",
        kind: "dirty-file",
        summary: "modified: src/foo.ts",
        safetyNotes: []
      }
    ];

    const synthesis = deriveSynthesisFromSignals(signals);
    expect(synthesis.smallWins).toEqual([]);
  });

  it("does not infer themes from dirty-file path summaries", () => {
    // A day with only uncommitted files whose paths carry theme keywords
    // must not set a dominant theme — uncommitted changes are file-status
    // context only, never intent (matches the legacy commit+note-only theme
    // rollup). Regression guard for the EventSource synthesis refactor.
    const signals: ActivitySignal[] = [
      {
        projectId: "cli",
        timestamp: "2026-05-12T00:00:00.000Z",
        kind: "dirty-file",
        summary: "modified: src/fix-bug.ts",
        safetyNotes: []
      },
      {
        projectId: "cli",
        timestamp: "2026-05-12T00:00:00.000Z",
        kind: "dirty-file",
        summary: "untracked: todo.md",
        safetyNotes: []
      }
    ];

    const synthesis = deriveSynthesisFromSignals(signals);
    expect(synthesis.themes).toEqual([]);
    expect(synthesis.smallWins).toEqual([]);
    expect(synthesis.blockersOrConfusion).toEqual([]);
    expect(synthesis.unfinishedThreads).toEqual([]);
  });
});
