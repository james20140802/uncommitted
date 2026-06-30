import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectGitHubForRegisteredProjects,
  CollectGitHubCommandError
} from "../src/collect-github-command.js";
import { GitHubTokenConfigError } from "../src/github-token-resolver.js";
import { clearGlobalConfigCache } from "../src/global-config.js";

async function seedProjects(homeDir: string, projectRoot: string) {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "projects.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          schemaVersion: 1,
          id: "p1",
          name: "demo",
          root: projectRoot,
          gitRoot: projectRoot,
          enabled: true,
          createdAt: "2026-06-14T00:00:00Z"
        }
      ]
    })
  );
}

describe("collectGitHubForRegisteredProjects", () => {
  it("returns no-token error when neither env nor config has a token", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    await expect(
      collectGitHubForRegisteredProjects({
        homeDir,
        env: {},
        targetDate: "2026-06-17",
        remoteUrlReader: async () => "https://github.com/foo/bar.git",
        httpClient: async () => new Response("{}", { status: 200 })
      })
    ).rejects.toMatchObject({ code: "no-token" });
  });

  it("surfaces config corruption instead of no-token when config is valid JSON but not a record", async () => {
    clearGlobalConfigCache();
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    await writeFile(join(homeDir, ".uncommitted", "config.json"), "[]");
    await expect(
      collectGitHubForRegisteredProjects({
        homeDir,
        env: {},
        targetDate: "2026-06-17",
        remoteUrlReader: async () => "https://github.com/foo/bar.git",
        httpClient: async () => new Response("{}", { status: 200 })
      })
    ).rejects.toBeInstanceOf(GitHubTokenConfigError);
  });

  it("graceful-skips a project whose origin is not on github.com", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: { GITHUB_TOKEN: "t" },
      targetDate: "2026-06-17",
      remoteUrlReader: async () => "git@gitlab.com:foo/bar.git",
      httpClient: async () => {
        throw new Error("should not be called");
      }
    });
    expect(result.skippedProjects).toHaveLength(1);
    expect(result.successes).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });

  it("writes signal + raw archive when fetcher returns data", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);

    // Handlers ordered most-specific-first (mirroring the fetcher test pattern).
    const responses: Array<[string, () => Response]> = [
      ["/pulls/1/reviews", () => new Response(JSON.stringify([]))],
      [
        "/search/issues",
        () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  number: 1,
                  title: "PR1",
                  body: "my body",
                  pull_request: { merged_at: "2026-06-17T05:00:00Z" },
                  closed_at: "2026-06-17T05:00:00Z",
                  user: { login: "alice" }
                }
              ]
            })
          )
      ],
      ["/repos/foo/bar", () => new Response(JSON.stringify({ private: false }))],
      ["/user", () => new Response(JSON.stringify({ login: "alice" }))]
    ];
    const httpClient = async (url: string) => {
      const handler = responses.find(([k]) => url.includes(k))?.[1];
      if (!handler) return new Response("not found", { status: 404 });
      return handler();
    };

    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: { GITHUB_TOKEN: "t" },
      targetDate: "2026-06-17",
      remoteUrlReader: async () => "https://github.com/foo/bar.git",
      httpClient
    });

    expect(result.successes).toHaveLength(1);
    const signals = await readFile(result.successes[0].signalsFile, "utf8");
    expect(signals).toContain('"kind":"pr"');
    const raw = await readFile(result.successes[0].rawArchiveFile, "utf8");
    expect(raw).toContain('"source":"pr-body"');
  });

  it("flushes partial output on per-project failure and returns failure entry", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);

    const httpClient = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: { GITHUB_TOKEN: "t" },
      targetDate: "2026-06-17",
      remoteUrlReader: async () => "https://github.com/foo/bar.git",
      httpClient
    });
    expect(result.successes).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    const empty = await readFile(
      join(projectRoot, ".uncommitted", "events", "github", "2026-06-17.jsonl"),
      "utf8"
    );
    expect(empty).toBe("");
  });

  it("skips GitLab-only/local projects without requiring a GitHub token", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: {}, // no token
      targetDate: "2026-06-17",
      remoteUrlReader: async () => "git@gitlab.com:foo/bar.git",
      httpClient: async () => {
        throw new Error("should not be called");
      }
    });
    expect(result.skippedProjects).toHaveLength(1);
    expect(result.successes).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });

  it("prunes expired github raw archives for a project whose remote is no longer github", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    // The project once collected GitHub activity but its remote has since
    // changed away from GitHub. retention must still age out the archives it
    // accumulated, even though the project now takes the skipped path.
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify({ rawRetentionDays: 7 })
    );
    const rawDir = join(projectRoot, ".uncommitted", "events", "github", "raw");
    await mkdir(rawDir, { recursive: true });
    // today 2026-06-17 with retention 7 → cutoff 2026-06-11.
    const expired = join(rawDir, "2026-06-01.jsonl");
    const recent = join(rawDir, "2026-06-17.jsonl");
    await writeFile(expired, "{}\n");
    await writeFile(recent, "{}\n");

    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: { GITHUB_TOKEN: "t" },
      targetDate: "2026-06-17",
      remoteUrlReader: async () => "git@gitlab.com:foo/bar.git",
      httpClient: async () => {
        throw new Error("should not be called");
      }
    });

    expect(result.skippedProjects).toHaveLength(1);
    await expect(readFile(expired, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(recent, "utf8")).resolves.toBe("{}\n");
  });

  it("preserves previously collected events when a re-run's fetch fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);

    const githubDir = join(projectRoot, ".uncommitted", "events", "github");
    await mkdir(join(githubDir, "raw"), { recursive: true });
    const signalsPath = join(githubDir, "2026-06-17.jsonl");
    const rawPath = join(githubDir, "raw", "2026-06-17.jsonl");
    const priorSignals = '{"projectId":"p1","timestamp":"2026-06-17T05:00:00Z","kind":"pr","summary":"PR #1 merged: keep me","safetyNotes":[]}\n';
    const priorRaw = '{"source":"pr-body","number":1,"visibility":"public","text":"keep me","timestamp":"2026-06-17T05:00:00Z"}\n';
    await writeFile(signalsPath, priorSignals);
    await writeFile(rawPath, priorRaw);

    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: { GITHUB_TOKEN: "t" },
      targetDate: "2026-06-17",
      remoteUrlReader: async () => "https://github.com/foo/bar.git",
      httpClient: async () => new Response("nope", { status: 500 })
    });

    expect(result.failures).toHaveLength(1);
    expect(await readFile(signalsPath, "utf8")).toBe(priorSignals);
    expect(await readFile(rawPath, "utf8")).toBe(priorRaw);
  });

  it("reports a per-project failure when the git remote read fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    const result = await collectGitHubForRegisteredProjects({
      homeDir,
      env: {}, // no token: a broken project must not be silently skipped
      targetDate: "2026-06-17",
      remoteUrlReader: async () => {
        throw new Error("not a git repository");
      },
      httpClient: async () => {
        throw new Error("should not be called");
      }
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].projectId).toBe("p1");
    expect(result.skippedProjects).toHaveLength(0);
    expect(result.successes).toHaveLength(0);
  });

  it("rejects an invalid --date (not YYYY-MM-DD)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "gh-cmd-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-proj-"));
    await seedProjects(homeDir, projectRoot);
    await expect(
      collectGitHubForRegisteredProjects({
        homeDir,
        env: { GITHUB_TOKEN: "t" },
        targetDate: "not-a-date",
        remoteUrlReader: async () => "https://github.com/foo/bar.git",
        httpClient: async () => new Response("{}")
      })
    ).rejects.toMatchObject({ code: "invalid-date" });
  });

  it("exports CollectGitHubCommandError as a constructable class", () => {
    const err = new CollectGitHubCommandError("x", "no-token");
    expect(err.code).toBe("no-token");
  });
});
