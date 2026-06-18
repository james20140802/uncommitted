import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGitHubEvents } from "../src/github-event-writer.js";

const targetDate = "2026-06-17";

describe("writeGitHubEvents", () => {
  it("writes signal JSONL and raw archive in canonical paths", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-writer-"));
    const result = await writeGitHubEvents({
      projectRoot,
      targetDate,
      signals: [
        { projectId: "p", timestamp: "2026-06-17T05:00:00Z", kind: "pr",
          summary: "PR #1 merged: x", safetyNotes: [] }
      ],
      ownAuthoredBodies: [
        { source: "pr-body", number: 1, visibility: "public",
          timestamp: "2026-06-17T05:00:00Z", text: "body" }
      ]
    });
    expect(result.signalsFile).toBe(join(projectRoot, ".uncommitted", "events", "github", `${targetDate}.jsonl`));
    expect(result.rawArchiveFile).toBe(join(projectRoot, ".uncommitted", "events", "github", "raw", `${targetDate}.jsonl`));
    expect((await readFile(result.signalsFile, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readFile(result.rawArchiveFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("writes raw archive with 0600 permissions", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-writer-"));
    const result = await writeGitHubEvents({
      projectRoot, targetDate, signals: [],
      ownAuthoredBodies: [
        { source: "pr-body", number: 1, visibility: "private",
          timestamp: "2026-06-17T05:00:00Z", text: "secret-ish" }
      ]
    });
    const s = await stat(result.rawArchiveFile);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("overwrites existing day files (full-rewrite, not append)", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-writer-"));
    await mkdir(join(projectRoot, ".uncommitted", "events", "github"), { recursive: true });
    await writeFile(
      join(projectRoot, ".uncommitted", "events", "github", `${targetDate}.jsonl`),
      "stale\nstale\n"
    );
    await writeGitHubEvents({
      projectRoot, targetDate,
      signals: [{ projectId: "p", timestamp: "x", kind: "pr", summary: "fresh", safetyNotes: [] }],
      ownAuthoredBodies: []
    });
    const contents = await readFile(
      join(projectRoot, ".uncommitted", "events", "github", `${targetDate}.jsonl`), "utf8"
    );
    expect(contents).not.toContain("stale");
    expect(contents).toContain("fresh");
  });

  it("does not replace an existing good signal file when the raw archive write fails", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-writer-"));
    const baseDir = join(projectRoot, ".uncommitted", "events", "github");
    const rawDir = join(baseDir, "raw");
    await mkdir(rawDir, { recursive: true });
    // A previous successful collection left a good signal file in place.
    const signalsFile = join(baseDir, `${targetDate}.jsonl`);
    await writeFile(signalsFile, "good-prior-signal\n");
    // Make the raw archive write fail (no write permission on the raw dir).
    await chmod(rawDir, 0o500);

    try {
      await expect(
        writeGitHubEvents({
          projectRoot,
          targetDate,
          signals: [
            { projectId: "p", timestamp: "x", kind: "pr", summary: "fresh", safetyNotes: [] }
          ],
          ownAuthoredBodies: [
            { source: "pr-body", number: 1, visibility: "private",
              timestamp: "2026-06-17T05:00:00Z", text: "body" }
          ]
        })
      ).rejects.toBeTruthy();
      // The canonical signal file must be untouched: raw archive is written first.
      expect(await readFile(signalsFile, "utf8")).toBe("good-prior-signal\n");
    } finally {
      await chmod(rawDir, 0o700);
    }
  });

  it("does not write empty files when no signals or bodies are supplied", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "gh-writer-"));
    const result = await writeGitHubEvents({
      projectRoot, targetDate, signals: [], ownAuthoredBodies: []
    });
    expect((await readFile(result.signalsFile, "utf8"))).toBe("");
    expect((await readFile(result.rawArchiveFile, "utf8"))).toBe("");
  });
});
