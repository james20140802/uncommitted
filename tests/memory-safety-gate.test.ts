import { describe, expect, it } from "vitest";
import {
  gateCoreFactForInjection,
  gateMemoryForInjection,
  gateThreadForInjection
} from "../src/memory-safety-gate.js";
import type { MemoryThread } from "../src/memory-store.js";

function thread(note: string): MemoryThread {
  return {
    id: "t",
    firstSeen: "2026-07-10T00:00:00.000Z",
    lastSeen: "2026-07-15T00:00:00.000Z",
    kind: "bug",
    note,
    status: "active",
    decay: 1
  };
}

// Verified against src/safety-report.ts detection rules directly (see
// task-4-report.md): "SECRET=..." matches the `secret` rule (blocked),
// an email address matches the `email` rule (warning). Note: the naive
// "AWS_SECRET_ACCESS_KEY=..." form does NOT match the secret rule's
// alternation (it requires the literal keyword immediately before `=`,
// and "ACCESS_KEY" is not one of the recognized keywords) — using a
// verified-blocking string instead.
const BLOCKED_NOTE = "leaked SECRET=abc123def456 in the logs";
const WARNING_NOTE = "emailed alice@example.com about the bug";
const CLEAN_NOTE = "race condition again";

describe("gateThreadForInjection", () => {
  it("drops a thread whose note is blocked by checkDraftSafety", () => {
    expect(gateThreadForInjection(thread(BLOCKED_NOTE))).toBeNull();
  });

  it("redacts but keeps a thread whose note is a warning", () => {
    const gated = gateThreadForInjection(thread(WARNING_NOTE));

    expect(gated).not.toBeNull();
    expect(gated?.note).toBe("emailed [redacted-email] about the bug");
    expect(gated?.note.includes("alice@example.com")).toBe(false);
  });

  it("passes a clean note through unchanged", () => {
    const gated = gateThreadForInjection(thread(CLEAN_NOTE));

    expect(gated).toEqual(thread(CLEAN_NOTE));
  });
});

describe("gateCoreFactForInjection", () => {
  it("drops a blocked fact", () => {
    expect(gateCoreFactForInjection(BLOCKED_NOTE)).toBeNull();
  });

  it("redacts but keeps a warning fact", () => {
    expect(gateCoreFactForInjection("contact me at bob@example.com")).toBe(
      "contact me at [redacted-email]"
    );
  });

  it("passes a clean fact through unchanged", () => {
    expect(gateCoreFactForInjection("prefers TDD")).toBe("prefers TDD");
  });
});

describe("gateMemoryForInjection", () => {
  it("drops blocked notes and redacts warnings before injection", () => {
    const blocked = thread(BLOCKED_NOTE);
    const warn = thread(WARNING_NOTE);
    const clean = thread(CLEAN_NOTE);

    const out = gateMemoryForInjection({
      threads: [blocked, warn, clean],
      coreFacts: ["contact me at bob@example.com", "prefers TDD"]
    });

    expect(out.threads).toHaveLength(2);
    expect(out.threads.some((t) => t.note.includes("SECRET"))).toBe(false);
    expect(
      out.threads.find((t) => t.note.includes("race condition again"))
    ).toBeTruthy();
    expect(out.coreFacts.some((f) => f.includes("bob@example.com"))).toBe(
      false
    );
    expect(out.coreFacts).toContain("prefers TDD");
    expect(out.coreFacts).toHaveLength(2);
  });
});
