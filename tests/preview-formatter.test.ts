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
  mood: "grind",
  angle: "The day circled a concrete signal.",
  storyFormatVoice: "casual",
  storyFormatTone: "warm",
  projectIds: ["proj-1", "proj-2"],
  entryMode: "daily_global",
  slideCount: 3
};

// Pre-mood-engine drafts only ever carried `formatName` — the loader must
// still read a value for the preview without throwing (UNC-215).
const legacyMetadataWithFormatName = {
  ...baseMetadata,
  mood: undefined,
  angle: undefined,
  formatName: "daily-summary"
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

  it("includes mood from metadata", () => {
    const output = formatPreview(makeSuccess({}));

    expect(output).toContain("Mood:");
    expect(output).toContain("grind");
  });

  it("falls back to legacy formatName when mood is absent (UNC-215)", () => {
    const output = formatPreview(
      makeSuccess({ metadata: legacyMetadataWithFormatName })
    );

    expect(output).toContain("Mood:");
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

  it("handles metadata missing mood gracefully", () => {
    const metaWithout = { ...baseMetadata };
    delete (metaWithout as Record<string, unknown>)["mood"];

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
