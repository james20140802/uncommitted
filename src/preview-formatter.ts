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
