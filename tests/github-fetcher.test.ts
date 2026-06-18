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

  it("treats a 403 without rate-limit headers as a normal HTTP error, not a rate limit", async () => {
    let calls = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client: HttpClient = async () => {
      calls++;
      // 403 with quota remaining => authorization/scope problem, not rate limit.
      return new Response("Forbidden", {
        status: 403,
        headers: { "x-ratelimit-remaining": "57" }
      });
    };
    const err = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client, sleep
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RateLimitedError);
    expect((err as Error).message).toContain("403");
    // No retry/backoff for a non-rate-limit 403.
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats a 403 with x-ratelimit-remaining: 0 as a rate limit (retries then throws)", async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" }
      });
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

  it("pages through merged-PR search results beyond the first 100", async () => {
    const calls: string[] = [];
    const prItem = (n: number) => ({
      number: n, title: `PR ${n}`, body: "",
      pull_request: { merged_at: "2026-06-17T05:00:00Z" },
      closed_at: "2026-06-17T05:00:00Z", user: { login: "alice" }
    });
    const client: HttpClient = async (url) => {
      calls.push(url);
      if (url.includes("/reviews")) return jsonResponse([]);
      if (url.includes("/user")) return jsonResponse({ login: "alice" });
      if (url.endsWith("/repos/foo/bar")) return jsonResponse({ private: false });
      if (url.includes("/search/issues")) {
        const isPrMerged = url.includes("is%3Apr") && url.includes("is%3Amerged");
        const isReviewedBy = url.includes("reviewed-by");
        if (isPrMerged && !isReviewedBy) {
          const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
          if (page === 1) {
            return jsonResponse({ items: Array.from({ length: 100 }, (_, i) => prItem(i + 1)) });
          }
          if (page === 2) {
            return jsonResponse({ items: Array.from({ length: 5 }, (_, i) => prItem(i + 101)) });
          }
          return jsonResponse({ items: [] });
        }
        return jsonResponse({ items: [] });
      }
      return jsonResponse({}, 404);
    };

    const result = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client
    });

    expect(result.mergedPRs).toHaveLength(105);
    expect(calls.some((u) => u.includes("page=2") && u.includes("is%3Apr"))).toBe(true);
  });

  it("attributes a closed issue to the closer, not the opener", async () => {
    const client: HttpClient = async (url) => {
      if (url.includes("/issues/9")) {
        // Opened by bob, closed by the authenticated user (alice).
        return jsonResponse({ number: 9, closed_by: { login: "alice" } });
      }
      if (url.includes("/issues/10")) {
        // Opened by alice, closed by bob.
        return jsonResponse({ number: 10, closed_by: { login: "bob" } });
      }
      if (url.includes("/reviews")) return jsonResponse([]);
      if (url.includes("/user")) return jsonResponse({ login: "alice" });
      if (url.endsWith("/repos/foo/bar")) return jsonResponse({ private: false });
      if (url.includes("/search/issues")) {
        if (url.includes("is%3Aissue")) {
          return jsonResponse({ items: [
            { number: 9, title: "Issue nine", body: "b", closed_at: "2026-06-17T06:00:00Z", user: { login: "bob" } },
            { number: 10, title: "Issue ten", body: "b", closed_at: "2026-06-17T06:30:00Z", user: { login: "alice" } }
          ] });
        }
        return jsonResponse({ items: [] });
      }
      return jsonResponse({}, 404);
    };

    const result = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client
    });

    const nine = result.closedIssues.find((i) => i.number === 9);
    const ten = result.closedIssues.find((i) => i.number === 10);
    expect(nine?.closedByLogin).toBe("alice");
    expect(ten?.closedByLogin).toBe("bob");
  });

  it("pages through PR reviews beyond the first page", async () => {
    const calls: string[] = [];
    const review = (id: number) => ({
      id, state: "COMMENTED", submitted_at: "2026-06-17T09:00:00Z",
      user: { login: "alice" }, body: "ok"
    });
    const client: HttpClient = async (url) => {
      calls.push(url);
      if (url.includes("/pulls/1/reviews")) {
        const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
        if (page === 1) {
          return jsonResponse(Array.from({ length: 100 }, (_, i) => review(i + 1)));
        }
        if (page === 2) {
          return jsonResponse([review(101)]);
        }
        return jsonResponse([]);
      }
      if (url.includes("/user")) return jsonResponse({ login: "alice" });
      if (url.endsWith("/repos/foo/bar")) return jsonResponse({ private: false });
      if (url.includes("/search/issues")) {
        const isPrMerged = url.includes("is%3Apr") && url.includes("is%3Amerged");
        if (isPrMerged) {
          const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
          if (page === 1) {
            return jsonResponse({ items: [{
              number: 1, title: "PR one", pull_request: { merged_at: "2026-06-17T05:00:00Z" },
              closed_at: "2026-06-17T05:00:00Z", user: { login: "alice" }
            }] });
          }
          return jsonResponse({ items: [] });
        }
        return jsonResponse({ items: [] });
      }
      return jsonResponse({}, 404);
    };

    const result = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client
    });

    expect(result.reviews).toHaveLength(101);
    expect(result.reviews.map((r) => r.id)).toContain(101);
    expect(calls.some((u) => u.includes("/pulls/1/reviews") && u.includes("page=2"))).toBe(true);
  });

  it("discovers reviews on PRs that were not merged on the target date", async () => {
    const calls: string[] = [];
    const client: HttpClient = async (url) => {
      calls.push(url);
      if (url.includes("/pulls/7/reviews")) {
        return jsonResponse([
          { id: 500, state: "APPROVED", submitted_at: "2026-06-17T09:00:00Z",
            user: { login: "alice" }, body: "ok" }
        ]);
      }
      if (url.includes("/reviews")) return jsonResponse([]);
      if (url.includes("/user")) return jsonResponse({ login: "alice" });
      if (url.endsWith("/repos/foo/bar")) return jsonResponse({ private: false });
      if (url.includes("/search/issues")) {
        if (url.includes("reviewed-by")) {
          // PR #7 is open / merged a different day, but the user reviewed it today.
          return jsonResponse({ items: [{ number: 7, title: "Open PR", pull_request: {}, user: { login: "carol" } }] });
        }
        return jsonResponse({ items: [] });
      }
      return jsonResponse({}, 404);
    };

    const result = await fetchGitHubActivity({
      token: "t", owner: "foo", repo: "bar",
      targetDate: "2026-06-17", httpClient: client
    });

    expect(result.mergedPRs).toHaveLength(0);
    expect(result.reviews.map((r) => r.prNumber)).toContain(7);
    expect(result.reviews.map((r) => r.id)).toContain(500);
    expect(calls.some((u) => u.includes("/pulls/7/reviews"))).toBe(true);
  });
});
