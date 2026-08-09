import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRenderCommand, RenderCommandError } from "../src/render-command.js";
import {
  createDraftRevision,
  writeDraftArtifactJson,
  writeLatestDraftPointer
} from "../src/draft-storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeRenderConfig(homeDir: string, draftRoot: string): Promise<void> {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        draftRoot,
        scheduleTime: "23:30",
        aiProvider: "none",
        persona: "test persona",
        roastLevel: 2
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// UNC-256 / T5: render must respect the incomplete-draft marker left by
// UNC-253 (a caption-stage failure) instead of treating a half-written
// revision as a finished one.
// ---------------------------------------------------------------------------

describe("render-command (UNC-256 / T5: incomplete draft guard)", () => {
  it("refuses to render a draft marked incomplete", async () => {
    const directory = await createTempDir("uncommitted-render-incomplete-");
    const homeDir = join(directory, "home");
    const draftRoot = join(directory, "drafts");

    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeRenderConfig(homeDir, draftRoot);

    // metadata.json only, marked incomplete — story.json is intentionally
    // never written. This is the actual shape of a revision left behind by
    // a caption-stage failure.
    await writeDraftArtifactJson(revision, "metadata.json", {
      schemaVersion: 1,
      status: "incomplete",
      incomplete: {
        stage: "caption",
        reason: "AI provider returned invalid caption.",
        failedAt: "2026-08-10T14:30:00.000Z"
      }
    });
    await writeLatestDraftPointer(revision, "2026-08-10T14:30:00.000Z");

    await expect(runRenderCommand(["latest"], { homeDir })).rejects.toThrow(
      /incomplete/i
    );
  });

  it("reports the incomplete draft with a render-failed code and mentions the failed stage", async () => {
    const directory = await createTempDir("uncommitted-render-incomplete-code-");
    const homeDir = join(directory, "home");
    const draftRoot = join(directory, "drafts");

    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeRenderConfig(homeDir, draftRoot);
    await writeDraftArtifactJson(revision, "metadata.json", {
      schemaVersion: 1,
      status: "incomplete",
      incomplete: {
        stage: "caption",
        reason: "AI provider returned invalid caption.",
        failedAt: "2026-08-10T14:30:00.000Z"
      }
    });
    await writeLatestDraftPointer(revision, "2026-08-10T14:30:00.000Z");

    try {
      await runRenderCommand(["latest"], { homeDir });
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderCommandError);
      expect((error as RenderCommandError).code).toBe("render-failed");
      expect((error as RenderCommandError).message).toContain("caption");
    }
  });

  it("does not leak the raw incomplete.reason into the render error message", async () => {
    const directory = await createTempDir("uncommitted-render-incomplete-reason-");
    const homeDir = join(directory, "home");
    const draftRoot = join(directory, "drafts");

    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });
    const secretReason = "provider key sk-SECRET-abc123 rejected the request";

    await writeRenderConfig(homeDir, draftRoot);
    await writeDraftArtifactJson(revision, "metadata.json", {
      schemaVersion: 1,
      status: "incomplete",
      incomplete: {
        stage: "caption",
        reason: secretReason,
        failedAt: "2026-08-10T14:30:00.000Z"
      }
    });
    await writeLatestDraftPointer(revision, "2026-08-10T14:30:00.000Z");

    try {
      await runRenderCommand(["latest"], { homeDir });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as RenderCommandError).message).not.toContain(secretReason);
    }
  });
});
