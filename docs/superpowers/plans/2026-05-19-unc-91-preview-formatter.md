# UNC-91: Preview Formatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a pure formatter (`src/preview-formatter.ts`) that converts a `PreviewLoaderResult` into a single compact terminal-friendly string summary for `uncommitted preview latest`.

**Architecture:** A single exported function `formatPreview(result: PreviewLoaderResult): string`. It is completely pure — no I/O, no global state, no file mutation. It handles all three loader outcomes (`success`, `missing`, `malformed`) and within `success` it distinguishes rendered (has carousel PNGs) from text-only (no PNGs), safe/warning/blocked safety states, and missing caption. Metadata fields (date, revision, format name, project IDs) are extracted with safe fallbacks so the formatter never throws on partial metadata.

**Tech Stack:** TypeScript (strict), no new dependencies. Pure function — no Node.js I/O. vitest for tests.

---

### Task 1: Write the failing tests

**Files:**
- Create: `tests/preview-formatter.test.ts`

The formatter is pure (no I/O), so tests can run synchronously without tmp directories.

- [ ] **Step 1: Write all tests**

Create `tests/preview-formatter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatPreview } from "../src/preview-formatter.js";
import type { PreviewLoaderResult } from "../src/preview-loader.js";
import type { SafetyReport } from "../src/safety-report.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const safeSafetyReport: SafetyReport = {
  schemaVersion: 1,
  status: "safe",
  risks: [],
  redactionsApplied: [],
  exportAllowed: true,
  message: "Safety check passed."
};

const warningSafetyReport: SafetyReport = {
  schemaVersion: 1,
  status: "warning",
  risks: [
    {
      category: "email",
      severity: "warning",
      message: "Email address was redacted."
    }
  ],
  redactionsApplied: [
    { category: "email", replacement: "[redacted-email]", count: 1 }
  ],
  exportAllowed: true,
  message: "Review redactions before export."
};

const blockedSafetyReport: SafetyReport = {
  schemaVersion: 1,
  status: "blocked",
  risks: [
    {
      category: "secret",
      severity: "blocked",
      message: "Secret or token was redacted."
    }
  ],
  redactionsApplied: [
    { category: "secret", replacement: "[redacted-secret]", count: 1 }
  ],
  exportAllowed: false,
  message: "Remove blocked sensitive content."
};

const baseMetadata = {
  schemaVersion: 1,
  targetDate: "2026-05-19",
  generatedAt: "2026-05-19T00:00:00.000Z",
  activityLevel: "moderate",
  formatName: "daily-summary",
  storyFormatVoice: "casual",
  storyFormatTone: "warm",
  projectIds: ["proj-1", "proj-2"],
  entryMode: "daily_global",
  slideCount: 3
};

const baseStory = {
  schemaVersion: 1,
  title: "Test draft",
  slides: []
};

function makeSuccess(overrides: Partial<{
  caption: string | null;
  carouselPngs: string[];
  safetyReport: SafetyReport;
  metadata: Record<string, unknown>;
}>): PreviewLoaderResult {
  return {
    outcome: "success",
    targetDate: "2026-05-19",
    revision: "rev-001",
    outputDir: "/tmp/test-draft/2026-05-19/rev-001",
    caption: overrides.caption !== undefined ? overrides.caption : "Test caption text.\n",
    story: baseStory,
    metadata: overrides.metadata ?? baseMetadata,
    safetyReport: overrides.safetyReport ?? safeSafetyReport,
    carouselPngs: overrides.carouselPngs ?? ["carousel/01.png", "carousel/02.png", "carousel/03.png"]
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatPreview", () => {
  it("includes date and revision for a rendered draft", () => {
    const output = formatPreview(makeSuccess({}));

    expect(output).toContain("2026-05-19");
    expect(output).toContain("rev-001");
  });

  it("includes format name from metadata", () => {
    const output = formatPreview(makeSuccess({}));

    expect(output).toContain("daily-summary");
  });

  it("includes project IDs from metadata", () => {
    const output = formatPreview(makeSuccess({}));

    expect(output).toContain("proj-1");
    expect(output).toContain("proj-2");
  });

  it("includes caption text for a rendered draft", () => {
    const output = formatPreview(makeSuccess({ caption: "My caption line.\n" }));

    expect(output).toContain("My caption line.");
  });

  it("shows a clear note when caption is missing", () => {
    const output = formatPreview(makeSuccess({ caption: null }));

    expect(output.toLowerCase()).toMatch(/no caption|caption.*missing|caption.*not/);
  });

  it("lists carousel PNG paths for a rendered draft", () => {
    const output = formatPreview(makeSuccess({
      carouselPngs: ["carousel/01.png", "carousel/02.png"]
    }));

    expect(output).toContain("carousel/01.png");
    expect(output).toContain("carousel/02.png");
  });

  it("shows a clear note for text-only draft with no carousel files", () => {
    const output = formatPreview(makeSuccess({ carouselPngs: [] }));

    expect(output.toLowerCase()).toMatch(/text.only|no.*carousel|not.*render/);
  });

  it("shows safe safety status", () => {
    const output = formatPreview(makeSuccess({ safetyReport: safeSafetyReport }));

    expect(output.toLowerCase()).toContain("safe");
  });

  it("shows warning safety status with the report message", () => {
    const output = formatPreview(makeSuccess({ safetyReport: warningSafetyReport }));

    expect(output.toLowerCase()).toContain("warning");
    expect(output).toContain("Review redactions before export.");
  });

  it("shows blocked safety status with the report message", () => {
    const output = formatPreview(makeSuccess({ safetyReport: blockedSafetyReport }));

    expect(output.toLowerCase()).toContain("blocked");
    expect(output).toContain("Remove blocked sensitive content.");
  });

  it("returns a short actionable message for missing outcome", () => {
    const result: PreviewLoaderResult = {
      outcome: "missing",
      message: "No latest draft found. Run `uncommitted generate today` first."
    };
    const output = formatPreview(result);

    expect(output).toContain("No latest draft found");
  });

  it("returns a short actionable message for malformed outcome with file path", () => {
    const result: PreviewLoaderResult = {
      outcome: "malformed",
      file: "/tmp/drafts/2026-05-19/rev-001/metadata.json",
      message: "metadata.json is missing or contains invalid JSON."
    };
    const output = formatPreview(result);

    expect(output).toContain("metadata.json");
    expect(output).toContain("metadata.json is missing or contains invalid JSON.");
  });

  it("handles metadata missing formatName gracefully", () => {
    const metaWithout = { ...baseMetadata };
    delete (metaWithout as Record<string, unknown>)["formatName"];

    const output = formatPreview(makeSuccess({ metadata: metaWithout }));

    // Should not throw, should produce some output
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("handles metadata missing projectIds gracefully", () => {
    const metaWithout = { ...baseMetadata };
    delete (metaWithout as Record<string, unknown>)["projectIds"];

    const output = formatPreview(makeSuccess({ metadata: metaWithout }));

    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (no implementation yet)**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test -- tests/preview-formatter.test.ts 2>&1 | tail -15
```

Expected: All tests fail with module not found or similar.

---

### Task 2: Implement `formatPreview`

**Files:**
- Create: `src/preview-formatter.ts`

- [ ] **Step 1: Write the full implementation**

Create `src/preview-formatter.ts`:

```typescript
import type { PreviewLoaderResult, PreviewLoaderSuccess } from "./preview-loader.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure formatter: converts a PreviewLoaderResult into a compact
 * terminal-friendly preview summary string. No I/O, no side effects.
 */
export function formatPreview(result: PreviewLoaderResult): string {
  if (result.outcome === "missing") {
    return formatMissing(result.message);
  }

  if (result.outcome === "malformed") {
    return formatMalformed(result.file, result.message);
  }

  return formatSuccess(result);
}

// ---------------------------------------------------------------------------
// Outcome formatters
// ---------------------------------------------------------------------------

function formatMissing(message: string): string {
  return `Error: ${message}`;
}

function formatMalformed(file: string, message: string): string {
  const filename = lastSegment(file);
  return `Error: ${message}\n  File: ${filename}`;
}

function formatSuccess(result: PreviewLoaderSuccess): string {
  const lines: string[] = [];

  // Header
  lines.push(`Draft Preview — ${result.targetDate} (${result.revision})`);
  lines.push(repeat("─", 50));

  // Metadata fields
  const formatName = readStringField(result.metadata, "formatName");
  if (formatName !== null) {
    lines.push(`Format:   ${formatName}`);
  }

  const projectIds = readStringArrayField(result.metadata, "projectIds");
  if (projectIds.length > 0) {
    lines.push(`Projects: ${projectIds.join(", ")}`);
  }

  // Safety status
  lines.push(formatSafetyLine(result.safetyReport.status, result.safetyReport.message));

  lines.push(repeat("─", 50));

  // Caption
  if (result.caption !== null) {
    lines.push("Caption:");
    lines.push(result.caption.trimEnd());
  } else {
    lines.push("Caption: (no caption found)");
  }

  lines.push(repeat("─", 50));

  // Carousel
  if (result.carouselPngs.length > 0) {
    lines.push(`Carousel (${result.carouselPngs.length} slide${result.carouselPngs.length === 1 ? "" : "s"}):`);
    for (const png of result.carouselPngs) {
      lines.push(`  ${png}`);
    }
  } else {
    lines.push("Carousel: text-only draft (not yet rendered — run `uncommitted render latest`)");
  }

  lines.push(repeat("─", 50));
  lines.push(`Draft folder: ${result.outputDir}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Safety line
// ---------------------------------------------------------------------------

function formatSafetyLine(status: string, message: string): string {
  if (status === "blocked") {
    return `Safety:   ⚠ BLOCKED — ${message}`;
  }

  if (status === "warning") {
    return `Safety:   ⚡ warning — ${message}`;
  }

  return `Safety:   safe`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStringField(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readStringArrayField(
  record: Record<string, unknown>,
  key: string
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function lastSegment(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? filePath;
}

function repeat(char: string, count: number): string {
  return char.repeat(count);
}
```

- [ ] **Step 2: Run the preview-formatter tests**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test -- tests/preview-formatter.test.ts 2>&1
```

Expected: All 14 tests pass.

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

Expected: All tests pass (only the pre-existing Playwright smoke tests fail as before).

- [ ] **Step 5: Run build**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm build 2>&1
```

Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
git add src/preview-formatter.ts tests/preview-formatter.test.ts docs/superpowers/plans/2026-05-19-unc-91-preview-formatter.md
git commit -m "$(cat <<'EOF'
✨ feat(preview-export): add human-readable preview formatter

Implements formatPreview(result: PreviewLoaderResult) → string, a pure
function that formats all three loader outcomes (success, missing, malformed)
into a compact terminal-friendly summary. Handles safe/warning/blocked safety
states, text-only vs rendered carousel, missing caption, and partial metadata
with graceful fallbacks.

- Add src/preview-formatter.ts with formatPreview()
- Add tests/preview-formatter.test.ts (14 tests covering all cases)

Refs: UNC-91
🤖 Generated with Routine B (Uncommitted Builder)
EOF
)"
```
