import { describe, it, expect } from "vitest";
import { redactGitHubEvents } from "../src/github-event-redactor.js";
import type { NormalizedGitHub } from "../src/github-event-normalizer.js";

const base: NormalizedGitHub = {
  signals: [
    {
      projectId: "p1",
      timestamp: "2026-06-17T05:00:00Z",
      kind: "pr",
      summary: "PR #1 merged: bump deps",
      safetyNotes: []
    }
  ],
  ownAuthoredBodies: [
    {
      source: "pr-body",
      number: 1,
      visibility: "public",
      timestamp: "2026-06-17T05:00:00Z",
      text: "Bumped to v2. Email me at me@example.com or via git@github.com:foo/bar.git. token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
};

describe("redactGitHubEvents", () => {
  it("masks secrets, emails, and SSH remotes in own-authored bodies", () => {
    const r = redactGitHubEvents(base);
    const text = r.ownAuthoredBodies[0].text;
    expect(text).not.toContain("me@example.com");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("git@github.com:foo/bar.git");
    expect(r.appliedCategories).toContain("emails");
    expect(r.appliedCategories).toContain("vendor api tokens");
    expect(r.appliedCategories).toContain("private URLs");
  });

  it("applies a defensive second secret pass for private-visibility bodies", () => {
    const privateInput: NormalizedGitHub = {
      signals: [],
      ownAuthoredBodies: [
        {
          source: "pr-body",
          number: 1,
          visibility: "private",
          timestamp: "2026-06-17T05:00:00Z",
          text: "internal_url=https://internal.example.com/secret/path AKIAABCDEFGHIJKLMNOP"
        }
      ]
    };
    const r = redactGitHubEvents(privateInput);
    const text = r.ownAuthoredBodies[0].text;
    expect(text).not.toContain("AKIA");
    expect(text).not.toContain("https://internal.example.com");
  });

  it("redacts signal summaries too", () => {
    const sigInput: NormalizedGitHub = {
      signals: [
        {
          projectId: "p",
          timestamp: "2026-06-17T05:00:00Z",
          kind: "pr",
          summary: "PR #1 merged: contact alice@example.com",
          safetyNotes: []
        }
      ],
      ownAuthoredBodies: []
    };
    const r = redactGitHubEvents(sigInput);
    expect(r.signals[0].summary).not.toContain("alice@example.com");
    expect(r.signals[0].safetyNotes).toContain("emails");
  });
});
