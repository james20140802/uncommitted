/**
 * UNC-109: Verify docs/release/MVP-CHECKLIST.md exists with all required sections.
 *
 * Checks:
 * - File exists at the expected path
 * - All 7 required sections are present
 * - Validation commands are literally present (copy-pasteable)
 * - Explicit no-auto-publish statement is present
 * - Rollback steps are present
 * - Cross-link back to README is present
 */
import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CHECKLIST_PATH = join(REPO_ROOT, "docs", "release", "MVP-CHECKLIST.md");

let checklist = "";

beforeAll(async () => {
  await access(CHECKLIST_PATH); // throws if missing
  checklist = await readFile(CHECKLIST_PATH, "utf8");
});

describe("MVP release checklist (UNC-109)", () => {
  it("docs/release/MVP-CHECKLIST.md file exists", async () => {
    await expect(access(CHECKLIST_PATH)).resolves.toBeUndefined();
  });

  it("section 1: pre-flight steps are documented", () => {
    expect(checklist).toMatch(/pre.?flight/i);
    expect(checklist).toContain("git status");
    expect(checklist).toContain("git pull");
  });

  it("section 2: validation commands are literally present", () => {
    expect(checklist).toContain("pnpm lint");
    expect(checklist).toContain("pnpm typecheck");
    expect(checklist).toContain("pnpm test");
    expect(checklist).toContain("pnpm build");
  });

  it("section 3: package smoke flow is referenced", () => {
    expect(checklist).toContain("pnpm release:smoke");
    expect(checklist).toMatch(/smoke/i);
  });

  it("section 4: content safety / pack dry-run is referenced", () => {
    expect(checklist).toContain("npm pack --dry-run");
  });

  it("section 5: dogfooding install verification is present", () => {
    expect(checklist).toContain("uncommitted --help");
  });

  it("section 6: version/tag decision steps are present", () => {
    expect(checklist).toContain("git tag");
    expect(checklist).toMatch(/bump.*version|version.*bump/i);
  });

  it("section 7: rollback notes are present", () => {
    expect(checklist).toMatch(/rollback/i);
    expect(checklist).toContain("git tag -d");
  });

  it("explicitly states no auto-publish to npm or Instagram", () => {
    expect(checklist).toMatch(/not published to public npm|no auto.?publish/i);
    expect(checklist).toMatch(/instagram/i);
  });

  it("cross-links to README dogfooding section", () => {
    expect(checklist).toMatch(/README\.md/i);
  });
});
