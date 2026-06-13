// tests/codex-session-writer.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCodexSessionOutputs } from "../src/codex-session-writer.js";

async function tmpProject() {
  return mkdtemp(join(tmpdir(), "codex-writer-"));
}

describe("writeCodexSessionOutputs", () => {
  it("writes signals JSONL and raw archive with 0600 mode", async () => {
    const root = await tmpProject();
    const result = await writeCodexSessionOutputs({
      projectRoot: root,
      targetDate: "2026-06-14",
      signals: [
        {
          projectId: "p1",
          timestamp: "2026-06-14T01:00:00Z",
          kind: "codex-user-turn",
          summary: "hi",
          safetyNotes: []
        }
      ],
      conversation: [
        { role: "user", text: "hi", timestamp: "2026-06-14T01:00:00Z" }
      ],
      toolFacts: [
        { tool: "read_file", target: "/src/a.ts", timestamp: "2026-06-14T01:00:01Z" }
      ]
    });

    expect(result.signalsFile.endsWith("events/codex/2026-06-14.jsonl")).toBe(true);
    expect(result.rawArchiveFile.endsWith("events/codex/raw/2026-06-14.jsonl")).toBe(
      true
    );

    const signals = await readFile(result.signalsFile, "utf8");
    expect(signals.trim().split("\n")).toHaveLength(1);

    const raw = await readFile(result.rawArchiveFile, "utf8");
    const rawLines = raw.trim().split("\n");
    expect(rawLines).toHaveLength(2);
    expect(JSON.parse(rawLines[0]).kind).toBe("turn");
    expect(JSON.parse(rawLines[1]).kind).toBe("tool");

    const info = await stat(result.rawArchiveFile);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("interleaves conversation and tool facts by timestamp", async () => {
    const root = await tmpProject();
    const result = await writeCodexSessionOutputs({
      projectRoot: root,
      targetDate: "2026-06-14",
      signals: [],
      conversation: [
        { role: "user", text: "u1", timestamp: "2026-06-14T01:00:00Z" },
        { role: "assistant", text: "a1", timestamp: "2026-06-14T01:00:02Z" }
      ],
      toolFacts: [
        { tool: "read_file", target: "/a", timestamp: "2026-06-14T01:00:01Z" }
      ]
    });
    const lines = (await readFile(result.rawArchiveFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.timestamp)).toEqual([
      "2026-06-14T01:00:00Z",
      "2026-06-14T01:00:01Z",
      "2026-06-14T01:00:02Z"
    ]);
  });

  it("writes empty files when no signals/conversation", async () => {
    const root = await tmpProject();
    const result = await writeCodexSessionOutputs({
      projectRoot: root,
      targetDate: "2026-06-14",
      signals: [],
      conversation: [],
      toolFacts: []
    });
    expect((await readFile(result.signalsFile, "utf8")).length).toBe(0);
    expect((await readFile(result.rawArchiveFile, "utf8")).length).toBe(0);
  });
});
