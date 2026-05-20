# UNC-90: Preview Draft Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a read-only draft loader (`src/preview-loader.ts`) that resolves the latest draft pointer, reads all draft artifacts, and returns a typed discriminated-union result for use by the preview formatter and CLI.

**Architecture:** Three loader outcomes form a discriminated union (`PreviewLoaderResult`): `success` (all artifacts loaded), `missing` (no latest pointer), and `malformed` (a required file is absent or has invalid JSON). The loader delegates pointer resolution to the existing `readLatestDraftPointer` from `draft-storage.ts`, uses `isSafetyReport` from `safety-report.ts` for type-safe JSON validation, and performs all I/O with `node:fs/promises` — never writing anything back.

**Tech Stack:** TypeScript (strict), Node.js `fs/promises`, vitest for tests. No new dependencies.

---

### Task 1: Define types and the module skeleton

**Files:**
- Create: `src/preview-loader.ts`

- [ ] **Step 1: Write the module with types only (no logic yet)**

Create `src/preview-loader.ts` with exactly this content:

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DraftStorageError, readLatestDraftPointer } from "./draft-storage.js";
import { isSafetyReport, type SafetyReport } from "./safety-report.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PreviewLoaderSuccess = {
  outcome: "success";
  targetDate: string;
  revision: string;
  outputDir: string;
  caption: string | null;
  story: Record<string, unknown>;
  metadata: Record<string, unknown>;
  safetyReport: SafetyReport;
  carouselPngs: string[]; // sorted relative paths, e.g. ["carousel/01.png"]
};

export type PreviewLoaderMissing = {
  outcome: "missing";
  message: string;
};

export type PreviewLoaderMalformed = {
  outcome: "malformed";
  file: string;
  message: string;
};

export type PreviewLoaderResult =
  | PreviewLoaderSuccess
  | PreviewLoaderMissing
  | PreviewLoaderMalformed;

// ---------------------------------------------------------------------------
// Main entry point (stub — implementation in Task 2)
// ---------------------------------------------------------------------------

export async function loadLatestDraftPreview(
  draftRoot: string
): Promise<PreviewLoaderResult> {
  throw new Error("Not implemented");
}
```

- [ ] **Step 2: Verify TypeScript compiles (types only)**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm typecheck 2>&1 | head -20
```

Expected: zero errors (or only pre-existing errors unrelated to `preview-loader.ts`).

---

### Task 2: Write the failing tests

**Files:**
- Create: `tests/preview-loader.test.ts`

- [ ] **Step 1: Write all tests**

Create `tests/preview-loader.test.ts`:

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLatestDraftPreview } from "../src/preview-loader.js";

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
});
```

- [ ] **Step 2: Run tests to confirm they all fail (stub throws)**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test -- tests/preview-loader.test.ts 2>&1 | tail -20
```

Expected: All tests fail with "Not implemented".

---

### Task 3: Implement `loadLatestDraftPreview`

**Files:**
- Modify: `src/preview-loader.ts`

- [ ] **Step 1: Replace the stub with the full implementation**

Replace the entire contents of `src/preview-loader.ts` with:

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DraftStorageError, readLatestDraftPointer } from "./draft-storage.js";
import { isSafetyReport, type SafetyReport } from "./safety-report.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PreviewLoaderSuccess = {
  outcome: "success";
  targetDate: string;
  revision: string;
  outputDir: string;
  caption: string | null;
  story: Record<string, unknown>;
  metadata: Record<string, unknown>;
  safetyReport: SafetyReport;
  carouselPngs: string[]; // sorted relative paths, e.g. ["carousel/01.png"]
};

export type PreviewLoaderMissing = {
  outcome: "missing";
  message: string;
};

export type PreviewLoaderMalformed = {
  outcome: "malformed";
  file: string;
  message: string;
};

export type PreviewLoaderResult =
  | PreviewLoaderSuccess
  | PreviewLoaderMissing
  | PreviewLoaderMalformed;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function loadLatestDraftPreview(
  draftRoot: string
): Promise<PreviewLoaderResult> {
  // 1. Resolve latest pointer
  let outputDir: string;
  let targetDate: string;
  let revision: string;

  try {
    const pointer = await readLatestDraftPointer(draftRoot);
    outputDir = pointer.path;
    targetDate = pointer.targetDate;
    revision = pointer.revision;
  } catch (error) {
    if (error instanceof DraftStorageError) {
      return {
        outcome: "missing",
        message: "No latest draft found. Run `uncommitted generate today` first."
      };
    }
    throw error;
  }

  // 2. Read caption.txt (optional — null if missing)
  const caption = await readCaptionOptional(outputDir);

  // 3. Parse required JSON artifacts
  const storyResult = await readRequiredJson(outputDir, "story.json");
  if (storyResult.outcome === "malformed") return storyResult;
  if (!isRecord(storyResult.value)) {
    return malformed(join(outputDir, "story.json"), "story.json is not a JSON object.");
  }

  const metadataResult = await readRequiredJson(outputDir, "metadata.json");
  if (metadataResult.outcome === "malformed") return metadataResult;
  if (!isRecord(metadataResult.value)) {
    return malformed(join(outputDir, "metadata.json"), "metadata.json is not a JSON object.");
  }

  const safetyResult = await readRequiredJson(outputDir, "safety-report.json");
  if (safetyResult.outcome === "malformed") return safetyResult;
  if (!isSafetyReport(safetyResult.value)) {
    return malformed(
      join(outputDir, "safety-report.json"),
      "safety-report.json does not match expected schema."
    );
  }

  // 4. Scan carousel directory for *.png files
  const carouselPngs = await readCarouselPngs(outputDir);

  return {
    outcome: "success",
    targetDate,
    revision,
    outputDir,
    caption,
    story: storyResult.value,
    metadata: metadataResult.value,
    safetyReport: safetyResult.value,
    carouselPngs
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type JsonReadSuccess = { outcome: "ok"; value: unknown };
type JsonReadMalformed = PreviewLoaderMalformed;
type JsonReadResult = JsonReadSuccess | JsonReadMalformed;

async function readRequiredJson(
  outputDir: string,
  filename: string
): Promise<JsonReadResult> {
  const filePath = join(outputDir, filename);
  try {
    const raw = await readFile(filePath, "utf8");
    const value = JSON.parse(raw) as unknown;
    return { outcome: "ok", value };
  } catch {
    return malformed(filePath, `${filename} is missing or contains invalid JSON.`);
  }
}

async function readCaptionOptional(outputDir: string): Promise<string | null> {
  try {
    return await readFile(join(outputDir, "caption.txt"), "utf8");
  } catch {
    return null;
  }
}

async function readCarouselPngs(outputDir: string): Promise<string[]> {
  const carouselDir = join(outputDir, "carousel");
  let entries: string[];

  try {
    entries = await readdir(carouselDir);
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.toLowerCase().endsWith(".png"))
    .sort()
    .map((e) => `carousel/${e}`);
}

function malformed(filePath: string, message: string): PreviewLoaderMalformed {
  return { outcome: "malformed", file: filePath, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test -- tests/preview-loader.test.ts 2>&1
```

Expected: All 7 tests pass.

- [ ] **Step 3: Run typecheck and lint**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm typecheck 2>&1 && pnpm lint 2>&1
```

Expected: Zero errors.

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test 2>&1 | tail -20
```

Expected: All tests pass including the new ones.

- [ ] **Step 5: Commit**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
git add src/preview-loader.ts tests/preview-loader.test.ts docs/superpowers/plans/2026-05-19-unc-90-preview-loader.md
git commit -m "$(cat <<'EOF'
✨ feat(preview-export): add draft loader for latest draft artifacts

Implements PreviewLoaderResult (success | missing | malformed) with typed
outputs for caption, story, metadata, safety report, and carousel PNG paths.
Reuses readLatestDraftPointer from draft-storage and isSafetyReport from
safety-report. All draft files are read-only — no mutation.

- Add src/preview-loader.ts with loadLatestDraftPreview()
- Add tests/preview-loader.test.ts (7 tests: success, text-only, missing,
  malformed JSON, missing metadata, invalid safety schema, carousel sort)

Refs: UNC-90
🤖 Generated with Routine B (Uncommitted Builder)
EOF
)"
```
