import { describe, it, expect, vi } from "vitest";
import {
  fetchGitHubActivity,
  RateLimitedError,
  type HttpClient
} from "../src/github-fetcher.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(handlers: Record<string, () => Response>): HttpClient {
  const calls: string[] = [];
  const client: HttpClient = async (url) => {
    calls.push(url);
    const handler = Object.entries(handlers).find(([k]) => url.includes(k))?.[1];
    if (!handler) throw new Error(`unexpected url ${url}`);
    return handler();
  };
  (client as HttpClient & { calls: string[] }).calls = calls;
  return client;
}

describe("fetchGitHubActivity", () => {
  it("fetches visibility, merged PRs, closed issues, and reviews for the target date", async () => {
    const client = makeClient({
      "/pulls/1/reviews": () => jsonResponse([
        { id: 100, state: "APPROVED", submitted_at: "2026-06-17T07:00:00Z",
          user: { login: "alice" }, body: "lgtm" },
        { id: 101, state: "COMMENTED", submitted_at: "2026-06-17T07:30:00Z",
          user: { login: "carol" }, body: "nit" }
      ]),
      "/search/issues": () => jsonResponse({
        items: [
          { number: 1, title: "PR one", body: "auth body", state: "closed",
            pull_request: { merged_at: "2026-06-17T05:00:00Z" },
            closed_at: "2026-06-17T05:00:00Z",
            user: { login: "alice" } },
          { number: 9, title: "Issue nine", body: "by bob", state: "closed",
            closed_at: "2026-06-17T06:00:00Z",
            user: { login: "bob" } }
        ]
      }),
      "/repos/foo/bar": () => jsonResponse({ private: false, full_name: "foo/bar" }),
      "/user": () => jsonResponse({ login: "alice" })
    });

    const result = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client
    });

    expect(result.visibility).toBe("public");
    expect(result.authenticatedLogin).toBe("alice");
    expect(result.mergedPRs.map((p) => p.number)).toEqual([1]);
    expect(result.closedIssues.map((i) => i.number)).toEqual([9]);
    expect(result.reviews.map((r) => r.id)).toEqual([100, 101]);
  });

  it("retries 429 once with backoff then throws RateLimitedError on second 429", async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    };
    await expect(
      fetchGitHubActivity({
        token: "t", owner: "foo", repo: "bar",
        targetDate: "2026-06-17", httpClient: client,
        sleep: vi.fn().mockResolvedValue(undefined)
      })
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("returns private visibility when /repos reports private: true", async () => {
    const client = makeClient({
      "/user": () => jsonResponse({ login: "alice" }),
      "/repos/foo/bar": () => jsonResponse({ private: true, full_name: "foo/bar" }),
      "/search/issues": () => jsonResponse({ items: [] }),
    });
    const result = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client
    });
    expect(result.visibility).toBe("private");
  });
});
