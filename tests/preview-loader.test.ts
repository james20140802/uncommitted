import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadDraftPreviewForRevision,
  loadLatestDraftPreview
} from "../src/preview-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDraftRoot(): Promise<string> {
  const root = join(tmpdir(), `preview-loader-test-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

type ArtifactSet = {
  caption?: string | null;          // null = skip writing the file
  story?: unknown;
  metadata?: unknown;
  safetyReport?: unknown;
  carouselPngs?: string[];           // filenames under carousel/ to write
};

const defaultStory = { schemaVersion: 1, title: "Test draft", slides: [] };
const defaultMetadata = {
  schemaVersion: 1,
  targetDate: "2026-05-19",
  generatedAt: "2026-05-19T00:00:00.000Z",
  activityLevel: "moderate",
  formatName: "daily-summary",
  storyFormatVoice: "casual",
  storyFormatTone: "warm",
  projectIds: ["proj-1"],
  entryMode: "daily_global",
  slideCount: 3
};
const defaultSafetyReport = {
  schemaVersion: 1,
  status: "safe",
  risks: [],
  redactionsApplied: [],
  exportAllowed: true,
  message: "Safety check passed."
};

async function writeDraftRevision(
  draftRoot: string,
  targetDate: string,
  revision: string,
  artifacts: ArtifactSet
): Promise<string> {
  const outputDir = join(draftRoot, targetDate, revision);
  await mkdir(outputDir, { recursive: true });

  if (artifacts.caption !== null) {
    const caption = artifacts.caption ?? "Test caption\n";
    await writeFile(join(outputDir, "caption.txt"), caption, "utf8");
  }

  if (artifacts.story !== undefined) {
    await writeFile(
      join(outputDir, "story.json"),
      JSON.stringify(artifacts.story, null, 2),
      "utf8"
    );
  }

  if (artifacts.metadata !== undefined) {
    await writeFile(
      join(outputDir, "metadata.json"),
      JSON.stringify(artifacts.metadata, null, 2),
      "utf8"
    );
  }

  if (artifacts.safetyReport !== undefined) {
    await writeFile(
      join(outputDir, "safety-report.json"),
      JSON.stringify(artifacts.safetyReport, null, 2),
      "utf8"
    );
  }

  if (artifacts.carouselPngs && artifacts.carouselPngs.length > 0) {
    const carouselDir = join(outputDir, "carousel");
    await mkdir(carouselDir, { recursive: true });
    for (const filename of artifacts.carouselPngs) {
      await writeFile(join(carouselDir, filename), Buffer.alloc(0));
    }
  }

  return outputDir;
}

async function writeLatestPointer(
  draftRoot: string,
  targetDate: string,
  revision: string,
  outputDir: string
): Promise<void> {
  const pointer = {
    schemaVersion: 1,
    targetDate,
    revision,
    path: outputDir,
    updatedAt: "2026-05-19T00:00:00.000Z"
  };
  await writeFile(
    join(draftRoot, "latest.json"),
    JSON.stringify(pointer, null, 2),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadLatestDraftPreview", () => {
  it("returns missing outcome when no latest.json exists", async () => {
    const draftRoot = await createDraftRoot();
    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("missing");
    if (result.outcome === "missing") {
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("returns success for a fully-rendered draft with carousel PNGs", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Hello carousel\n",
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport,
      carouselPngs: ["01.png", "02.png", "03.png"]
    });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.targetDate).toBe("2026-05-19");
      expect(result.revision).toBe("rev-001");
      expect(result.caption).toBe("Hello carousel\n");
      expect(result.story).toMatchObject({ schemaVersion: 1 });
      expect(result.metadata).toMatchObject({ schemaVersion: 1 });
      expect(result.safetyReport.status).toBe("safe");
      expect(result.carouselPngs).toEqual([
        "carousel/01.png",
        "carousel/02.png",
        "carousel/03.png"
      ]);
    }
  });

  it("returns success for a text-only draft with no carousel directory", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Text-only\n",
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport
      // no carouselPngs
    });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.carouselPngs).toEqual([]);
    }
  });

  it("loads a legacy draft whose metadata still carries storyFormatVoice/storyFormatTone", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Legacy draft\n",
      story: defaultStory,
      metadata: {
        ...defaultMetadata,
        storyFormatVoice: "night librarian",
        storyFormatTone: "deadpan"
      },
      safetyReport: defaultSafetyReport
    });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("success");
  });

  it("returns success with null caption when caption.txt is missing", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: null, // skip writing
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport
    });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.caption).toBeNull();
    }
  });

  it("returns malformed outcome when story.json is invalid JSON", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Test\n",
      story: defaultStory,   // will be overwritten below
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport
    });
    // overwrite with invalid JSON
    await writeFile(join(outputDir, "story.json"), "{ not valid json", "utf8");
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("malformed");
    if (result.outcome === "malformed") {
      expect(result.file).toContain("story.json");
    }
  });

  it("returns malformed outcome when metadata.json is missing", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Test\n",
      story: defaultStory,
      // no metadata
      safetyReport: defaultSafetyReport
    });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("malformed");
    if (result.outcome === "malformed") {
      expect(result.file).toContain("metadata.json");
    }
  });

  it("returns malformed outcome when safety-report.json fails type guard", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Test\n",
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: { schemaVersion: 99, status: "unknown" } // invalid shape
    });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("malformed");
    if (result.outcome === "malformed") {
      expect(result.file).toContain("safety-report.json");
    }
  });

  it("carousel PNGs are returned sorted and non-PNG files are excluded", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Test\n",
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport,
      carouselPngs: ["03.png", "01.png", "02.png"]
    });
    // also write a non-png file in carousel/
    await writeFile(join(outputDir, "carousel", "notes.txt"), "ignore me", "utf8");
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.carouselPngs).toEqual([
        "carousel/01.png",
        "carousel/02.png",
        "carousel/03.png"
      ]);
    }
  });

  it("returns malformed outcome when latest.json path is outside draft root", async () => {
    const draftRoot = await createDraftRoot();
    const outsideDir = await createDraftRoot();
    const pointer = {
      schemaVersion: 1,
      targetDate: "2026-05-19",
      revision: "rev-001",
      path: outsideDir,
      updatedAt: "2026-05-19T00:00:00.000Z"
    };
    await writeFile(
      join(draftRoot, "latest.json"),
      JSON.stringify(pointer, null, 2),
      "utf8"
    );

    const result = await loadLatestDraftPreview(draftRoot);

    expect(result.outcome).toBe("malformed");
  });

  it("propagates non-ENOENT errors from caption read", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: null,
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport
    });
    // Create a directory at caption.txt path — readFile will fail with EISDIR, not ENOENT
    await mkdir(join(outputDir, "caption.txt"), { recursive: true });
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    await expect(loadLatestDraftPreview(draftRoot)).rejects.toThrow();
  });

  it("propagates non-ENOENT errors from carousel read", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-19", "rev-001", {
      caption: "Test\n",
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport
    });
    // Create a regular file at the carousel/ path — readdir will fail with ENOTDIR, not ENOENT
    await writeFile(join(outputDir, "carousel"), Buffer.alloc(0));
    await writeLatestPointer(draftRoot, "2026-05-19", "rev-001", outputDir);

    await expect(loadLatestDraftPreview(draftRoot)).rejects.toThrow();
  });
});

describe("loadDraftPreviewForRevision", () => {
  it("returns success for an arbitrary revision under the draft root", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-17", "rev-002", {
      caption: "Older rev caption\n",
      story: defaultStory,
      metadata: defaultMetadata,
      safetyReport: defaultSafetyReport,
      carouselPngs: ["01.png"]
    });

    const result = await loadDraftPreviewForRevision(
      draftRoot,
      outputDir,
      "2026-05-17",
      "rev-002"
    );

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.targetDate).toBe("2026-05-17");
      expect(result.revision).toBe("rev-002");
      expect(result.caption).toBe("Older rev caption\n");
      expect(result.carouselPngs).toEqual(["carousel/01.png"]);
    }
  });

  it("returns malformed when outputDir escapes draftRoot", async () => {
    const draftRoot = await createDraftRoot();
    const outsideRoot = await createDraftRoot();
    const outsideDir = await writeDraftRevision(
      outsideRoot,
      "2026-05-17",
      "rev-001",
      {
        caption: "outside\n",
        story: defaultStory,
        metadata: defaultMetadata,
        safetyReport: defaultSafetyReport
      }
    );

    const result = await loadDraftPreviewForRevision(
      draftRoot,
      outsideDir,
      "2026-05-17",
      "rev-001"
    );

    expect(result.outcome).toBe("malformed");
  });

  it("returns malformed when metadata.json is missing", async () => {
    const draftRoot = await createDraftRoot();
    const outputDir = await writeDraftRevision(draftRoot, "2026-05-17", "rev-001", {
      caption: "no metadata\n",
      story: defaultStory,
      // no metadata
      safetyReport: defaultSafetyReport
    });

    const result = await loadDraftPreviewForRevision(
      draftRoot,
      outputDir,
      "2026-05-17",
      "rev-001"
    );

    expect(result.outcome).toBe("malformed");
    if (result.outcome === "malformed") {
      expect(result.file).toContain("metadata.json");
    }
  });
});
