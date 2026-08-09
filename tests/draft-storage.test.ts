import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPaths } from "../src/config-paths.js";
import {
  createDraftRevision,
  readLatestDraftPointer,
  writeDraftArtifactJson,
  writeDraftArtifactText,
  writeIncompleteDraftMarker,
  writeLatestDraftPointer,
  writeTextDraftRevision
} from "../src/draft-storage.js";

describe("draft storage", () => {
  it("writes the first text draft revision under the configured draft root", async () => {
    const draftRoot = await createDraftRoot();
    const result = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activitySummary: { schemaVersion: 1, targetDate: "2026-05-18" },
      story: { schemaVersion: 1, title: "First draft" },
      caption: "First caption\n",
      metadata: { schemaVersion: 1, files: ["activity-summary.json"] }
    });

    expect(result).toEqual({
      targetDate: "2026-05-18",
      revision: "rev-001",
      dateDir: join(draftRoot, "2026-05-18"),
      outputDir: join(draftRoot, "2026-05-18", "rev-001"),
      latestPointerPath: join(draftRoot, "latest.json"),
      dateLatestPointerPath: join(draftRoot, "2026-05-18", "latest.json"),
      files: [
        "activity-summary.json",
        "story.json",
        "caption.txt",
        "metadata.json"
      ]
    });
    await expectJson(join(result.outputDir, "activity-summary.json"), {
      schemaVersion: 1,
      targetDate: "2026-05-18"
    });
    await expectJson(join(result.outputDir, "story.json"), {
      schemaVersion: 1,
      title: "First draft"
    });
    await expect(readFile(join(result.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "First caption\n"
    );
    await expectJson(join(result.outputDir, "metadata.json"), {
      schemaVersion: 1,
      files: ["activity-summary.json"]
    });
  });

  it("creates the next revision without overwriting existing draft artifacts", async () => {
    const draftRoot = await createDraftRoot();

    const first = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1, title: "First" },
      caption: "First caption\n",
      metadata: { schemaVersion: 1 }
    });
    const second = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:45:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1, title: "Second" },
      caption: "Second caption\n",
      metadata: { schemaVersion: 1 }
    });

    expect(first.revision).toBe("rev-001");
    expect(second.revision).toBe("rev-002");
    await expect(readFile(join(first.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "First caption\n"
    );
    await expect(readFile(join(second.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "Second caption\n"
    );
  });

  it("updates latest pointers to the newest revision", async () => {
    const draftRoot = await createDraftRoot();

    await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1 },
      caption: "First\n",
      metadata: { schemaVersion: 1 }
    });
    const latestRevision = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:45:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1 },
      caption: "Second\n",
      metadata: { schemaVersion: 1 }
    });

    await expectJson(latestRevision.latestPointerPath, {
      schemaVersion: 1,
      targetDate: "2026-05-18",
      revision: "rev-002",
      path: latestRevision.outputDir,
      updatedAt: "2026-05-18T23:45:00.000Z"
    });
    await expectJson(latestRevision.dateLatestPointerPath, {
      schemaVersion: 1,
      targetDate: "2026-05-18",
      revision: "rev-002",
      path: latestRevision.outputDir,
      updatedAt: "2026-05-18T23:45:00.000Z"
    });
    await expect(readLatestDraftPointer(draftRoot)).resolves.toEqual({
      schemaVersion: 1,
      targetDate: "2026-05-18",
      revision: "rev-002",
      path: latestRevision.outputDir,
      updatedAt: "2026-05-18T23:45:00.000Z"
    });
  });

  it("uses draft roots resolved through config path helpers", async () => {
    const homeDir = await createDraftRoot();
    const draftRoot = resolveConfigPaths({
      homeDir,
      draftRoot: "configured-drafts"
    }).defaultDraftRoot;
    const result = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-19",
      generatedAt: "2026-05-19T23:30:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1 },
      caption: "Configured root\n",
      metadata: { schemaVersion: 1 }
    });

    expect(result.outputDir).toBe(
      join(homeDir, "configured-drafts", "2026-05-19", "rev-001")
    );
  });

  it("supports partial artifact writes before finalizing latest pointers", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-05-20"
    });

    await writeDraftArtifactJson(revision, "activity-summary.json", {
      schemaVersion: 1,
      targetDate: "2026-05-20"
    });
    await writeDraftArtifactText(revision, "caption.txt", "Partial caption\n");
    await writeLatestDraftPointer(revision, "2026-05-20T23:30:00.000Z");

    await expectJson(join(revision.outputDir, "activity-summary.json"), {
      schemaVersion: 1,
      targetDate: "2026-05-20"
    });
    await expect(readFile(join(revision.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "Partial caption\n"
    );
    await expectJson(revision.latestPointerPath, {
      revision: "rev-001",
      path: revision.outputDir
    });
  });

  it("fails with an actionable error when JSON artifact content is invalid", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-05-20"
    });

    await expect(
      writeDraftArtifactJson(revision, "metadata.json", undefined)
    ).rejects.toMatchObject({
      code: "invalid-json",
      message: "Draft artifact JSON is invalid."
    });
  });

  it("marks a revision incomplete without touching the latest pointer", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeIncompleteDraftMarker(revision, {
      stage: "caption",
      reason: "AI provider returned invalid caption.",
      failedAt: "2026-08-10T14:30:00.000Z",
      targetDate: "2026-08-10"
    });

    const metadata = JSON.parse(
      await readFile(join(revision.outputDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;

    expect(metadata.status).toBe("incomplete");
    expect(metadata.incomplete).toMatchObject({
      stage: "caption",
      reason: "AI provider returned invalid caption.",
      failedAt: "2026-08-10T14:30:00.000Z"
    });
    await expect(readFile(join(draftRoot, "latest.json"), "utf8")).rejects.toThrow();
  });

  it("returns a short error for unusable draft roots", async () => {
    const directory = await createDraftRoot();
    const draftRoot = join(directory, "draft-root-file");

    await writeFile(draftRoot, "not a directory", "utf8");

    await expect(
      writeTextDraftRevision({
        draftRoot,
        targetDate: "2026-05-21",
        generatedAt: "2026-05-21T23:30:00.000Z",
        activitySummary: { schemaVersion: 1 },
        story: { schemaVersion: 1 },
        caption: "Blocked by storage\n",
        metadata: { schemaVersion: 1 }
      })
    ).rejects.toMatchObject({
      code: "inspect-failed",
      message: "Could not inspect draft revisions."
    });
  });
});

async function createDraftRoot(): Promise<string> {
  const root = join(tmpdir(), `uncommitted-draft-storage-${randomUUID()}`);

  await mkdir(root, { recursive: true });

  return root;
}

async function expectJson(path: string, value: Record<string, unknown>): Promise<void> {
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(value);
}
