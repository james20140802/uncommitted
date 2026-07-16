import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCoreFacts } from "../src/persona-core-facts.js";

describe("readCoreFacts", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "uncommitted-persona-core-facts-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns [] when persona.json does not exist", async () => {
    await expect(readCoreFacts(homeDir)).resolves.toEqual([]);
  });

  it("returns the coreFacts field when persona.json is present", async () => {
    const memoryDir = join(homeDir, ".uncommitted", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "persona.json"),
      JSON.stringify({ coreFacts: ["prefers TDD", "hates flaky tests"] }),
      "utf8"
    );

    await expect(readCoreFacts(homeDir)).resolves.toEqual([
      "prefers TDD",
      "hates flaky tests"
    ]);
  });

  it("returns [] when the coreFacts field is absent", async () => {
    const memoryDir = join(homeDir, ".uncommitted", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "persona.json"),
      JSON.stringify({ other: "value" }),
      "utf8"
    );

    await expect(readCoreFacts(homeDir)).resolves.toEqual([]);
  });

  it("returns [] when persona.json contains malformed JSON", async () => {
    const memoryDir = join(homeDir, ".uncommitted", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "persona.json"), "{ not json", "utf8");

    await expect(readCoreFacts(homeDir)).resolves.toEqual([]);
  });

  it("filters out non-string entries in coreFacts", async () => {
    const memoryDir = join(homeDir, ".uncommitted", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "persona.json"),
      JSON.stringify({ coreFacts: ["valid", 42, null, "also valid"] }),
      "utf8"
    );

    await expect(readCoreFacts(homeDir)).resolves.toEqual(["valid", "also valid"]);
  });
});
