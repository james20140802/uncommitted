import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
const readme = readFileSync(readmePath, "utf8");

// MVP commands listed in CLAUDE.md / AGENTS.md. Each must be documented in the
// README so the "All MVP commands ... are documented" acceptance criterion holds.
const mvpCommandInvocations = [
  "uncommitted init",
  "uncommitted project add",
  "uncommitted project list",
  "uncommitted project remove",
  "uncommitted note",
  "uncommitted note list",
  "uncommitted collect git",
  "uncommitted generate today",
  "uncommitted generate --date",
  "uncommitted render latest",
  "uncommitted preview latest",
  "uncommitted export instagram",
  "uncommitted schedule install",
  "uncommitted schedule status",
  "uncommitted schedule remove",
  "uncommitted schedule run-now"
];

describe("README content", () => {
  it("links the npm version badge to the published package on npmjs.com", () => {
    // Badge image present and the version badge links to the npmjs package page.
    expect(readme).toContain("npmjs.com/package/@sangchu04/uncommitted");
    expect(readme).toMatch(/!\[[^\]]*npm[^\]]*\]\(https?:\/\/[^)]+\)/i);
  });

  it("documents every MVP command from CLAUDE.md", () => {
    const missing = mvpCommandInvocations.filter(
      (command) => !readme.includes(command)
    );
    expect(missing).toEqual([]);
  });

  it("has a Features section describing purpose and output", () => {
    expect(readme).toMatch(/^#{2,3}\s+Features/im);
  });

  it("has an Output section listing generated files", () => {
    expect(readme).toMatch(/^#{2,3}\s+Output/im);
    expect(readme).toContain("caption.txt");
    expect(readme).toContain("story.json");
    expect(readme).toMatch(/carousel/i);
  });

  it("has a Commands reference section", () => {
    expect(readme).toMatch(/^#{2,3}\s+Commands/im);
  });

  it("no longer references the bootstrap phase in the Status section", () => {
    expect(readme.toLowerCase()).not.toContain("bootstrap phase");
  });
});
