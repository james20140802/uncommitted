import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeClaudeSessionOutputs } from "../src/claude-session-writer.js";

describe("writeClaudeSessionOutputs", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "uncommitted-claude-writer-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes signal jsonl with one line per signal", async () => {
    const result = await writeClaudeSessionOutputs({
      projectRoot: tmpRoot,
      targetDate: "2026-06-13",
      signals: [
        { projectId: "p1", timestamp: "t1", kind: "claude-user-turn", summary: "hi", safetyNotes: [] },
        { projectId: "p1", timestamp: "t2", kind: "claude-tool", summary: "Read x.ts", safetyNotes: [] }
      ],
      conversation: [],
      toolFacts: []
    });

    const text = await readFile(result.signalsFile, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).kind).toBe("claude-user-turn");
    expect(JSON.parse(lines[1]).kind).toBe("claude-tool");
    expect(result.signalsFile).toBe(
      join(tmpRoot, ".uncommitted", "events", "claude", "2026-06-13.jsonl")
    );
  });

  it("writes Tier 1 raw archive with conversation + tool fact lines and chmod 0600", async () => {
    const result = await writeClaudeSessionOutputs({
      projectRoot: tmpRoot,
      targetDate: "2026-06-13",
      signals: [],
      conversation: [
        { role: "user", text: "Implement T4", timestamp: "t1" }
      ],
      toolFacts: [
        { tool: "Write", target: "src/x.ts", timestamp: "t2" }
      ]
    });

    const text = await readFile(result.rawArchiveFile, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({
      kind: "turn",
      role: "user",
      text: "Implement T4",
      timestamp: "t1"
    });
    expect(JSON.parse(lines[1])).toEqual({
      kind: "tool",
      tool: "Write",
      target: "src/x.ts",
      timestamp: "t2"
    });
    expect(result.rawArchiveFile).toBe(
      join(tmpRoot, ".uncommitted", "events", "claude", "raw", "2026-06-13.jsonl")
    );

    const info = await stat(result.rawArchiveFile);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("interleaves conversation and tool facts by timestamp in the raw archive", async () => {
    const result = await writeClaudeSessionOutputs({
      projectRoot: tmpRoot,
      targetDate: "2026-06-13",
      signals: [],
      // A tool fact occurred BEFORE the assistant's closing text. The writer
      // must order by timestamp, not write all turns first then all tools.
      conversation: [
        { role: "user", text: "Do the thing", timestamp: "2026-06-13T05:00:00.000Z" },
        { role: "assistant", text: "Done", timestamp: "2026-06-13T05:00:02.000Z" }
      ],
      toolFacts: [
        { tool: "Read", target: "src/x.ts", timestamp: "2026-06-13T05:00:01.000Z" }
      ]
    });

    const text = await readFile(result.rawArchiveFile, "utf8");
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.kind, l.timestamp])).toEqual([
      ["turn", "2026-06-13T05:00:00.000Z"],
      ["tool", "2026-06-13T05:00:01.000Z"],
      ["turn", "2026-06-13T05:00:02.000Z"]
    ]);
  });

  it("fully rewrites both files on rerun (no stale content)", async () => {
    await writeClaudeSessionOutputs({
      projectRoot: tmpRoot,
      targetDate: "2026-06-13",
      signals: [
        { projectId: "p1", timestamp: "t1", kind: "claude-user-turn", summary: "first", safetyNotes: [] }
      ],
      conversation: [
        { role: "user", text: "first turn", timestamp: "t1" }
      ],
      toolFacts: []
    });

    const result = await writeClaudeSessionOutputs({
      projectRoot: tmpRoot,
      targetDate: "2026-06-13",
      signals: [],
      conversation: [],
      toolFacts: []
    });

    const sigText = await readFile(result.signalsFile, "utf8");
    const rawText = await readFile(result.rawArchiveFile, "utf8");
    expect(sigText).toBe("");
    expect(rawText).toBe("");
  });

  it("creates the events/claude and events/claude/raw directories on demand", async () => {
    const result = await writeClaudeSessionOutputs({
      projectRoot: tmpRoot,
      targetDate: "2026-06-13",
      signals: [],
      conversation: [],
      toolFacts: []
    });
    await stat(result.signalsFile);
    await stat(result.rawArchiveFile);
  });
});
