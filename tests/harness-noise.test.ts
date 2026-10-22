import { describe, it, expect } from "vitest";
import { isHarnessNoise } from "../src/harness-noise.js";

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
