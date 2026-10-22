import { describe, it, expect } from "vitest";
import { isHarnessNoise, isMemoryNoiseNote, isToolNameOnlyNote } from "../src/harness-noise.js";

describe("isHarnessNoise", () => {
  it.each([
    "<local-command-caveat>Caveat: x</local-command-caveat>",
    "<local-command-stdout>ok</local-command-stdout>",
    "<command-name>/clear</command-name>",
    "<command-message>review</command-message>",
    "<command-args>42</command-args>",
    "<system-reminder>x</system-reminder>",
    "<task-notification>done</task-notification>",
    "# AGENTS.md instructions for /repo\n\nbody",
    "<INSTRUCTIONS>\nbody",
    '{"risk_level":"low","outcome":"allow","rationale":"x"}',
    "\n[71] tool exec result: Script completed",
    "Agent message from worker-1\nMessage Type: FINAL_ANSWER\nbody",
    "   <system-reminder>leading spaces"
  ])("treats %j as noise", (text) => {
    expect(isHarnessNoise(text)).toBe(true);
  });

  it.each([
    "PR 128 끝까지 봐줘",
    "왜 <system-reminder>가 보이지?",
    '{"foo":1}',
    '{"risk_level":"low"',
    "exec 버그 고쳐줘",
    ""
  ])("keeps %j", (text) => {
    expect(isHarnessNoise(text)).toBe(false);
  });
});

describe("isToolNameOnlyNote", () => {
  it.each([
    "exec",
    " exec ",
    "ToolSearch",
    "mcp__linear-sangchu__get_issue",
    "exec: 6th time",
    "exec (x6)",
    "ToolSearch ×3",
    "Bash",
    "apply_patch",
    "shell"
  ])("treats %j as tool-name-only", (note) => {
    expect(isToolNameOnlyNote(note)).toBe(true);
  });

  it.each(["exec 버그", "Bash src/foo.ts", "Read the docs", "mcp", ""])(
    "keeps %j",
    (note) => {
      expect(isToolNameOnlyNote(note)).toBe(false);
    }
  );
});

describe("isMemoryNoiseNote", () => {
  it("combines harness noise and tool-name-only notes", () => {
    expect(isMemoryNoiseNote("# AGENTS.md instructions for /repo")).toBe(true);
    expect(isMemoryNoiseNote("exec")).toBe(true);
    expect(isMemoryNoiseNote("exec 버그")).toBe(false);
  });
});
