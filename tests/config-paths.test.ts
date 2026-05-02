import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureConfigDirectories,
  expandHomePath,
  resolveConfigPaths
} from "../src/config-paths.js";

describe("config path utilities", () => {
  it("resolves global config file paths from a provided home directory", () => {
    const homeDir = "/tmp/uncommitted-home";

    const paths = resolveConfigPaths({ homeDir });

    expect(paths.configDir).toBe(join(homeDir, ".uncommitted"));
    expect(paths.configFile).toBe(join(homeDir, ".uncommitted", "config.json"));
    expect(paths.projectsFile).toBe(join(homeDir, ".uncommitted", "projects.json"));
    expect(paths.historyDir).toBe(join(homeDir, ".uncommitted", "history"));
    expect(paths.formatHistoryFile).toBe(
      join(homeDir, ".uncommitted", "history", "formats.json")
    );
  });

  it("expands tilde-prefixed paths without hardcoding a user home", () => {
    const homeDir = "/tmp/someone";

    expect(expandHomePath("~", homeDir)).toBe(homeDir);
    expect(expandHomePath("~/Uncommitted/drafts", homeDir)).toBe(
      join(homeDir, "Uncommitted", "drafts")
    );
    expect(expandHomePath("/var/tmp/uncommitted", homeDir)).toBe("/var/tmp/uncommitted");
  });

  it("resolves the default and configured draft roots", () => {
    const homeDir = "/tmp/uncommitted-home";

    expect(resolveConfigPaths({ homeDir }).defaultDraftRoot).toBe(
      join(homeDir, "Uncommitted", "drafts")
    );
    expect(
      resolveConfigPaths({ homeDir, draftRoot: "~/custom-drafts" }).defaultDraftRoot
    ).toBe(join(homeDir, "custom-drafts"));
  });

  it("resolves relative draft roots from the home directory", () => {
    const homeDir = "/tmp/uncommitted-home";

    expect(
      resolveConfigPaths({ homeDir, draftRoot: "relative-drafts" }).defaultDraftRoot
    ).toBe(join(homeDir, "relative-drafts"));
  });

  it("creates required directories recursively", async () => {
    const root = await mkTestRoot();
    const paths = resolveConfigPaths({
      homeDir: join(root, "home"),
      draftRoot: "~/draft-output"
    });

    await ensureConfigDirectories(paths);

    await expectDirectory(paths.configDir);
    await expectDirectory(paths.historyDir);
    await expectDirectory(paths.globalDraftsDir);
    await expectDirectory(paths.logsDir);
    await expectDirectory(paths.defaultDraftRoot);
  });
});

async function mkTestRoot(): Promise<string> {
  const root = join(process.cwd(), "node_modules", ".tmp", "config-paths");
  await mkdir(root, { recursive: true });
  return root;
}

async function expectDirectory(path: string): Promise<void> {
  await expect(stat(path).then((stats) => stats.isDirectory())).resolves.toBe(true);
}
