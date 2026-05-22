/**
 * UNC-107: Integration check for the pack-smoke script.
 *
 * Validates that scripts/release/pack-smoke.sh:
 * - Exists and is executable
 * - When executed, exits 0 (end-to-end: build → pack → isolated install → --help)
 *
 * The end-to-end test is SKIPPED by default in `pnpm test` because the script
 * mutates the filesystem (rm -rf dist, npm pack) and conflicts with parallel
 * test workers that also read dist/. To run the full integration test:
 *
 *   SMOKE=1 pnpm test tests/pack-smoke.test.ts   (explicit opt-in)
 *   pnpm release:smoke                            (run the script directly)
 */
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "release", "pack-smoke.sh");

// Default: skip the end-to-end integration test in normal `pnpm test` runs
// because the script mutates the filesystem (rm -rf dist, npm pack) and
// conflicts with parallel test workers that also read dist/.
// Run explicitly with: SMOKE=1 pnpm test tests/pack-smoke.test.ts
const SKIP = !process.env["SMOKE"];

describe("pack-smoke script (UNC-107)", () => {
  it("scripts/release/pack-smoke.sh exists and is executable", async () => {
    await expect(
      access(SCRIPT_PATH, constants.F_OK | constants.X_OK)
    ).resolves.toBeUndefined();
  });

  it.skipIf(SKIP)(
    "smoke script exits 0: build → pack → isolated install → --help",
    async () => {
      const { stdout, stderr } = await execFileAsync(
        "bash",
        [SCRIPT_PATH],
        {
          cwd: REPO_ROOT,
          timeout: 120_000, // 2 minutes — pnpm add can be slow
          env: { ...process.env, CI: "1" },
        }
      );
      const combined = stdout + stderr;
      expect(combined).toMatch(/SMOKE TEST PASSED/i);
    },
    130_000 // vitest timeout slightly above execFile timeout
  );
});
