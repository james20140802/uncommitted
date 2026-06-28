import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCodexForRegisteredProjects,
  CollectCodexCommandError
} from "../src/collect-codex-command.js";

async function seed(opts: {
  projectRoot: string;
  codexHome: string;
  cwd: string;
  date: string;
}) {
  const dayDir = join(
    opts.codexHome,
    "sessions",
    opts.date.slice(0, 4),
    opts.date.slice(5, 7),
    opts.date.slice(8, 10)
  );
  await mkdir(dayDir, { recursive: true });
  const lines = [
    JSON.stringify({
      timestamp: `${opts.date}T01:00:00.000Z`,
      type: "session_meta",
      payload: { id: "s1", cwd: opts.cwd }
    }),
    JSON.stringify({
      timestamp: `${opts.date}T01:00:01.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }]
      }
    })
  ].join("\n");
  await writeFile(join(dayDir, "rollout-x.jsonl"), lines);
}

describe("collectCodexForRegisteredProjects", () => {
  it("writes signal + raw archive for matching projects", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-cmd-"));
    const codexHome = join(homeDir, ".codex");
    const projectRoot = await mkdtemp(join(tmpdir(), "codex-proj-"));
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
    await seed({
      projectRoot,
      codexHome,
      cwd: projectRoot,
      date: "2026-06-14"
    });

    const result = await collectCodexForRegisteredProjects({
      homeDir,
      codexHome,
      now: () => "2026-06-14T05:00:00Z"
    });
    expect(result.codexLogsMissing).toBe(false);
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0].signalCount).toBeGreaterThan(0);

    const raw = await readFile(result.successes[0].rawArchiveFile, "utf8");
    expect(raw).toContain('"role":"user"');
  });

  it("discovers cross-midnight sessions stored under the previous day's directory", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-cmd-"));
    const codexHome = join(homeDir, ".codex");
    const projectRoot = await mkdtemp(join(tmpdir(), "codex-proj-"));
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

    // Session started 2026-06-13 (file lives under that day's dir) but the user
    // kept working past midnight; the meaningful entry is timestamped 06-14.
    const startDayDir = join(codexHome, "sessions", "2026", "06", "13");
    await mkdir(startDayDir, { recursive: true });
    await writeFile(
      join(startDayDir, "rollout-cross.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-06-13T23:59:00.000Z",
          type: "session_meta",
          payload: { id: "s1", cwd: projectRoot }
        }),
        JSON.stringify({
          timestamp: "2026-06-14T00:05:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "after midnight" }]
          }
        })
      ].join("\n")
    );

    const result = await collectCodexForRegisteredProjects({
      homeDir,
      codexHome,
      targetDate: "2026-06-14"
    });

    expect(result.codexLogsMissing).toBe(false);
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0].signalCount).toBeGreaterThan(0);
    const raw = await readFile(result.successes[0].rawArchiveFile, "utf8");
    expect(raw).toContain("after midnight");
  });

  it("reports codexLogsMissing when no rollout files exist", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-cmd-"));
    const codexHome = join(homeDir, ".codex");
    const projectRoot = await mkdtemp(join(tmpdir(), "codex-proj-"));
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

    const result = await collectCodexForRegisteredProjects({
      homeDir,
      codexHome,
      now: () => "2026-06-14T05:00:00Z"
    });
    expect(result.codexLogsMissing).toBe(true);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("prunes expired raw archives on a no-log day", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-cmd-"));
    const codexHome = join(homeDir, ".codex");
    const projectRoot = await mkdtemp(join(tmpdir(), "codex-proj-"));
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
    // rawRetentionDays=7 with today 2026-06-14 → cutoff 2026-06-08; the older
    // archive must be pruned even though no rollout files exist today.
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify({ rawRetentionDays: 7 })
    );
    const rawDir = join(projectRoot, ".uncommitted", "events", "codex", "raw");
    await mkdir(rawDir, { recursive: true });
    const expired = join(rawDir, "2026-06-01.jsonl");
    const recent = join(rawDir, "2026-06-14.jsonl");
    await writeFile(expired, "{}\n");
    await writeFile(recent, "{}\n");

    const result = await collectCodexForRegisteredProjects({
      homeDir,
      codexHome,
      now: () => "2026-06-14T05:00:00Z"
    });

    expect(result.codexLogsMissing).toBe(true);
    await expect(readFile(expired, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(recent, "utf8")).resolves.toBe("{}\n");
  });

  it("throws no-projects error when registry is empty", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "codex-cmd-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(
      join(homeDir, ".uncommitted", "projects.json"),
      JSON.stringify({ schemaVersion: 1, projects: [] })
    );
    await expect(
      collectCodexForRegisteredProjects({ homeDir })
    ).rejects.toBeInstanceOf(CollectCodexCommandError);
  });
});
