import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RevisionFormatError,
  resolveLatestRevForDate,
  resolveSpecificRev
} from "../src/draft-revision-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDraftRoot(): Promise<string> {
  const root = join(tmpdir(), `draft-revision-resolver-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function makeRevDir(
  draftRoot: string,
  targetDate: string,
  revision: string
): Promise<string> {
  const outputDir = join(draftRoot, targetDate, revision);
  await mkdir(outputDir, { recursive: true });
  // Drop a sentinel file so a future readdir on the rev dir would see content.
  await writeFile(join(outputDir, ".sentinel"), "", "utf8");
  return outputDir;
}

// ---------------------------------------------------------------------------
// resolveLatestRevForDate
// ---------------------------------------------------------------------------

describe("resolveLatestRevForDate", () => {
  it("returns the highest rev when a date has multiple revisions", async () => {
    const draftRoot = await createDraftRoot();
    await makeRevDir(draftRoot, "2026-06-01", "rev-001");
    await makeRevDir(draftRoot, "2026-06-01", "rev-002");
    const expectedDir = await makeRevDir(draftRoot, "2026-06-01", "rev-003");

    const result = await resolveLatestRevForDate(draftRoot, "2026-06-01");

    expect(result).not.toBeNull();
    expect(result!.revision).toBe("rev-003");
    expect(result!.outputDir).toBe(expectedDir);
  });

  it("returns null when the date directory does not exist (ENOENT)", async () => {
    const draftRoot = await createDraftRoot();

    const result = await resolveLatestRevForDate(draftRoot, "2026-06-01");

    expect(result).toBeNull();
  });

  it("returns null when the date directory has no rev-NNN entries", async () => {
    const draftRoot = await createDraftRoot();
    const dateDir = join(draftRoot, "2026-06-01");
    await mkdir(dateDir, { recursive: true });
    // Non-rev entries should be ignored.
    await mkdir(join(dateDir, "scratch"), { recursive: true });
    await writeFile(join(dateDir, "notes.txt"), "ignore", "utf8");

    const result = await resolveLatestRevForDate(draftRoot, "2026-06-01");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSpecificRev
// ---------------------------------------------------------------------------

describe("resolveSpecificRev", () => {
  it("returns the requested rev when it exists", async () => {
    const draftRoot = await createDraftRoot();
    await makeRevDir(draftRoot, "2026-06-01", "rev-001");
    const expectedDir = await makeRevDir(draftRoot, "2026-06-01", "rev-002");

    const result = await resolveSpecificRev(
      draftRoot,
      "2026-06-01",
      "rev-002"
    );

    expect(result).not.toBeNull();
    expect(result!.revision).toBe("rev-002");
    expect(result!.outputDir).toBe(expectedDir);
  });

  it("returns null when the requested rev does not exist", async () => {
    const draftRoot = await createDraftRoot();
    await makeRevDir(draftRoot, "2026-06-01", "rev-001");

    const result = await resolveSpecificRev(
      draftRoot,
      "2026-06-01",
      "rev-999"
    );

    expect(result).toBeNull();
  });

  it("returns null when the date directory itself is missing", async () => {
    const draftRoot = await createDraftRoot();

    const result = await resolveSpecificRev(
      draftRoot,
      "2026-06-01",
      "rev-001"
    );

    expect(result).toBeNull();
  });

  it("throws RevisionFormatError for malformed revision strings", async () => {
    const draftRoot = await createDraftRoot();

    await expect(
      resolveSpecificRev(draftRoot, "2026-06-01", "rev-1")
    ).rejects.toBeInstanceOf(RevisionFormatError);

    await expect(
      resolveSpecificRev(draftRoot, "2026-06-01", "rev-1234")
    ).rejects.toBeInstanceOf(RevisionFormatError);

    await expect(
      resolveSpecificRev(draftRoot, "2026-06-01", "latest")
    ).rejects.toBeInstanceOf(RevisionFormatError);
  });
});
