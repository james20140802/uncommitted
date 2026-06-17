import { describe, it, expect } from "vitest";
import { normalizeGitHubFetch } from "../src/github-event-normalizer.js";
import type { GitHubFetchResult } from "../src/github-fetcher.js";

const base: GitHubFetchResult = {
  visibility: "public",
  authenticatedLogin: "alice",
  mergedPRs: [
    { number: 1, title: "Add caching", body: "Implements LRU.", authorLogin: "alice", mergedAt: "2026-06-17T05:00:00Z" },
    { number: 2, title: "External PR", body: "from someone else", authorLogin: "bob", mergedAt: "2026-06-17T06:00:00Z" }
  ],
  closedIssues: [
    { number: 9, title: "Bug X", body: "I tracked this down", authorLogin: "alice", closedAt: "2026-06-17T07:00:00Z" }
  ],
  reviews: [
    { id: 100, prNumber: 1, state: "APPROVED", submittedAt: "2026-06-17T08:00:00Z", authorLogin: "alice", body: "lgtm" },
    { id: 101, prNumber: 1, state: "COMMENTED", submittedAt: "2026-06-17T08:30:00Z", authorLogin: "carol", body: "nit pick" }
  ]
};

describe("normalizeGitHubFetch", () => {
  it("emits one signal per own PR/issue/review and excludes teammates' activity", () => {
    const r = normalizeGitHubFetch({ projectId: "p1", fetch: base });
    const kinds = r.signals.map((s) => s.kind).sort();
    // PR #2 (bob) and review #101 (carol) must not become this user's activity.
    expect(kinds).toEqual(["issue", "pr", "review"]);
  });

  it("never emits a signal for a PR/issue/review authored by someone else", () => {
    const r = normalizeGitHubFetch({ projectId: "p1", fetch: base });
    expect(r.signals.some((s) => s.summary.includes("#2"))).toBe(false);
    const reviewSummaries = r.signals
      .filter((s) => s.kind === "review")
      .map((s) => s.summary);
    expect(reviewSummaries).toEqual(["Review APPROVED on PR #1"]);
  });

  it("only collects bodies authored by the authenticated user", () => {
    const r = normalizeGitHubFetch({ projectId: "p1", fetch: base });
    const sources = r.ownAuthoredBodies.map((b) => `${b.source}#${b.number}`).sort();
    expect(sources).toEqual(["issue-body#9", "pr-body#1", "review-comment#1"]);
  });

  it("uses pr.mergedAt / issue.closedAt / review.submittedAt as the signal timestamp", () => {
    const r = normalizeGitHubFetch({ projectId: "p1", fetch: base });
    const pr1 = r.signals.find((s) => s.kind === "pr" && s.summary.includes("#1"));
    expect(pr1?.timestamp).toBe("2026-06-17T05:00:00Z");
  });

  it("stamps visibility on every own-authored body", () => {
    const r = normalizeGitHubFetch({ projectId: "p1", fetch: { ...base, visibility: "private" } });
    expect(r.ownAuthoredBodies.every((b) => b.visibility === "private")).toBe(true);
  });

  it("compares author logins case-insensitively so case drift doesn't drop own bodies", () => {
    const fetch: GitHubFetchResult = {
      visibility: "public",
      authenticatedLogin: "Alice",
      mergedPRs: [
        { number: 42, title: "Mine", body: "this is mine",
          authorLogin: "alice", mergedAt: "2026-06-17T01:00:00Z" }
      ],
      closedIssues: [],
      reviews: []
    };
    const r = normalizeGitHubFetch({ projectId: "p", fetch });
    expect(r.ownAuthoredBodies.map((b) => b.source)).toEqual(["pr-body"]);
  });
});
