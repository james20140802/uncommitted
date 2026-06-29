import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearGlobalConfigCache,
  isRoastLevel,
  loadGlobalConfig,
  selectDraftRoot,
  selectGitHubToken
} from "../src/global-config.js";

let homeDir: string;
let configFile: string;

beforeEach(async () => {
  clearGlobalConfigCache();
  homeDir = await mkdtemp(join(tmpdir(), "global-config-"));
  configFile = join(homeDir, "config.json");
});

afterEach(async () => {
  clearGlobalConfigCache();
  await rm(homeDir, { recursive: true, force: true });
});

describe("loadGlobalConfig", () => {
  it("reports missing when the config file does not exist", async () => {
    const outcome = await loadGlobalConfig(configFile);
    expect(outcome.status).toBe("missing");
  });

  it("reports parse-error for malformed JSON", async () => {
    await writeFile(configFile, "{ not json");
    const outcome = await loadGlobalConfig(configFile);
    expect(outcome.status).toBe("parse-error");
  });

  it("reports read-error for a non-ENOENT failure", async () => {
    // A directory at the config path triggers EISDIR, not ENOENT.
    await mkdir(configFile);
    const outcome = await loadGlobalConfig(configFile);
    expect(outcome.status).toBe("read-error");
  });

  it("returns the parsed value for a valid config", async () => {
    await writeFile(configFile, JSON.stringify({ draftRoot: "~/x", roastLevel: 2 }));
    const outcome = await loadGlobalConfig(configFile);
    expect(outcome).toEqual({
      status: "ok",
      value: { draftRoot: "~/x", roastLevel: 2 }
    });
  });

  it("caches successful reads so later calls do not touch disk", async () => {
    await writeFile(configFile, JSON.stringify({ draftRoot: "~/x" }));
    const first = await loadGlobalConfig(configFile);
    // Removing the file would make a fresh read report "missing"; the cached
    // value must survive, proving the second call did not re-read disk.
    await rm(configFile, { force: true });
    const second = await loadGlobalConfig(configFile);
    expect(second).toEqual(first);
    expect(second).toEqual({ status: "ok", value: { draftRoot: "~/x" } });
  });

  it("does not cache a missing outcome, so a later write is observed", async () => {
    expect((await loadGlobalConfig(configFile)).status).toBe("missing");
    await writeFile(configFile, JSON.stringify({ draftRoot: "~/late" }));
    const outcome = await loadGlobalConfig(configFile);
    expect(outcome).toEqual({ status: "ok", value: { draftRoot: "~/late" } });
  });
});

describe("selectors", () => {
  it("selectDraftRoot returns the draftRoot string or undefined", () => {
    expect(selectDraftRoot({ draftRoot: "~/Uncommitted" })).toBe("~/Uncommitted");
    expect(selectDraftRoot({})).toBeUndefined();
    expect(selectDraftRoot({ draftRoot: 5 })).toBeUndefined();
    expect(selectDraftRoot([])).toBeUndefined();
    expect(selectDraftRoot(42)).toBeUndefined();
  });

  it("selectGitHubToken returns a non-empty token or null", () => {
    expect(selectGitHubToken({ githubToken: "ghp_x" })).toBe("ghp_x");
    expect(selectGitHubToken({ githubToken: "" })).toBeNull();
    expect(selectGitHubToken({})).toBeNull();
    expect(selectGitHubToken({ githubToken: 1 })).toBeNull();
    expect(selectGitHubToken(null)).toBeNull();
  });
});

describe("isRoastLevel", () => {
  it("accepts integers 0 through 5", () => {
    for (const level of [0, 1, 2, 3, 4, 5]) {
      expect(isRoastLevel(level)).toBe(true);
    }
  });

  it("rejects out-of-range, fractional, and non-number values", () => {
    expect(isRoastLevel(-1)).toBe(false);
    expect(isRoastLevel(6)).toBe(false);
    expect(isRoastLevel(2.5)).toBe(false);
    expect(isRoastLevel("3")).toBe(false);
    expect(isRoastLevel(undefined)).toBe(false);
  });
});
