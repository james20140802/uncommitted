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

  it("prunes expired raw archives on a no-log day", async () => {
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
    // rawRetentionDays=7 with today 2026-06-13 → cutoff 2026-06-07; anything
    // strictly older must be pruned even when no session logs are collected.
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify({ rawRetentionDays: 7 })
    );
    const rawDir = join(projectRoot, ".uncommitted", "events", "claude", "raw");
    await mkdir(rawDir, { recursive: true });
    const expired = join(rawDir, "2026-06-01.jsonl");
    const recent = join(rawDir, "2026-06-13.jsonl");
    await writeFile(expired, "{}\n");
    await writeFile(recent, "{}\n");

    const result = await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW
    });

    expect(result.claudeLogsMissing).toBe(true);
    await expect(readFile(expired, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(recent, "utf8")).resolves.toBe("{}\n");
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

  describe("--date targeting and empty-result preservation", () => {
    const project = () => ({
      schemaVersion: 1,
      id: "p1",
      name: "demo",
      root: projectRoot,
      gitRoot: projectRoot,
      enabled: true,
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    async function writeSession(entries: Array<[string, string]>) {
      const sessionDir = join(claudeHome, "projects", "encoded-project");
      await mkdir(sessionDir, { recursive: true });
      const lines = entries.map(([timestamp, text]) =>
        JSON.stringify({
          type: "user",
          cwd: projectRoot,
          timestamp,
          message: { content: text }
        })
      );
      await writeFile(join(sessionDir, "abc.jsonl"), lines.join("\n") + "\n");
    }

    const eventsDir = () => join(projectRoot, ".uncommitted", "events", "claude");

    async function preWrite(signals: string, raw: string) {
      await mkdir(join(eventsDir(), "raw"), { recursive: true });
      await writeFile(join(eventsDir(), "2026-10-10.jsonl"), signals);
      await writeFile(join(eventsDir(), "raw", "2026-10-10.jsonl"), raw);
    }

    it("collects entries for an explicit --date even when now is the next day", async () => {
      await writeProjectsFile(homeDir, [project()]);
      await writeSession([
        ["2026-10-10T10:00:00.000Z", "past-day Claude work"],
        ["2026-10-11T01:00:00.000Z", "next-day Claude work"]
      ]);

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z",
        targetDate: "2026-10-10"
      });

      expect(result.targetDate).toBe("2026-10-10");
      expect(result.successes[0].conversationCount).toBe(1);
      expect(result.successes[0].signalsFile.endsWith("2026-10-10.jsonl")).toBe(true);
      const rawText = await readFile(result.successes[0].rawArchiveFile, "utf8");
      expect(rawText).toContain("past-day Claude work");
      expect(rawText).not.toContain("next-day Claude work");
    });

    it("defaults to the now date when targetDate is omitted", async () => {
      await writeProjectsFile(homeDir, [project()]);
      await writeSession([
        ["2026-10-10T10:00:00.000Z", "past-day Claude work"],
        ["2026-10-11T01:00:00.000Z", "next-day Claude work"]
      ]);

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z"
      });

      expect(result.targetDate).toBe("2026-10-11");
      const rawText = await readFile(result.successes[0].rawArchiveFile, "utf8");
      expect(rawText).toContain("next-day Claude work");
      expect(rawText).not.toContain("past-day Claude work");
    });

    it("rejects a malformed targetDate with invalid-date", async () => {
      await writeProjectsFile(homeDir, [project()]);
      const promise = collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: NOW,
        targetDate: "2026/10/10"
      });
      await expect(promise).rejects.toMatchObject({ code: "invalid-date" });
      await expect(promise).rejects.toBeInstanceOf(CollectClaudeCommandError);
    });

    it("keeps existing signals when a re-collection finds nothing", async () => {
      await writeProjectsFile(homeDir, [project()]);
      const oldSignal = JSON.stringify({ id: "old" }) + "\n";
      await preWrite(oldSignal, "old raw");
      await writeSession([["2026-10-11T01:00:00.000Z", "next-day Claude work"]]);

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z",
        targetDate: "2026-10-10"
      });

      expect(result.successes[0].preservedExisting).toBe(true);
      expect(await readFile(join(eventsDir(), "2026-10-10.jsonl"), "utf8")).toBe(
        oldSignal
      );
      expect(
        await readFile(join(eventsDir(), "raw", "2026-10-10.jsonl"), "utf8")
      ).toBe("old raw");
    });

    it("overwrites when the re-collection finds signals", async () => {
      await writeProjectsFile(homeDir, [project()]);
      await preWrite("stale\n", "old raw");
      await writeSession([["2026-10-10T10:00:00.000Z", "past-day Claude work"]]);

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z",
        targetDate: "2026-10-10"
      });

      expect(result.successes[0].preservedExisting).toBe(false);
      const signals = await readFile(join(eventsDir(), "2026-10-10.jsonl"), "utf8");
      expect(signals).not.toContain("stale");
    });

    it("saves new raw content while keeping existing signals when only raw is found", async () => {
      await writeProjectsFile(homeDir, [project()]);
      const oldSignal = JSON.stringify({ id: "old" }) + "\n";
      await preWrite(oldSignal, "old raw");
      // An assistant thinking block lands in the raw archive but emits no signal.
      const sessionDir = join(claudeHome, "projects", "encoded-project");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "abc.jsonl"),
        JSON.stringify({
          type: "assistant",
          cwd: projectRoot,
          timestamp: "2026-10-10T10:00:00.000Z",
          message: { content: [{ type: "thinking", thinking: "raw-only thought" }] }
        }) + "\n"
      );

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z",
        targetDate: "2026-10-10"
      });

      expect(result.successes[0].signalCount).toBe(0);
      expect(result.successes[0].conversationCount).toBe(1);
      expect(await readFile(join(eventsDir(), "2026-10-10.jsonl"), "utf8")).toBe(
        oldSignal
      );
      expect(
        await readFile(join(eventsDir(), "raw", "2026-10-10.jsonl"), "utf8")
      ).toContain("raw-only thought");
    });

    it("keeps an existing raw archive when a re-collection finds no raw content", async () => {
      await writeProjectsFile(homeDir, [project()]);
      await preWrite("", "old raw");
      await writeSession([["2026-10-11T01:00:00.000Z", "next-day Claude work"]]);

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z",
        targetDate: "2026-10-10"
      });

      expect(result.successes[0].preservedExisting).toBe(true);
      expect(
        await readFile(join(eventsDir(), "raw", "2026-10-10.jsonl"), "utf8")
      ).toBe("old raw");
    });

    it("writes an empty file without preserving when no prior signals exist", async () => {
      await writeProjectsFile(homeDir, [project()]);
      await writeSession([["2026-10-11T01:00:00.000Z", "next-day Claude work"]]);

      const result = await collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: () => "2026-10-11T02:51:00.000Z",
        targetDate: "2026-10-10"
      });

      expect(result.successes[0].preservedExisting).toBe(false);
      expect(await readFile(result.successes[0].signalsFile, "utf8")).toBe("");
    });
  });

  it("rejects an empty targetDate instead of falling back to today", async () => {
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
    await expect(
      collectClaudeForRegisteredProjects({
        homeDir,
        claudeHome,
        now: NOW,
        targetDate: ""
      })
    ).rejects.toMatchObject({ code: "invalid-date" });
  });

  it("anchors raw-archive retention on the real date, not a future --date", async () => {
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
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify({ rawRetentionDays: 7 })
    );
    const rawDir = join(projectRoot, ".uncommitted", "events", "claude", "raw");
    await mkdir(rawDir, { recursive: true });
    const recent = join(rawDir, "2026-06-12.jsonl");
    await writeFile(recent, "{}\n");

    // A year typo must not move the retention cutoff to 2027 and wipe archives.
    await collectClaudeForRegisteredProjects({
      homeDir,
      claudeHome,
      now: NOW,
      targetDate: "2027-06-13"
    });

    await expect(readFile(recent, "utf8")).resolves.toBe("{}\n");
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
