import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runExportCommand,
  ExportCommandError
} from "../src/export-command.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const base = join(tmpdir(), `unc-export-test-${randomUUID()}`);
  await mkdir(base, { recursive: true });
  return base;
}

/**
 * Build a minimal draft revision on disk and write the latest.json pointer.
 * Returns the draftRoot and the revision output directory path.
 */
async function scaffoldDraft(
  draftRoot: string,
  opts: {
    targetDate?: string;
    revision?: string;
    carouselCount?: number;
    captionText?: string;
  } = {}
): Promise<{ outputDir: string; targetDate: string; revision: string }> {
  const targetDate = opts.targetDate ?? "2026-05-18";
  const revision = opts.revision ?? "rev-001";
  const carouselCount = opts.carouselCount ?? 2;
  const captionText = opts.captionText ?? "Today was productive.\n";

  const outputDir = join(draftRoot, targetDate, revision);
  await mkdir(join(outputDir, "carousel"), { recursive: true });

  // Write draft files
  await writeFile(join(outputDir, "caption.txt"), captionText, "utf8");
  await writeFile(
    join(outputDir, "metadata.json"),
    JSON.stringify({ schemaVersion: 1, targetDate, revision }, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    join(outputDir, "safety-report.json"),
    JSON.stringify({
      schemaVersion: 1,
      status: "safe",
      risks: [],
      redactionsApplied: [],
      exportAllowed: true,
      message: "Safety check passed."
    }, null, 2) + "\n",
    "utf8"
  );

  // Write carousel PNGs (fake binary content)
  for (let i = 1; i <= carouselCount; i++) {
    const pad = String(i).padStart(2, "0");
    await writeFile(join(outputDir, "carousel", `${pad}.png`), `FAKE_PNG_${i}`);
  }

  // Write latest.json pointer
  const pointer = {
    schemaVersion: 1,
    targetDate,
    revision,
    path: outputDir,
    updatedAt: "2026-05-18T23:30:00.000Z"
  };
  await writeFile(
    join(draftRoot, "latest.json"),
    JSON.stringify(pointer, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    join(draftRoot, targetDate, "latest.json"),
    JSON.stringify(pointer, null, 2) + "\n",
    "utf8"
  );

  return { outputDir, targetDate, revision };
}

// ---------------------------------------------------------------------------
// UNC-92: Happy path — scaffold export instagram CLI
// ---------------------------------------------------------------------------

describe("export-command (UNC-92: scaffold)", () => {
  it("exports a safe draft to a predictable export folder", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { carouselCount: 3 });

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    expect(result.exportDir).toContain("exports/instagram");
    expect(result.exportedFiles).toContain("caption.txt");
    expect(result.exportedFiles).toContain("carousel-01.png");
    expect(result.exportedFiles).toContain("carousel-02.png");
    expect(result.exportedFiles).toContain("carousel-03.png");
    expect(result.exportedFiles).toContain("metadata.json");
  });

  it("copies caption.txt verbatim to export folder", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { captionText: "My caption\n" });

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    const exported = await readFile(join(result.exportDir, "caption.txt"), "utf8");
    expect(exported).toBe("My caption\n");
  });

  it("copies carousel PNGs with zero-padded upload-friendly names", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { carouselCount: 2 });

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    const png1 = await readFile(join(result.exportDir, "carousel-01.png"));
    const png2 = await readFile(join(result.exportDir, "carousel-02.png"));
    expect(png1.toString()).toBe("FAKE_PNG_1");
    expect(png2.toString()).toBe("FAKE_PNG_2");
  });

  it("writes metadata.json with date, revision, timestamp, safety status, and file list", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { targetDate: "2026-05-18", revision: "rev-001" });

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    const meta = JSON.parse(
      await readFile(join(result.exportDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;

    expect(meta.draftDate).toBe("2026-05-18");
    expect(meta.draftRevision).toBe("rev-001");
    expect(meta.sourceDraftPath).toBeUndefined();
    expect(meta.exportedAt).toBe("2026-05-18T23:35:00.000Z");
    expect(meta.safetyStatus).toBe("safe");
    expect(Array.isArray(meta.exportedFiles)).toBe(true);
    expect((meta.exportedFiles as string[])).toContain("caption.txt");
  });

  it("does not modify source draft files", async () => {
    const draftRoot = await createTempDir();
    const { outputDir } = await scaffoldDraft(draftRoot, { captionText: "Original\n" });

    await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    const caption = await readFile(join(outputDir, "caption.txt"), "utf8");
    expect(caption).toBe("Original\n");
    // Source directory should have the same files as before (no extra files)
    const srcFiles = await readdir(outputDir);
    expect(srcFiles).not.toContain("carousel-01.png");
  });

  it("returns export folder path distinct from source draft path", async () => {
    const draftRoot = await createTempDir();
    const { outputDir } = await scaffoldDraft(draftRoot);

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    expect(result.exportDir).not.toBe(outputDir);
    // Export lives sibling to drafts/, not inside it.
    expect(result.exportDir).not.toContain(`${draftRoot}/exports`);
    expect(result.exportDir.startsWith(draftRoot + "/")).toBe(false);
  });

  it("writes exports to <uncommittedRoot>/exports/instagram/<date>/<rev> (sibling of drafts/)", async () => {
    // Set up <uncommittedRoot>/drafts/<date>/<rev>
    const uncommittedRoot = await createTempDir();
    const draftRoot = join(uncommittedRoot, "drafts");
    await mkdir(draftRoot, { recursive: true });
    await scaffoldDraft(draftRoot, { targetDate: "2026-05-18", revision: "rev-001" });

    const result = await runExportCommand(
      ["instagram"],
      { draftRoot, now: () => "2026-05-18T10:30:00.000Z" }
    );

    const expectedExportDir = join(uncommittedRoot, "exports", "instagram", "2026-05-18", "rev-001");
    expect(result.exportDir).toBe(expectedExportDir);
    expect(result.exportDir.startsWith(draftRoot + "/")).toBe(false);
  });

  it("accepts 'instagram latest' alias", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot);

    const result = await runExportCommand(["instagram", "latest"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    expect(result.exportedFiles).toContain("caption.txt");
  });

  it("throws ExportCommandError with invalid-arguments for unknown subcommand", async () => {
    const draftRoot = await createTempDir();
    await expect(
      runExportCommand(["twitter"], { draftRoot })
    ).rejects.toThrow(ExportCommandError);

    try {
      await runExportCommand(["twitter"], { draftRoot });
    } catch (err) {
      expect(err).toBeInstanceOf(ExportCommandError);
      expect((err as ExportCommandError).code).toBe("invalid-arguments");
    }
  });
});

// ---------------------------------------------------------------------------
// UNC-94: Safety policy (safe / warning / blocked)
// ---------------------------------------------------------------------------

async function scaffoldDraftWithSafety(
  draftRoot: string,
  safetyStatus: "safe" | "warning" | "blocked",
  warningReason?: string
): Promise<void> {
  const targetDate = "2026-05-18";
  const revision = "rev-001";
  const outputDir = join(draftRoot, targetDate, revision);
  await mkdir(join(outputDir, "carousel"), { recursive: true });

  await writeFile(join(outputDir, "caption.txt"), "Caption text.\n", "utf8");
  await writeFile(
    join(outputDir, "metadata.json"),
    JSON.stringify({ schemaVersion: 1, targetDate }, null, 2) + "\n",
    "utf8"
  );
  await writeFile(join(outputDir, "carousel", "01.png"), "FAKE_PNG");

  const message =
    safetyStatus === "blocked"
      ? "Remove blocked sensitive content."
      : safetyStatus === "warning"
        ? warningReason ?? "Review redactions before export."
        : "Safety check passed.";

  await writeFile(
    join(outputDir, "safety-report.json"),
    JSON.stringify({
      schemaVersion: 1,
      status: safetyStatus,
      risks: safetyStatus !== "safe"
        ? [{ category: "secret", severity: safetyStatus, message }]
        : [],
      redactionsApplied: [],
      exportAllowed: safetyStatus !== "blocked",
      message
    }, null, 2) + "\n",
    "utf8"
  );

  const pointer = {
    schemaVersion: 1,
    targetDate,
    revision,
    path: outputDir,
    updatedAt: "2026-05-18T23:30:00.000Z"
  };
  await writeFile(
    join(draftRoot, "latest.json"),
    JSON.stringify(pointer, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    join(draftRoot, targetDate, "latest.json"),
    JSON.stringify(pointer, null, 2) + "\n",
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// UNC-95: Error handling — missing draft / missing carousel
// ---------------------------------------------------------------------------

describe("export-command (UNC-95: error handling)", () => {
  it("throws missing-draft when latest.json is absent", async () => {
    const draftRoot = await createTempDir();
    // No draft scaffolded — latest.json does not exist

    try {
      await runExportCommand(["instagram"], { draftRoot });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExportCommandError);
      expect((err as ExportCommandError).code).toBe("missing-draft");
      expect((err as ExportCommandError).message).toContain("render latest");
    }
  });

  it("error message for missing draft tells user what to run next", async () => {
    const draftRoot = await createTempDir();

    try {
      await runExportCommand(["instagram"], { draftRoot });
    } catch (err) {
      const msg = (err as ExportCommandError).message;
      // Should reference generate or render step
      expect(msg.toLowerCase()).toMatch(/generate|render/);
    }
  });

  it("throws missing-carousel when carousel directory is absent", async () => {
    const draftRoot = await createTempDir();
    // Scaffold draft WITHOUT carousel directory
    const targetDate = "2026-05-18";
    const revision = "rev-001";
    const outputDir = join(draftRoot, targetDate, revision);
    await mkdir(outputDir, { recursive: true });

    await writeFile(join(outputDir, "caption.txt"), "Caption.\n", "utf8");
    await writeFile(
      join(outputDir, "safety-report.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "safe",
        risks: [],
        redactionsApplied: [],
        exportAllowed: true,
        message: "Safety check passed."
      }, null, 2) + "\n",
      "utf8"
    );

    const pointer = {
      schemaVersion: 1,
      targetDate,
      revision,
      path: outputDir,
      updatedAt: "2026-05-18T23:30:00.000Z"
    };
    await writeFile(
      join(draftRoot, "latest.json"),
      JSON.stringify(pointer, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      join(draftRoot, targetDate, "latest.json"),
      JSON.stringify(pointer, null, 2) + "\n",
      "utf8"
    );

    try {
      await runExportCommand(["instagram"], { draftRoot });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExportCommandError);
      expect((err as ExportCommandError).code).toBe("missing-carousel");
      expect((err as ExportCommandError).message).toContain("render latest");
    }
  });

  it("throws missing-carousel when carousel directory exists but has no PNGs", async () => {
    const draftRoot = await createTempDir();
    const targetDate = "2026-05-18";
    const revision = "rev-001";
    const outputDir = join(draftRoot, targetDate, revision);
    await mkdir(join(outputDir, "carousel"), { recursive: true });
    // carousel dir is empty — no PNGs at all

    await writeFile(join(outputDir, "caption.txt"), "Caption.\n", "utf8");
    await writeFile(
      join(outputDir, "safety-report.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "safe",
        risks: [],
        redactionsApplied: [],
        exportAllowed: true,
        message: "Safety check passed."
      }, null, 2) + "\n",
      "utf8"
    );

    const pointer = {
      schemaVersion: 1,
      targetDate,
      revision,
      path: outputDir,
      updatedAt: "2026-05-18T23:30:00.000Z"
    };
    await writeFile(
      join(draftRoot, "latest.json"),
      JSON.stringify(pointer, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      join(draftRoot, targetDate, "latest.json"),
      JSON.stringify(pointer, null, 2) + "\n",
      "utf8"
    );

    try {
      await runExportCommand(["instagram"], { draftRoot });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExportCommandError);
      expect((err as ExportCommandError).code).toBe("missing-carousel");
    }
  });

  it("does not create an export folder when carousel is missing", async () => {
    // Use isolated uncommittedRoot so dirname(draftRoot) is not a shared temp dir
    const uncommittedRoot = await createTempDir();
    const draftRoot = join(uncommittedRoot, "drafts");
    const targetDate = "2026-05-18";
    const revision = "rev-001";
    const outputDir = join(draftRoot, targetDate, revision);
    await mkdir(outputDir, { recursive: true });
    // No carousel directory

    await writeFile(join(outputDir, "caption.txt"), "Caption.\n", "utf8");
    await writeFile(
      join(outputDir, "safety-report.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "safe",
        risks: [],
        redactionsApplied: [],
        exportAllowed: true,
        message: "Safety check passed."
      }, null, 2) + "\n",
      "utf8"
    );

    const pointer = {
      schemaVersion: 1,
      targetDate,
      revision,
      path: outputDir,
      updatedAt: "2026-05-18T23:30:00.000Z"
    };
    await writeFile(
      join(draftRoot, "latest.json"),
      JSON.stringify(pointer, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      join(draftRoot, targetDate, "latest.json"),
      JSON.stringify(pointer, null, 2) + "\n",
      "utf8"
    );

    try {
      await runExportCommand(["instagram"], { draftRoot });
    } catch {
      // expected
    }

    // After UNC-128: exports live sibling to draftRoot (at uncommittedRoot/exports/instagram).
    const exportBase = join(uncommittedRoot, "exports", "instagram");
    await expect(readdir(exportBase)).rejects.toThrow();
  });
});

describe("export-command (UNC-94: safety policy)", () => {
  it("safe draft exports with no warning and safetyStatus 'safe' in metadata", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraftWithSafety(draftRoot, "safe");

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    expect(result.safetyStatus).toBe("safe");
    expect(result.warningMessage).toBeUndefined();

    const meta = JSON.parse(
      await readFile(join(result.exportDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;
    expect(meta.safetyStatus).toBe("safe");
  });

  it("warning draft exports successfully and returns a warning message with reason", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraftWithSafety(draftRoot, "warning", "Review redactions before export.");

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    expect(result.safetyStatus).toBe("warning");
    expect(result.warningMessage).toBeDefined();
    expect(result.warningMessage).toContain("Review redactions before export.");
    expect(result.exportedFiles).toContain("caption.txt");

    const meta = JSON.parse(
      await readFile(join(result.exportDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;
    expect(meta.safetyStatus).toBe("warning");
  });

  it("blocked draft throws ExportCommandError with safety-blocked code", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraftWithSafety(draftRoot, "blocked");

    await expect(
      runExportCommand(["instagram"], {
        draftRoot,
        now: () => "2026-05-18T23:35:00.000Z"
      })
    ).rejects.toThrow(ExportCommandError);

    try {
      await runExportCommand(["instagram"], {
        draftRoot,
        now: () => "2026-05-18T23:35:00.000Z"
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ExportCommandError);
      expect((err as ExportCommandError).code).toBe("safety-blocked");
    }
  });

  it("blocked draft does not create an export folder", async () => {
    // Use isolated uncommittedRoot so dirname(draftRoot) is not a shared temp dir
    const uncommittedRoot = await createTempDir();
    const draftRoot = join(uncommittedRoot, "drafts");
    await mkdir(draftRoot, { recursive: true });
    await scaffoldDraftWithSafety(draftRoot, "blocked");

    try {
      await runExportCommand(["instagram"], { draftRoot });
    } catch {
      // expected
    }

    // After UNC-128: exports live sibling to draftRoot (at uncommittedRoot/exports/instagram).
    const exportBase = join(uncommittedRoot, "exports", "instagram");
    await expect(readdir(exportBase)).rejects.toThrow();
  });

  it("exported metadata.json includes safetyStatus for warning drafts", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraftWithSafety(draftRoot, "warning", "Possible secret detected.");

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    const meta = JSON.parse(
      await readFile(join(result.exportDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;
    expect(meta.safetyStatus).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// UNC-96: Idempotency — re-run safety and metadata correctness
// ---------------------------------------------------------------------------

describe("export-command (UNC-96: idempotency)", () => {
  it("re-running on the same draft overwrites export cleanly (metadata reflects new timestamp)", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot);

    // First run
    await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:00:00.000Z"
    });

    // Second run — same draft, different timestamp
    const result2 = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    const meta = JSON.parse(
      await readFile(join(result2.exportDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;

    // metadata.json must reflect the SECOND export's timestamp
    expect(meta.exportedAt).toBe("2026-05-18T23:35:00.000Z");
  });

  it("re-run on the same draft does not corrupt the source draft", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { captionText: "Original caption\n" });

    await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:00:00.000Z"
    });
    await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    // Source caption must be unchanged
    const sourceCaption = await readFile(
      join(draftRoot, "2026-05-18", "rev-001", "caption.txt"),
      "utf8"
    );
    expect(sourceCaption).toBe("Original caption\n");
  });

  it("re-run after revision advances creates a new export path, leaves old export untouched", async () => {
    const draftRoot = await createTempDir();

    // First draft: rev-001
    await scaffoldDraft(draftRoot, {
      revision: "rev-001",
      captionText: "Day one\n"
    });
    const result1 = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:00:00.000Z"
    });

    // Second draft: rev-002 — update latest.json to point to rev-002
    const targetDate = "2026-05-18";
    const rev2Dir = join(draftRoot, targetDate, "rev-002");
    await mkdir(join(rev2Dir, "carousel"), { recursive: true });
    await writeFile(join(rev2Dir, "caption.txt"), "Day two\n", "utf8");
    await writeFile(
      join(rev2Dir, "safety-report.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "safe",
        risks: [],
        redactionsApplied: [],
        exportAllowed: true,
        message: "Safety check passed."
      }, null, 2) + "\n",
      "utf8"
    );
    await writeFile(join(rev2Dir, "carousel", "01.png"), "PNG_V2");

    const pointer2 = {
      schemaVersion: 1,
      targetDate,
      revision: "rev-002",
      path: rev2Dir,
      updatedAt: "2026-05-18T23:20:00.000Z"
    };
    await writeFile(
      join(draftRoot, "latest.json"),
      JSON.stringify(pointer2, null, 2) + "\n",
      "utf8"
    );

    const result2 = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    // Different export dirs
    expect(result2.exportDir).not.toBe(result1.exportDir);

    // Old export caption still unchanged
    const oldCaption = await readFile(join(result1.exportDir, "caption.txt"), "utf8");
    expect(oldCaption).toBe("Day one\n");

    // New export has new caption
    const newCaption = await readFile(join(result2.exportDir, "caption.txt"), "utf8");
    expect(newCaption).toBe("Day two\n");
  });

  it("re-run after partial export folder deletion succeeds and recreates all files", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { carouselCount: 2 });

    // First run
    const result1 = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:00:00.000Z"
    });

    // Simulate partial deletion: remove carousel-01.png from export
    const { unlink } = await import("node:fs/promises");
    await unlink(join(result1.exportDir, "carousel-01.png"));

    // Re-run should recreate everything
    const result2 = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    // Same export dir (same revision)
    expect(result2.exportDir).toBe(result1.exportDir);

    // carousel-01.png recreated
    const png1 = await readFile(join(result2.exportDir, "carousel-01.png"));
    expect(png1.toString()).toBe("FAKE_PNG_1");

    // metadata.json updated
    const meta = JSON.parse(
      await readFile(join(result2.exportDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;
    expect(meta.exportedAt).toBe("2026-05-18T23:35:00.000Z");
  });

  it("export folder path uses date and revision for disambiguation", async () => {
    const draftRoot = await createTempDir();
    await scaffoldDraft(draftRoot, { targetDate: "2026-05-18", revision: "rev-001" });

    const result = await runExportCommand(["instagram"], {
      draftRoot,
      now: () => "2026-05-18T23:35:00.000Z"
    });

    expect(result.exportDir).toContain("2026-05-18");
    expect(result.exportDir).toContain("rev-001");
  });
});
