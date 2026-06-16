import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectGitHubForRegisteredProjects,
  CollectGitHubCommandError
} from "../src/collect-github-command.js";

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
