import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  saveFeedback,
  readFeedback,
  type SaveFeedbackOptions
} from "../src/feedback-storage.js";
import type { FeedbackRecord } from "../src/feedback-types.js";

function makeTmpDir(): string {
  return join(tmpdir(), `unc-feedback-test-${randomUUID()}`);
}

const baseRecord: FeedbackRecord = {
  date: "2026-05-19",
  revision: "rev-001",
  mood: "grind",
  fun: 4,
  share: 3,
  accuracy: 5,
  safetyConcern: false,
  wouldPost: false,
  reasons: ["weak-caption"],
  note: "캡션이 너무 담백함",
  createdAt: "2026-05-19T23:30:00.000Z"
};

describe("saveFeedback", () => {
  it("writes feedback.json to the draft directory", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir, { recursive: true });

    await saveFeedback(baseRecord, draftDir, evalsDir);

    const content = JSON.parse(
      await readFile(join(draftDir, "feedback.json"), "utf8")
    ) as unknown;
    expect(content).toEqual(baseRecord);
  });

  it("appends one JSON line to daily-feedback.jsonl", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir, { recursive: true });

    await saveFeedback(baseRecord, draftDir, evalsDir);

    const jsonlPath = join(evalsDir, "daily-feedback.jsonl");
    const lines = (await readFile(jsonlPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.date).toBe("2026-05-19");
    expect(parsed.revision).toBe("rev-001");
    expect(parsed.mood).toBe("grind");
    expect(parsed.fun).toBe(4);
    expect(parsed.share).toBe(3);
    expect(parsed.accuracy).toBe(5);
    expect(parsed.wouldPost).toBe(false);
    expect(parsed.reasons).toEqual(["weak-caption"]);
    expect(parsed.note).toBe("캡션이 너무 담백함");
  });

  it("appends multiple records as separate JSONL lines", async () => {
    const draftDir1 = join(makeTmpDir(), "2026-05-19", "rev-001");
    const draftDir2 = join(makeTmpDir(), "2026-05-20", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir1, { recursive: true });
    await mkdir(draftDir2, { recursive: true });

    const record2: FeedbackRecord = {
      ...baseRecord,
      date: "2026-05-20",
      mood: "breakthrough",
      fun: 5,
      wouldPost: true,
      reasons: [],
      note: ""
    };

    await saveFeedback(baseRecord, draftDir1, evalsDir);
    await saveFeedback(record2, draftDir2, evalsDir);

    const jsonlPath = join(evalsDir, "daily-feedback.jsonl");
    const lines = (await readFile(jsonlPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(first.date).toBe("2026-05-19");
    expect(second.date).toBe("2026-05-20");
  });

  it("auto-creates the evals directory if it does not exist", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = join(makeTmpDir(), "nested", "evals");
    await mkdir(draftDir, { recursive: true });

    await expect(saveFeedback(baseRecord, draftDir, evalsDir)).resolves.not.toThrow();

    const jsonlPath = join(evalsDir, "daily-feedback.jsonl");
    const text = await readFile(jsonlPath, "utf8");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("calls confirm callback and overwrites when confirmed", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir, { recursive: true });

    // First save
    await saveFeedback(baseRecord, draftDir, evalsDir);

    // Second save with overwrite confirmed
    const updatedRecord: FeedbackRecord = { ...baseRecord, fun: 1, note: "updated" };
    const confirmFn = vi.fn().mockResolvedValue(true);

    const opts: SaveFeedbackOptions = { confirmOverwrite: confirmFn };
    await saveFeedback(updatedRecord, draftDir, evalsDir, opts);

    expect(confirmFn).toHaveBeenCalledOnce();

    const content = JSON.parse(
      await readFile(join(draftDir, "feedback.json"), "utf8")
    ) as FeedbackRecord;
    expect(content.fun).toBe(1);
    expect(content.note).toBe("updated");
  });

  it("calls confirm callback and skips overwrite when denied", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir, { recursive: true });

    // First save
    await saveFeedback(baseRecord, draftDir, evalsDir);

    // Second save with overwrite denied
    const updatedRecord: FeedbackRecord = { ...baseRecord, fun: 1, note: "denied" };
    const confirmFn = vi.fn().mockResolvedValue(false);

    const opts: SaveFeedbackOptions = { confirmOverwrite: confirmFn };
    await saveFeedback(updatedRecord, draftDir, evalsDir, opts);

    expect(confirmFn).toHaveBeenCalledOnce();

    // Original should remain unchanged
    const content = JSON.parse(
      await readFile(join(draftDir, "feedback.json"), "utf8")
    ) as FeedbackRecord;
    expect(content.fun).toBe(4);
    expect(content.note).toBe("캡션이 너무 담백함");
  });

  it("overwrites without confirm when no confirmOverwrite is provided", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir, { recursive: true });

    await saveFeedback(baseRecord, draftDir, evalsDir);

    const updatedRecord: FeedbackRecord = { ...baseRecord, fun: 2, note: "no confirm" };
    await saveFeedback(updatedRecord, draftDir, evalsDir);

    const content = JSON.parse(
      await readFile(join(draftDir, "feedback.json"), "utf8")
    ) as FeedbackRecord;
    expect(content.fun).toBe(2);
  });
});

describe("readFeedback", () => {
  it("returns the stored FeedbackRecord after saving", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    const evalsDir = makeTmpDir();
    await mkdir(draftDir, { recursive: true });

    await saveFeedback(baseRecord, draftDir, evalsDir);
    const result = await readFeedback(draftDir);

    expect(result).toEqual(baseRecord);
  });

  it("returns null when feedback.json does not exist", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    await mkdir(draftDir, { recursive: true });

    const result = await readFeedback(draftDir);
    expect(result).toBeNull();
  });

  it("reads a legacy feedback.json carrying formatName instead of mood without throwing (UNC-215)", async () => {
    const draftDir = join(makeTmpDir(), "2026-05-19", "rev-001");
    await mkdir(draftDir, { recursive: true });

    const legacyRecord = {
      date: "2026-05-19",
      revision: "rev-001",
      formatName: "AI의 퇴근일지",
      fun: 4,
      share: 3,
      accuracy: 5,
      safetyConcern: false,
      wouldPost: false,
      reasons: ["weak-caption"],
      note: "캡션이 너무 담백함",
      createdAt: "2026-05-19T23:30:00.000Z"
    };
    await writeFile(
      join(draftDir, "feedback.json"),
      JSON.stringify(legacyRecord),
      "utf8"
    );

    const result = await readFeedback(draftDir);

    expect(result).not.toBeNull();
    expect(result!.mood).toBe("AI의 퇴근일지");
    expect(result!.fun).toBe(4);
  });
});
