import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectClaudeForRegisteredProjects,
  CollectClaudeCommandError
} from "../src/collect-claude-command.js";

const NOW = () => "2026-06-13T05:00:00.000Z";

async function writeProjectsFile(homeDir: string, projects: unknown) {
  const dir = join(homeDir, ".uncommitted");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), "{}\n");
  await writeFile(
    join(dir, "projects.json"),
    JSON.stringify({ schemaVersion: 1, projects }, null, 2) + "\n"
  );
}

describe("collectClaudeForRegisteredProjects", () => {
  let homeDir: string;
  let claudeHome: string;
  let projectRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "uncommitted-cc-home-"));
    claudeHome = await mkdtemp(join(tmpdir(), "uncommitted-cc-claude-"));
    projectRoot = await mkdtemp(join(tmpdir(), "uncommitted-cc-proj-"));
  });

  afterEach(async () => {
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(claudeHome, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true })
    ]);
  });

  it("reports claudeLogsMissing when ~/.claude/projects is absent and exits cleanly", async () => {
    await writeProjectsFile(homeDir, [
      {
        schemaVersion: 1,
        id: "p1",
        name: "demo",
        root: projectRoot,
        gitRoot: projectRoot,
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]);
    const result = await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW
    });
    expect(result.claudeLogsMissing).toBe(true);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("throws no-projects when projects file is empty", async () => {
    await writeProjectsFile(homeDir, []);
    await expect(
      collectClaudeForRegisteredProjects({ homeDir, claudeHome, now: NOW })
    ).rejects.toBeInstanceOf(CollectClaudeCommandError);
  });

  it("end-to-end: parses, redacts, persists signals + Tier 1 archive for one project", async () => {
    await writeProjectsFile(homeDir, [
      {
        schemaVersion: 1,
        id: "p1",
        name: "demo",
        root: projectRoot,
        gitRoot: projectRoot,
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]);
    const sessionDir = join(claudeHome, "projects", "encoded-project");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "abc.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        cwd: projectRoot,
        timestamp: "2026-06-13T05:00:00.000Z",
        message: { content: "use AKIAIOSFODNN7EXAMPLE in env" }
      }),
      JSON.stringify({
        type: "assistant",
        cwd: projectRoot,
        timestamp: "2026-06-13T05:00:01.000Z",
        message: {
          content: [
            { type: "text", text: "OK" },
            { type: "tool_use", name: "Read", input: { file_path: "src/x.ts" } }
          ]
        }
      })
    ];
    await writeFile(sessionFile, lines.join("\n") + "\n");

    const result = await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW
    });

    expect(result.claudeLogsMissing).toBe(false);
    expect(result.successes).toHaveLength(1);
    const s = result.successes[0];
    expect(s.projectId).toBe("p1");

    const sigText = await readFile(s.signalsFile, "utf8");
    expect(sigText).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sigText.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);

    const rawText = await readFile(s.rawArchiveFile, "utf8");
    expect(rawText).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("attributes a session whose cwd appears after a header record without cwd", async () => {
    await writeProjectsFile(homeDir, [
      {
        schemaVersion: 1,
        id: "p1",
        name: "demo",
        root: projectRoot,
        gitRoot: projectRoot,
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]);
    const sessionDir = join(claudeHome, "projects", "encoded-project");
    await mkdir(sessionDir, { recursive: true });
    const lines = [
      // Header/summary record with no cwd — must not stop the scan.
      JSON.stringify({ type: "summary", summary: "session header" }),
      JSON.stringify({
        type: "user",
        cwd: projectRoot,
        timestamp: "2026-06-13T05:00:00.000Z",
        message: { content: "hello from the project" }
      })
    ];
    await writeFile(join(sessionDir, "abc.jsonl"), lines.join("\n") + "\n");

    const result = await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW
    });
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0].signalCount).toBeGreaterThanOrEqual(1);
    expect(result.successes[0].conversationCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps only target-date entries, dropping other-date Claude work", async () => {
    await writeProjectsFile(homeDir, [
      {
        schemaVersion: 1,
        id: "p1",
        name: "demo",
        root: projectRoot,
        gitRoot: projectRoot,
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]);
    const sessionDir = join(claudeHome, "projects", "encoded-project");
    await mkdir(sessionDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        cwd: projectRoot,
        timestamp: "2026-06-12T23:50:00.000Z",
        message: { content: "yesterday-only Claude work" }
      }),
      JSON.stringify({
        type: "user",
        cwd: projectRoot,
        timestamp: "2026-06-13T00:10:00.000Z",
        message: { content: "today Claude work" }
      })
    ];
    await writeFile(join(sessionDir, "abc.jsonl"), lines.join("\n") + "\n");

    const result = await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW
    });
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0].conversationCount).toBe(1);

    const rawText = await readFile(result.successes[0].rawArchiveFile, "utf8");
    expect(rawText).toContain("today Claude work");
    expect(rawText).not.toContain("yesterday-only Claude work");
  });

  it("skips session files whose cwd does not attribute to a registered project", async () => {
    await writeProjectsFile(homeDir, [
      {
        schemaVersion: 1,
        id: "p1",
        name: "demo",
        root: projectRoot,
        gitRoot: projectRoot,
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]);
    const sessionDir = join(claudeHome, "projects", "encoded-other");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "foreign.jsonl");
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: "user",
        cwd: "/tmp/unrelated-project",
        timestamp: "t",
        message: { content: "hi" }
      }) + "\n"
    );

    const result = await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW
    });
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0].signalCount).toBe(0);
    expect(result.successes[0].conversationCount).toBe(0);
  });
});
