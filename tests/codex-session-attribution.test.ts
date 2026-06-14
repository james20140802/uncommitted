// tests/codex-session-attribution.test.ts
import { describe, it, expect } from "vitest";
import { readCodexSessionCwd } from "../src/codex-session-attribution.js";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function tmpFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-attr-"));
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, content);
  return path;
}

describe("readCodexSessionCwd", () => {
  it("returns the cwd from session_meta.payload.cwd", async () => {
    const line = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/repo/my-project", id: "x" }
    });
    expect(await readCodexSessionCwd(await tmpFile(line))).toBe(
      "/repo/my-project"
    );
  });

  it("falls back to turn_context.cwd", async () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "no-cwd" } }),
      JSON.stringify({ type: "turn_context", payload: { cwd: "/repo/fallback" } })
    ].join("\n");
    expect(await readCodexSessionCwd(await tmpFile(lines))).toBe("/repo/fallback");
  });

  it("returns null when no cwd is present", async () => {
    const line = JSON.stringify({ type: "session_meta", payload: { id: "x" } });
    expect(await readCodexSessionCwd(await tmpFile(line))).toBeNull();
  });

  it("skips malformed JSON lines", async () => {
    const lines = [
      "garbage",
      JSON.stringify({ type: "session_meta", payload: { cwd: "/ok" } })
    ].join("\n");
    expect(await readCodexSessionCwd(await tmpFile(lines))).toBe("/ok");
  });
});
