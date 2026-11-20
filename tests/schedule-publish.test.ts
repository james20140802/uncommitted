import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublishDeps, PublishOutcome } from "../src/instagram-publish.js";
import {
  appendSchedulePublishLog,
  describePublishOutcome,
  isPublishSkipped,
  parsePublishDelay,
  readLastSchedulePublishLog,
  readSchedulePublishSetting,
  removeScheduleSettings,
  runScheduledPublish,
  waitForPublishDeadline,
  writePublishSkip,
  writeScheduleSettings
} from "../src/schedule-publish.js";
import {
  fakeGraph,
  fakeKeychain,
  fakeS3,
  IG_TOKEN,
  INSTAGRAM_CONFIG,
  instagramPng,
  PERMALINK,
  R2_SECRET_KEY
} from "./instagram-fakes.js";

// UNC-297: scheduled Instagram auto-publish. Fake Graph API / S3 / keychain
// only — no test here touches the network or the real keychain.

const DATE = "2026-11-20";

type DraftOptions = {
  safety?: "safe" | "warning" | "blocked";
  metadataStatus?: "complete" | "incomplete";
  published?: boolean;
};

async function scaffoldDraft(draftRoot: string, opts: DraftOptions = {}): Promise<string> {
  const draftPath = join(draftRoot, DATE, "rev-001");
  await mkdir(join(draftPath, "carousel"), { recursive: true });
  await writeFile(join(draftPath, "caption.txt"), "오늘은 테스트가 초록불이었다. #uncommitted\n");
  await writeFile(
    join(draftPath, "metadata.json"),
    JSON.stringify({ schemaVersion: 1, status: opts.metadataStatus ?? "complete" })
  );
  await writeFile(
    join(draftPath, "safety-report.json"),
    JSON.stringify({
      schemaVersion: 1,
      status: opts.safety ?? "safe",
      message: "check",
      risks: [],
      redactionsApplied: []
    })
  );
  const png = await instagramPng();
  for (let i = 1; i <= 3; i++) {
    await writeFile(join(draftPath, "carousel", `0${i}.png`), png);
  }
  if (opts.published) {
    await writeFile(
      join(draftPath, "publish-record.json"),
      JSON.stringify({ platform: "instagram", mediaId: "old-1", permalink: PERMALINK })
    );
  }
  return draftPath;
}

async function setup(opts: DraftOptions & { networkErrorOn?: "media" } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), "schedule-publish-"));
  const draftRoot = join(homeDir, "Uncommitted", "drafts");
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    JSON.stringify({ schemaVersion: 1, draftRoot, instagram: INSTAGRAM_CONFIG })
  );
  const draftPath = await scaffoldDraft(draftRoot, opts);
  const graph = fakeGraph({ networkErrorOn: opts.networkErrorOn });
  const s3 = fakeS3();
  const keychain = fakeKeychain();
  let clock = 0;
  const sleeps: number[] = [];
  const deps: PublishDeps = {
    draftRoot,
    homeDir,
    keychainRunner: keychain.runner,
    graphFetch: graph.fetch,
    hostingFetch: s3.fetch,
    now: () => "2026-11-20T23:31:00.000Z",
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    clock: () => clock
  };
  const out: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(line) };
  return { homeDir, draftRoot, draftPath, graph, s3, deps, io, out, sleeps };
}

describe("parsePublishDelay", () => {
  it("accepts minutes and hours", () => {
    expect(parsePublishDelay("30m")).toBe(30);
    expect(parsePublishDelay("2h")).toBe(120);
    expect(parsePublishDelay("0m")).toBe(0);
  });

  it("rejects values without a unit or out of range", () => {
    for (const value of ["30", "abc", "-5m", "1.5h", "13h"]) {
      expect(() => parsePublishDelay(value)).toThrow(/--publish-delay/);
    }
  });
});

describe("schedule settings", () => {
  it("round-trips the publish setting and removes it", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "schedule-settings-"));
    expect(await readSchedulePublishSetting(homeDir)).toBeNull();

    await writeScheduleSettings(homeDir, { platform: "instagram", delayMinutes: 30 });
    expect(await readSchedulePublishSetting(homeDir)).toEqual({
      platform: "instagram",
      delayMinutes: 30
    });

    await writeScheduleSettings(homeDir, null);
    expect(await readSchedulePublishSetting(homeDir)).toBeNull();

    await writeScheduleSettings(homeDir, { platform: "instagram", delayMinutes: 0 });
    await removeScheduleSettings(homeDir);
    expect(await readSchedulePublishSetting(homeDir)).toBeNull();
  });

  it("treats a damaged settings file as auto-publish off", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "schedule-settings-"));
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "schedule.json"), "{not json");
    expect(await readSchedulePublishSetting(homeDir)).toBeNull();
  });
});

describe("publish skip marker", () => {
  it("marks a date folder even before the draft exists", async () => {
    const draftRoot = join(await mkdtemp(join(tmpdir(), "publish-skip-")), "drafts");
    expect(await isPublishSkipped(draftRoot, DATE)).toBe(false);
    const path = await writePublishSkip(draftRoot, DATE, "2026-11-20T23:40:00.000Z");
    expect(path).toBe(join(draftRoot, DATE, "publish-skip.json"));
    expect(await isPublishSkipped(draftRoot, DATE)).toBe(true);
    expect(await isPublishSkipped(draftRoot, "2026-11-21")).toBe(false);
  });
});

describe("waitForPublishDeadline", () => {
  it("waits by wall clock in short steps, so a jump (laptop sleep) ends the wait", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const result = await waitForPublishDeadline({
      delayMs: 30 * 60_000,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        // The second step "sleeps" through 40 minutes of wall-clock time.
        now += sleeps.length === 2 ? 40 * 60_000 : ms;
      },
      isSkipped: async () => false
    });
    expect(result).toBe("ready");
    expect(sleeps).toHaveLength(2);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });

  it("stops waiting as soon as the day is skipped", async () => {
    let now = 0;
    let checks = 0;
    const result = await waitForPublishDeadline({
      delayMs: 30 * 60_000,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      isSkipped: async () => ++checks >= 3
    });
    expect(result).toBe("skipped");
    expect(now).toBeLessThan(30 * 60_000);
  });
});

describe("runScheduledPublish", () => {
  it("publishes a safe draft and returns the permalink", async () => {
    const env = await setup();
    const outcome = await runScheduledPublish({
      targetDate: DATE,
      setting: { platform: "instagram", delayMinutes: 0 },
      deps: env.deps,
      io: env.io
    });
    expect(outcome).toEqual({
      kind: "published",
      date: DATE,
      revision: "rev-001",
      mediaId: "media-1",
      permalink: PERMALINK
    });
    expect(env.graph.writes().some((call) => call.path.endsWith("/media_publish"))).toBe(true);
    expect(env.out.join("\n")).not.toContain(IG_TOKEN);
  });

  it.each([
    ["warning", { safety: "warning" as const }, "safety-warning"],
    ["blocked", { safety: "blocked" as const }, "safety-blocked"],
    ["incomplete", { metadataStatus: "incomplete" as const }, "incomplete-draft"],
    ["already published", { published: true }, "already-published"]
  ])("skips a %s draft without calling the Graph API", async (_label, draft, reason) => {
    const env = await setup(draft);
    const outcome = await runScheduledPublish({
      targetDate: DATE,
      setting: { platform: "instagram", delayMinutes: 0 },
      deps: env.deps,
      io: env.io
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason, date: DATE });
    expect(env.graph.calls).toEqual([]);
    expect(env.s3.count("PUT")).toBe(0);
  });

  it("skips a day the user skipped, even with no delay", async () => {
    const env = await setup();
    await writePublishSkip(env.draftRoot, DATE, "2026-11-20T23:00:00.000Z");
    const outcome = await runScheduledPublish({
      targetDate: DATE,
      setting: { platform: "instagram", delayMinutes: 0 },
      deps: env.deps,
      io: env.io
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason: "user-skip" });
    expect(env.graph.calls).toEqual([]);
  });

  it("honors a skip made during the delay", async () => {
    const env = await setup();
    let slept = 0;
    const outcome = await runScheduledPublish({
      targetDate: DATE,
      setting: { platform: "instagram", delayMinutes: 30 },
      deps: {
        ...env.deps,
        sleep: async (ms) => {
          slept += ms;
          if (slept >= 5 * 60_000) {
            await writePublishSkip(env.draftRoot, DATE, "2026-11-20T23:36:00.000Z");
          }
          await env.deps.sleep?.(ms);
        }
      },
      io: env.io
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason: "user-skip" });
    expect(env.graph.calls).toEqual([]);
  });

  it("returns a failed outcome with the stage on a network error and keeps the draft", async () => {
    const env = await setup({ networkErrorOn: "media" });
    const outcome = await runScheduledPublish({
      targetDate: DATE,
      setting: { platform: "instagram", delayMinutes: 0 },
      deps: env.deps,
      io: env.io
    });
    expect(outcome).toMatchObject({ kind: "failed", stage: "하위 컨테이너 생성", date: DATE });
    if (outcome.kind === "failed") {
      expect(outcome.message).not.toContain(IG_TOKEN);
      expect(outcome.message).not.toContain(R2_SECRET_KEY);
    }
    await access(join(env.draftPath, "caption.txt"));
    await access(join(env.draftPath, "carousel", "01.png"));
    await expect(access(join(env.draftPath, "publish-record.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("skips when the day has no draft", async () => {
    const env = await setup();
    const outcome = await runScheduledPublish({
      targetDate: "2026-11-19",
      setting: { platform: "instagram", delayMinutes: 0 },
      deps: env.deps,
      io: env.io
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason: "no-draft" });
  });
});

describe("schedule publish log", () => {
  it("appends outcomes and reads back the last one", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "schedule-log-"));
    expect(await readLastSchedulePublishLog(homeDir)).toBeNull();

    const first: PublishOutcome = { kind: "skipped", reason: "safety-warning", date: DATE };
    const second: PublishOutcome = {
      kind: "failed",
      stage: "게시",
      message: "Meta Graph API에 연결하지 못했습니다.",
      date: DATE
    };
    await appendSchedulePublishLog(homeDir, first, "2026-11-20T23:31:00.000Z");
    await appendSchedulePublishLog(homeDir, second, "2026-11-21T23:31:00.000Z");

    expect(await readLastSchedulePublishLog(homeDir)).toEqual({
      at: "2026-11-21T23:31:00.000Z",
      outcome: second
    });
    const raw = await readFile(
      join(homeDir, ".uncommitted", "logs", "schedule-publish.jsonl"),
      "utf8"
    );
    expect(raw.trim().split("\n")).toHaveLength(2);
  });
});

describe("describePublishOutcome", () => {
  it("names the permalink, the skip reason, or the failed stage", () => {
    expect(
      describePublishOutcome({
        kind: "published",
        date: DATE,
        revision: "rev-001",
        mediaId: "media-1",
        permalink: PERMALINK
      })
    ).toBe(`게시됨: ${PERMALINK}`);
    expect(describePublishOutcome({ kind: "skipped", reason: "safety-warning", date: DATE })).toBe(
      "건너뜀: safety warning"
    );
    expect(describePublishOutcome({ kind: "skipped", reason: "user-skip", date: DATE })).toBe(
      "건너뜀: 사용자 skip"
    );
    expect(
      describePublishOutcome({ kind: "failed", stage: "게시", message: "끊김", date: DATE })
    ).toBe("실패 [게시]: 끊김");
  });
});
