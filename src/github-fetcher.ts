export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export type RepoVisibility = "public" | "private";

export type FetchedPR = {
  number: number;
  title: string;
  body: string;
  authorLogin: string;
  mergedAt: string;
};

export type FetchedIssue = {
  number: number;
  title: string;
  body: string;
  authorLogin: string;
  closedAt: string;
};

export type FetchedReview = {
  id: number;
  prNumber: number;
  state: string;
  submittedAt: string;
  authorLogin: string;
  body: string;
};

export type GitHubFetchResult = {
  visibility: RepoVisibility;
  authenticatedLogin: string;
  mergedPRs: FetchedPR[];
  closedIssues: FetchedIssue[];
  reviews: FetchedReview[];
};

export type FetchGitHubActivityInput = {
  token: string;
  owner: string;
  repo: string;
  targetDate: string;
  httpClient?: HttpClient;
  sleep?: Sleep;
};

export class RateLimitedError extends Error {
  constructor(message = "GitHub rate limit hit twice in a row.") {
    super(message);
    this.name = "RateLimitedError";
  }
}

const API = "https://api.github.com";

// GitHub signals rate limiting with 429, or 403 accompanied by an exhausted
// quota (`x-ratelimit-remaining: 0`) or a `retry-after` header. A bare 403
// (missing scope, no access to a private repo) is an authorization problem and
// must surface as a normal HTTP error instead of a misleading rate-limit retry.
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return (
    res.headers.get("retry-after") !== null ||
    res.headers.get("x-ratelimit-remaining") === "0"
  );
}

export async function fetchGitHubActivity(
  input: FetchGitHubActivityInput
): Promise<GitHubFetchResult> {
  const http = input.httpClient ?? ((url, init) => fetch(url, init));
  const sleep = input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const get = async <T>(path: string): Promise<T> => {
    const url = `${API}${path}`;
    const headers: HeadersInit = {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "uncommitted-collector"
    };
    let res = await http(url, { headers });
    if (isRateLimited(res)) {
      await sleep(1500);
      res = await http(url, { headers });
      if (isRateLimited(res)) {
        throw new RateLimitedError();
      }
    }
    if (!res.ok) {
      throw new Error(`GitHub ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  };

  const me = await get<{ login: string }>("/user");
  const repoInfo = await get<{ private: boolean }>(`/repos/${input.owner}/${input.repo}`);
  const visibility: RepoVisibility = repoInfo.private ? "private" : "public";

  const prSearch = await get<{ items: GHIssueLike[] }>(
    `/search/issues?q=${encodeURIComponent(
      `repo:${input.owner}/${input.repo} is:pr is:merged merged:${input.targetDate}`
    )}&per_page=100`
  );
  const mergedPRs: FetchedPR[] = prSearch.items
    .filter((it) => it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title ?? "",
      body: typeof it.body === "string" ? it.body : "",
      authorLogin: it.user?.login ?? "",
      mergedAt: it.pull_request?.merged_at ?? it.closed_at ?? ""
    }));

  const issueSearch = await get<{ items: GHIssueLike[] }>(
    `/search/issues?q=${encodeURIComponent(
      `repo:${input.owner}/${input.repo} is:issue is:closed closed:${input.targetDate}`
    )}&per_page=100`
  );
  const closedIssues: FetchedIssue[] = issueSearch.items
    .filter((it) => !it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title ?? "",
      body: typeof it.body === "string" ? it.body : "",
      authorLogin: it.user?.login ?? "",
      closedAt: it.closed_at ?? ""
    }));

  const reviews: FetchedReview[] = [];
  for (const pr of mergedPRs) {
    const list = await get<GHReview[]>(`/repos/${input.owner}/${input.repo}/pulls/${pr.number}/reviews`);
    for (const r of list) {
      if (!r.submitted_at || !r.submitted_at.startsWith(input.targetDate)) continue;
      reviews.push({
        id: r.id,
        prNumber: pr.number,
        state: r.state ?? "",
        submittedAt: r.submitted_at,
        authorLogin: r.user?.login ?? "",
        body: typeof r.body === "string" ? r.body : ""
      });
    }
  }

  return { visibility, authenticatedLogin: me.login, mergedPRs, closedIssues, reviews };
}

type GHIssueLike = {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  closed_at?: string;
  pull_request?: { merged_at?: string };
  user?: { login?: string };
};

type GHReview = {
  id: number;
  state?: string;
  submitted_at?: string;
  body?: string | null;
  user?: { login?: string };
};
