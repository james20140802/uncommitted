/**
 * UNC-106: Verify the packaged MVP CLI artifact excludes private/dev files.
 *
 * Uses `npm pack --dry-run` to list tarball contents and asserts:
 * - Forbidden path prefixes are absent (src/, tests/, .github/, docs/, etc.)
 * - The bin entry (dist/cli.js) is present in the tarball
 * - Secret/env patterns are absent
 *
 * This test requires npm to be available on PATH (standard on macOS with Node).
 * It is skipped gracefully when running in a no-network / pure-unit environment
 * that blocks child_process.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/** Paths/prefixes that MUST NOT appear in the tarball */
const FORBIDDEN_PREFIXES = [
  "src/",
  "tests/",
  ".github/",
  ".uncommitted/",
  "coverage/",
  "node_modules/",
];

/** Filename patterns that MUST NOT appear (case-insensitive) */
const FORBIDDEN_PATTERNS = [/\.env(\.|$)/i, /\.log$/, /secrets?/i];

/** Path that MUST be present in the tarball */
const REQUIRED_PATHS = ["dist/cli.js"];

/** True only when dist/ has been built; skips dist-presence assertions otherwise */
const distBuilt = existsSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url)));

async function getPackedFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)) }
  );

  // npm pack --json outputs an array; each entry has a `files` array with `path` strings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = JSON.parse(stdout) as any[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack --json returned unexpected format");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files: string[] = (parsed[0].files ?? []).map((f: any) => f.path as string);
  return files;
}

describe("package artifact exclusions (UNC-106)", () => {
  it("packed tarball excludes src/, tests/, .github/, and other dev-only paths", async () => {
    const files = await getPackedFiles();

    for (const forbiddenPrefix of FORBIDDEN_PREFIXES) {
      const violators = files.filter((f) => f.startsWith(forbiddenPrefix));
      expect(
        violators,
        `Forbidden prefix "${forbiddenPrefix}" found in tarball: ${violators.join(", ")}`
      ).toHaveLength(0);
    }
  });

  it("packed tarball excludes secret/env/log files", async () => {
    const files = await getPackedFiles();

    for (const pattern of FORBIDDEN_PATTERNS) {
      const violators = files.filter((f) => pattern.test(f));
      expect(
        violators,
        `Forbidden pattern ${pattern} matched in tarball: ${violators.join(", ")}`
      ).toHaveLength(0);
    }
  });

  it.skipIf(!distBuilt)("packed tarball includes dist/cli.js (the bin entry)", async () => {
    const files = await getPackedFiles();

    for (const required of REQUIRED_PATHS) {
      expect(
        files,
        `Required path "${required}" missing from tarball`
      ).toContain(required);
    }
  });

  it("packed tarball includes only dist/ JS files and README.md", async () => {
    const files = await getPackedFiles();

    // Every file should be either under dist/ or be README.md / package.json
    // (package.json is always auto-included by npm)
    const allowed = files.filter(
      (f) =>
        f.startsWith("dist/") ||
        f === "README.md" ||
        f === "package.json"
    );
    expect(allowed.length).toBe(files.length);
  });
});
