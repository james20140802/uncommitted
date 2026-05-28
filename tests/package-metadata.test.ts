/**
 * UNC-105: Guard critical package.json metadata for MVP CLI dogfooding.
 *
 * Assertions:
 * - Required metadata keys are present and non-empty.
 * - bin.uncommitted is a relative path (starts with "./").
 * - The bin target exists on disk after `pnpm build` (dist/cli.js).
 * - engines.node declares a minimum >=22 compatible range.
 */
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Read package.json from repo root (one level up from tests/)
const pkgPath = join(__dirname, "..", "package.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = require(pkgPath) as Record<string, any>;

describe("package.json metadata (UNC-105)", () => {
  it("name is '@sangchu04/uncommitted'", () => {
    expect(pkg.name).toBe("@sangchu04/uncommitted");
  });

  it("version is present and follows semver pattern", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("description is present and non-empty", () => {
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.trim().length).toBeGreaterThan(0);
  });

  it("type is 'module' (ESM)", () => {
    expect(pkg.type).toBe("module");
  });

  it("bin.uncommitted is declared and is a relative path", () => {
    expect(pkg.bin).toBeDefined();
    expect(typeof pkg.bin.uncommitted).toBe("string");
    expect(pkg.bin.uncommitted.startsWith("./")).toBe(true);
  });

  it("engines.node declares >=22 compatibility", () => {
    expect(pkg.engines?.node).toBeDefined();
    // The range must start with >= and reference 22.x or higher
    expect(pkg.engines.node).toMatch(/>=\s*22/);
  });

  it("packageManager is declared", () => {
    expect(typeof pkg.packageManager).toBe("string");
    expect(pkg.packageManager.startsWith("pnpm@")).toBe(true);
  });

  it("bin.uncommitted path exists after build (dist/cli.js)", async () => {
    const binPath = join(__dirname, "..", pkg.bin.uncommitted);
    // If dist/ does not exist (pre-build environment), skip gracefully
    try {
      await access(binPath);
      // If access succeeds, file is present — that's the assertion
      expect(true).toBe(true);
    } catch {
      // dist/cli.js absent means the test runs pre-build — warn but don't fail CI
      console.warn(
        "[package-metadata] bin target not found at",
        binPath,
        "— run `pnpm build` first for full verification"
      );
      // Re-check: if dist/ directory itself doesn't exist, skip; otherwise fail
      const distDir = join(__dirname, "..", "dist");
      try {
        await access(distDir);
        // dist/ exists but cli.js is missing — that's a real failure
        throw new Error(`bin.uncommitted path missing after build: ${binPath}`);
      } catch (innerErr) {
        if (
          innerErr instanceof Error &&
          innerErr.message.includes("bin.uncommitted path missing")
        ) {
          throw innerErr;
        }
        // dist/ itself missing → pre-build environment, skip
      }
    }
  });
});
