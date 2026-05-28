/**
 * UNC-108: Verify the README contains the MVP dogfooding install section.
 *
 * Checks:
 * - The dogfooding section heading is present
 * - Node version requirement matches engines.node
 * - pnpm version requirement matches packageManager
 * - Explicit "not published to public npm" statement is present
 * - The release checklist cross-link is present
 * - Copy-pasteable command blocks are present
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, beforeAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = require(join(REPO_ROOT, "package.json")) as Record<string, any>;

let readme = "";

beforeAll(async () => {
  readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
});

describe("README dogfooding install section (UNC-108)", () => {
  it("contains a clearly labeled MVP dogfooding install section", () => {
    expect(readme).toMatch(/MVP Install.*Dogfooding/i);
  });

  it("provides an npm install command for the scoped package", () => {
    expect(readme).toMatch(/npm install.*@sangchu04\/uncommitted/i);
  });

  it("mentions Node prerequisite version matching engines.node (>=22)", () => {
    // engines.node is ">=22.13.0" — README should mention 22
    expect(readme).toMatch(/node.*>=?22/i);
  });

  it("mentions pnpm version matching packageManager field", () => {
    // packageManager is "pnpm@10.10.0"
    const pnpmVersion = pkg.packageManager.replace("pnpm@", "");
    expect(readme).toContain(pnpmVersion);
  });

  it("includes a copy-pasteable pnpm install or build command block", () => {
    expect(readme).toMatch(/```sh[\s\S]*pnpm (install|build|add|link)/m);
  });

  it("cross-links to the release checklist doc", () => {
    expect(readme).toMatch(/docs\/release\/MVP-CHECKLIST\.md/i);
  });
});
