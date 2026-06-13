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
