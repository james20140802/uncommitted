import type { ActivitySignal } from "./event-source.js";
import type { GitHubFetchResult, RepoVisibility } from "./github-fetcher.js";

export type OwnAuthoredBody = {
  source: "pr-body" | "issue-body" | "review-comment";
  number: number;
  visibility: RepoVisibility;
  text: string;
  timestamp: string;
};

export type NormalizedGitHub = {
  signals: ActivitySignal[];
  ownAuthoredBodies: OwnAuthoredBody[];
};

export type NormalizeInput = {
  projectId: string;
  fetch: GitHubFetchResult;
};

const SUMMARY_LIMIT = 200;

function trim(s: string): string {
  return s.length > SUMMARY_LIMIT ? s.slice(0, SUMMARY_LIMIT) : s;
}

export function normalizeGitHubFetch(input: NormalizeInput): NormalizedGitHub {
  const signals: ActivitySignal[] = [];
  const bodies: OwnAuthoredBody[] = [];
  const me = input.fetch.authenticatedLogin;
  const visibility = input.fetch.visibility;

  for (const pr of input.fetch.mergedPRs) {
    signals.push({
      projectId: input.projectId,
      timestamp: pr.mergedAt,
      kind: "pr",
      summary: trim(`PR #${pr.number} merged: ${pr.title}`),
      safetyNotes: []
    });
    if (pr.authorLogin === me && pr.body) {
      bodies.push({ source: "pr-body", number: pr.number, visibility, text: pr.body, timestamp: pr.mergedAt });
    }
  }

  for (const issue of input.fetch.closedIssues) {
    signals.push({
      projectId: input.projectId,
      timestamp: issue.closedAt,
      kind: "issue",
      summary: trim(`Issue #${issue.number} closed: ${issue.title}`),
      safetyNotes: []
    });
    if (issue.authorLogin === me && issue.body) {
      bodies.push({ source: "issue-body", number: issue.number, visibility, text: issue.body, timestamp: issue.closedAt });
    }
  }

  for (const review of input.fetch.reviews) {
    signals.push({
      projectId: input.projectId,
      timestamp: review.submittedAt,
      kind: "review",
      summary: trim(`Review ${review.state} on PR #${review.prNumber}`),
      safetyNotes: []
    });
    if (review.authorLogin === me && review.body) {
      bodies.push({
        source: "review-comment",
        number: review.prNumber,
        visibility,
        text: review.body,
        timestamp: review.submittedAt
      });
    }
  }

  return { signals, ownAuthoredBodies: bodies };
}
