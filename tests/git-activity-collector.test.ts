import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  collectGitActivity,
  GitActivityCollectionError
} from "../src/git-activity-collector.js";

const execFileAsync = promisify(execFile);

describe("Git activity collector", () => {
  it("collects date-scoped commit metadata, safe stats, and dirty status summaries", async () => {
    const repoDir = await initGitRepo("collector-repo");
    const nestedDir = join(repoDir, "packages", "cli");
    await mkdir(nestedDir, { recursive: true });

    await writeFile(join(repoDir, "app.ts"), "const base = 1;\n", "utf8");
    await git(repoDir, ["add", "app.ts"]);
    await commit(repoDir, "base commit", "2026-05-04T12:00:00Z");

    await writeFile(
      join(repoDir, "app.ts"),
      "const base = 1;\nconst target = 2;\n",
      "utf8"
    );
    await writeFile(join(repoDir, "notes.md"), "target note\n", "utf8");
    await git(repoDir, ["add", "app.ts", "notes.md"]);
    await commit(
      repoDir,
      "safe work by dev@example.com in /Users/someone/secret and /workspace/app https://github.com/acme/private",
      "2026-05-05T10:00:00Z"
    );

    await git(repoDir, [
      "remote",
      "add",
      "origin",
      "git@github.com:acme/private.git"
    ]);
    await writeFile(
      join(repoDir, "app.ts"),
      "const base = 1;\nconst target = 2;\nconst dirty = 3;\n",
      "utf8"
    );
    await writeFile(join(repoDir, "scratch.txt"), "uncommitted secret\n", "utf8");

    const activity = await collectGitActivity({
      projectRoot: nestedDir,
      targetDate: "2026-05-05"
    });

    expect(activity).toMatchObject({
      schemaVersion: 1,
      targetDate: "2026-05-05",
      repository: {
        rootName: basename(repoDir)
      },
      totals: {
        commits: 1,
        filesChanged: 2,
        insertions: 2,
        deletions: 0
      },
      dirty: {
        totals: {
          modified: 1,
          added: 0,
          deleted: 0,
          renamed: 0,
          copied: 0,
          untracked: 1,
          other: 0
        }
      }
    });
    expect(activity.repository.gitRoot).toBeUndefined();
    expect(activity.commits).toHaveLength(1);
    expect(activity.commits[0]).toMatchObject({
      shortHash: expect.stringMatching(/^[0-9a-f]{7,}$/),
      authorName: "Fixture Dev",
      subject:
        "safe work by [redacted-email] in [redacted-path] and [redacted-path] [redacted-url]",
      stats: {
        filesChanged: 2,
        insertions: 2,
        deletions: 0
      }
    });
    expect(activity.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(activity.dirty.files).toEqual([
      { path: "app.ts", status: "modified" },
      { path: "scratch.txt", status: "untracked" }
    ]);

    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain(repoDir);
    expect(serialized).not.toContain("dev@example.com");
    expect(serialized).not.toContain("/workspace/app");
    expect(serialized).not.toContain("github.com/acme/private");
    expect(serialized).not.toContain("git@github.com");
    expect(serialized).not.toContain("const target = 2");
    expect(serialized).not.toContain("uncommitted secret");
  });

  it("returns no commits for a quiet target date while still reporting dirty state", async () => {
    const repoDir = await initGitRepo("quiet-repo");

    await writeFile(join(repoDir, "app.ts"), "const base = 1;\n", "utf8");
    await git(repoDir, ["add", "app.ts"]);
    await commit(repoDir, "base commit", "2026-05-04T12:00:00Z");
    await writeFile(join(repoDir, "scratch.txt"), "quiet dirty file\n", "utf8");

    const activity = await collectGitActivity({
      projectRoot: repoDir,
      targetDate: "2026-05-05"
    });

    expect(activity.commits).toEqual([]);
    expect(activity.totals).toEqual({
      commits: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0
    });
    expect(activity.dirty.files).toEqual([
      { path: "scratch.txt", status: "untracked" }
    ]);
  });

  it("keeps arrows in added file names", async () => {
    const repoDir = await initGitRepo("arrow-file-repo");

    await writeFile(join(repoDir, "base.txt"), "base\n", "utf8");
    await git(repoDir, ["add", "base.txt"]);
    await commit(repoDir, "base commit", "2026-05-05T10:00:00Z");
    await writeFile(join(repoDir, "a -> b.txt"), "dirty\n", "utf8");
    await git(repoDir, ["add", "a -> b.txt"]);

    const activity = await collectGitActivity({
      projectRoot: repoDir,
      targetDate: "2026-05-06"
    });

    expect(activity.dirty.files).toEqual([
      { path: "a -> b.txt", status: "added" }
    ]);
  });

  it("fails with collection errors for missing or non-Git roots", async () => {
    const plainDir = await createTempRoot("plain-dir");
    const missingDir = join(plainDir, "missing");

    await expect(
      collectGitActivity({
        projectRoot: plainDir,
        targetDate: "2026-05-05"
      })
    ).rejects.toMatchObject({
      code: "not-git-repository",
      message: expect.stringContaining("Not a Git repository")
    });
    await expect(
      collectGitActivity({
        projectRoot: missingDir,
        targetDate: "2026-05-05"
      })
    ).rejects.toMatchObject({
      code: "path-not-found",
      message: expect.stringContaining("Path does not exist")
    });
    await expect(
      collectGitActivity({
        projectRoot: plainDir,
        targetDate: "2026-05-05"
      })
    ).rejects.toBeInstanceOf(GitActivityCollectionError);
  });
});

async function initGitRepo(name: string): Promise<string> {
  const repoDir = await createTempRoot(name);
  await git(repoDir, ["init", "."]);
  await git(repoDir, ["config", "user.name", "Fixture Dev"]);
  await git(repoDir, ["config", "user.email", "dev@example.com"]);
  return await realpath(repoDir);
}

async function createTempRoot(name: string): Promise<string> {
  const root = join(tmpdir(), `uncommitted-git-collector-${randomUUID()}`, name);
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { recursive: true });
  return root;
}

async function commit(
  repoDir: string,
  message: string,
  date: string
): Promise<void> {
  await git(repoDir, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

async function git(
  repoDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args], {
    env: {
      ...process.env,
      ...env
    }
  });
}
