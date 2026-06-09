import { describe, expect, it } from "vitest";
import {
  isActivitySignal,
  type ActivitySignal,
  type ActivitySignalKind,
  type EventSource
} from "../src/event-source.js";

describe("event-source contract", () => {
  it("accepts a valid signal with all required fields and empty safetyNotes", () => {
    const signal: ActivitySignal = {
      projectId: "cli",
      timestamp: "2026-06-10T10:00:00.000Z",
      kind: "commit",
      summary: "implement collect git command",
      safetyNotes: []
    };

    expect(isActivitySignal(signal)).toBe(true);
  });

  it("accepts safetyNotes carrying redaction categories", () => {
    const signal: ActivitySignal = {
      projectId: "cli",
      timestamp: "2026-06-10T10:00:00.000Z",
      kind: "note",
      summary: "Planned activity with [redacted-email]",
      safetyNotes: ["emails"]
    };

    expect(isActivitySignal(signal)).toBe(true);
  });

  it("rejects signals missing required fields", () => {
    expect(isActivitySignal({})).toBe(false);
    expect(
      isActivitySignal({
        projectId: "cli",
        timestamp: "2026-06-10T10:00:00.000Z",
        kind: "commit",
        summary: "missing safetyNotes"
      })
    ).toBe(false);
  });

  it("rejects non-array safetyNotes", () => {
    expect(
      isActivitySignal({
        projectId: "cli",
        timestamp: "2026-06-10T10:00:00.000Z",
        kind: "commit",
        summary: "bad shape",
        safetyNotes: "emails"
      })
    ).toBe(false);
  });

  it("treats kind as an extensible string so future sources are not blocked at the contract level", () => {
    const futureSignal: ActivitySignal = {
      projectId: "cli",
      timestamp: "2026-06-10T10:00:00.000Z",
      kind: "claude-session" as ActivitySignalKind,
      summary: "Claude session summary placeholder",
      safetyNotes: []
    };

    expect(isActivitySignal(futureSignal)).toBe(true);
  });

  it("permits any object implementing collect() to satisfy EventSource", async () => {
    const source: EventSource = {
      async collect() {
        return [
          {
            projectId: "cli",
            timestamp: "2026-06-10T10:00:00.000Z",
            kind: "commit",
            summary: "fixture",
            safetyNotes: []
          }
        ];
      }
    };

    const signals = await source.collect();
    expect(signals).toHaveLength(1);
    expect(isActivitySignal(signals[0])).toBe(true);
  });
});
