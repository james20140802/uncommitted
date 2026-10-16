import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readPinnedPlaywright(): Promise<string> {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  return pkg.dependencies.playwright ?? "";
}

describe("playwright pin (UNC-284)", () => {
  it("pins playwright to an exact version that matches pnpm-lock.yaml", async () => {
    const pinned = await readPinnedPlaywright();
    const lock = await readFile("pnpm-lock.yaml", "utf8");
    const match = lock.match(
      /\n {6}playwright:\n {8}specifier: ([^\n]+)\n {8}version: ([^\n]+)\n/
    );

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(match?.[1]).toBe(pinned);
    expect(match?.[2]).toBe(pinned);
  });

  it("documents the version-pinned browser install command in the README", async () => {
    const pinned = await readPinnedPlaywright();
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain(`npx playwright@${pinned} install chromium`);
  });
});
