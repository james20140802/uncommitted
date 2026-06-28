import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneRawArchives,
  readRawRetentionDays,
  type RawArchiveSource
} from "../src/raw-archive-prune.js";

async function makeProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "unc-170-"));
}

async function seedRawFile(
  projectRoot: string,
  source: RawArchiveSource,
  name: string,
  body = "{}\n"
): Promise<string> {
  const rawDir = join(projectRoot, ".uncommitted", "events", source, "raw");
  await mkdir(rawDir, { recursive: true });
  const file = join(rawDir, name);
  await writeFile(file, body, "utf8");
  return file;
}

describe("pruneRawArchives", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await makeProjectRoot();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("deletes files strictly older than today minus retentionDays and keeps the rest", async () => {
    await seedRawFile(projectRoot, "claude", "2026-06-20.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-21.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-22.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-23.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-24.jsonl");

    const result = await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 3
    });

    const remaining = await readdir(
      join(projectRoot, ".uncommitted", "events", "claude", "raw")
    );
    expect(remaining.sort()).toEqual([
      "2026-06-22.jsonl",
      "2026-06-23.jsonl",
      "2026-06-24.jsonl"
    ]);
    expect(result.deletedFiles.map((f) => f.split("/").pop()!).sort()).toEqual([
      "2026-06-20.jsonl",
      "2026-06-21.jsonl"
    ]);
    expect(result.errors).toEqual([]);
  });

  it("treats retentionDays of 0 as unlimited and deletes nothing", async () => {
    await seedRawFile(projectRoot, "codex", "2020-01-01.jsonl");
    await seedRawFile(projectRoot, "codex", "2026-06-24.jsonl");

    const result = await pruneRawArchives({
      projectRoot,
      source: "codex",
      today: "2026-06-24",
      retentionDays: 0
    });

    const remaining = await readdir(
      join(projectRoot, ".uncommitted", "events", "codex", "raw")
    );
    expect(remaining.sort()).toEqual(["2020-01-01.jsonl", "2026-06-24.jsonl"]);
    expect(result.deletedFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("treats negative retentionDays as unlimited and deletes nothing", async () => {
    await seedRawFile(projectRoot, "github", "2020-01-01.jsonl");

    const result = await pruneRawArchives({
      projectRoot,
      source: "github",
      today: "2026-06-24",
      retentionDays: -5
    });

    const remaining = await readdir(
      join(projectRoot, ".uncommitted", "events", "github", "raw")
    );
    expect(remaining).toEqual(["2020-01-01.jsonl"]);
    expect(result.deletedFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("returns no-op when the raw directory does not exist", async () => {
    const result = await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 7
    });

    expect(result.deletedFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("returns no-op when the raw directory exists but is empty", async () => {
    const rawDir = join(projectRoot, ".uncommitted", "events", "claude", "raw");
    await mkdir(rawDir, { recursive: true });

    const result = await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 7
    });

    expect(result.deletedFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips files whose name is not a valid YYYY-MM-DD date and never deletes them", async () => {
    await seedRawFile(projectRoot, "claude", "notes.txt");
    await seedRawFile(projectRoot, "claude", "2026.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-13-01.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-32.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-20.jsonl");

    const result = await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 3
    });

    const remaining = await readdir(
      join(projectRoot, ".uncommitted", "events", "claude", "raw")
    );
    expect(remaining.sort()).toEqual([
      "2026-06-32.jsonl",
      "2026-13-01.jsonl",
      "2026.jsonl",
      "notes.txt"
    ]);
    expect(result.deletedFiles.map((f) => f.split("/").pop()!)).toEqual([
      "2026-06-20.jsonl"
    ]);
    expect(result.errors).toEqual([]);
  });

  it("deletes both .jsonl and .jsonl.gz variants by filename date", async () => {
    await seedRawFile(projectRoot, "codex", "2026-06-20.jsonl");
    await seedRawFile(projectRoot, "codex", "2026-06-20.jsonl.gz");
    await seedRawFile(projectRoot, "codex", "2026-06-23.jsonl.gz");

    const result = await pruneRawArchives({
      projectRoot,
      source: "codex",
      today: "2026-06-24",
      retentionDays: 2
    });

    const remaining = await readdir(
      join(projectRoot, ".uncommitted", "events", "codex", "raw")
    );
    expect(remaining.sort()).toEqual(["2026-06-23.jsonl.gz"]);
    expect(result.deletedFiles.map((f) => f.split("/").pop()!).sort()).toEqual([
      "2026-06-20.jsonl",
      "2026-06-20.jsonl.gz"
    ]);
    expect(result.errors).toEqual([]);
  });

  it("keeps only today's file and deletes yesterday's file when retentionDays=1", async () => {
    // retentionDays=1 means "keep files within the last 1 day window including
    // today" => cutoff = today - 0 days = today; keep today and newer, delete
    // strictly older. Spec consensus: a positive N keeps the most recent N
    // days INCLUDING today, so N=1 keeps only today and deletes yesterday.
    await seedRawFile(projectRoot, "claude", "2026-06-23.jsonl");
    await seedRawFile(projectRoot, "claude", "2026-06-24.jsonl");

    const result = await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 1
    });

    const remaining = await readdir(
      join(projectRoot, ".uncommitted", "events", "claude", "raw")
    );
    expect(remaining).toEqual(["2026-06-24.jsonl"]);
    expect(result.deletedFiles.map((f) => f.split("/").pop()!)).toEqual([
      "2026-06-23.jsonl"
    ]);
  });

  it("touches only the specified source's raw directory", async () => {
    await seedRawFile(projectRoot, "claude", "2020-01-01.jsonl");
    await seedRawFile(projectRoot, "codex", "2020-01-01.jsonl");
    await seedRawFile(projectRoot, "github", "2020-01-01.jsonl");

    await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 7
    });

    expect(
      await readdir(join(projectRoot, ".uncommitted", "events", "codex", "raw"))
    ).toEqual(["2020-01-01.jsonl"]);
    expect(
      await readdir(join(projectRoot, ".uncommitted", "events", "github", "raw"))
    ).toEqual(["2020-01-01.jsonl"]);
  });

  it("does not touch sibling canonical signal files outside raw/", async () => {
    const eventsDir = join(projectRoot, ".uncommitted", "events", "claude");
    await mkdir(eventsDir, { recursive: true });
    const canonical = join(eventsDir, "2020-01-01.jsonl");
    await writeFile(canonical, "{}\n", "utf8");
    await seedRawFile(projectRoot, "claude", "2020-01-01.jsonl");

    await pruneRawArchives({
      projectRoot,
      source: "claude",
      today: "2026-06-24",
      retentionDays: 7
    });

    expect(await readdir(eventsDir)).toEqual(
      expect.arrayContaining(["2020-01-01.jsonl", "raw"])
    );
  });
});

describe("readRawRetentionDays", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unc-170-cfg-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 0 when the config file is missing", async () => {
    expect(await readRawRetentionDays(join(dir, "missing.json"))).toBe(0);
  });

  it("returns 0 when the config file is malformed JSON", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, "{not json", "utf8");
    expect(await readRawRetentionDays(file)).toBe(0);
  });

  it("returns 0 when the field is absent", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ other: 1 }), "utf8");
    expect(await readRawRetentionDays(file)).toBe(0);
  });

  it("returns 0 when the field is non-numeric", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ rawRetentionDays: "thirty" }), "utf8");
    expect(await readRawRetentionDays(file)).toBe(0);
  });

  it("returns 0 when the field is negative", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ rawRetentionDays: -5 }), "utf8");
    expect(await readRawRetentionDays(file)).toBe(0);
  });

  it("returns the integer value when the field is a positive integer", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ rawRetentionDays: 30 }), "utf8");
    expect(await readRawRetentionDays(file)).toBe(30);
  });

  it("floors a positive non-integer to an integer", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ rawRetentionDays: 7.9 }), "utf8");
    expect(await readRawRetentionDays(file)).toBe(7);
  });
});
