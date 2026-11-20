import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliOptions } from "../src/cli.js";
import { clearGlobalConfigCache } from "../src/global-config.js";
import type { GraphFetch } from "../src/instagram-account.js";
import type { HostingFetch } from "../src/instagram-hosting.js";
import type { KeychainRunner } from "../src/keychain-store.js";

// UNC-296: `uncommitted publish instagram` against a fake Graph API and fake
// S3 storage. No test here touches the network.

const IG_USER_ID = "17841400000000000";
const TOKEN = "IGTOKEN-secret-value-0123456789abcdef";
const ACCESS_KEY = "AKIDKEYCHAIN0123456789";
const SECRET_KEY = "keychain-secret-access-key-0123456789abcdef";
const PERMALINK = "https://www.instagram.com/p/ABC123/";
const DATE = "2026-11-20";
const HOSTING = {
  provider: "s3",
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "uncommitted-publish",
  region: "auto"
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function keychain(entries: Record<string, string>): KeychainRunner {
  return async (args) => {
    const service = args[args.indexOf("-s") + 1];
    const value = entries[service];
    return value === undefined
      ? { exitCode: 44, stdout: "" }
      : { exitCode: 0, stdout: `${value}\n` };
  };
}

const KEYCHAIN = {
  "instagram-access-token": TOKEN,
  "r2-access-key-id": ACCESS_KEY,
  "r2-secret-access-key": SECRET_KEY
};

function fakeS3() {
  const requests: { method: string; url: string }[] = [];
  const objects = new Map<string, Uint8Array>();
  const fetch: HostingFetch = async (input, init = {}) => {
    const method = init.method ?? "GET";
    requests.push({ method, url: input });
    const key = new URL(input).pathname;
    if (method === "PUT") {
      objects.set(key, init.body ?? new Uint8Array());
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 404 });
  };
  const count = (method: string) => requests.filter((r) => r.method === method).length;
  return { fetch, requests, objects, count };
}

type GraphCall = { method: string; path: string; params: URLSearchParams; url: string };

type FakeGraphOptions = {
  quotaUsage?: number;
  quotaTotal?: number;
  /** status_code for a container on its n-th status check (0-based). */
  status?: (id: string, check: number) => { status_code: string; status?: string };
  childCreateError?: boolean;
  /** Overrides the Meta error message returned for a child container. */
  childErrorMessage?: string;
  publishError?: boolean;
  permalinkError?: boolean;
  /** HTTP statuses media_publish returns before succeeding (UNC-298). */
  publishFailures?: number[];
  /** Container status lookups answer 500 (UNC-298). */
  containerStatusError?: boolean;
};

function fakeGraph(options: FakeGraphOptions = {}) {
  const calls: GraphCall[] = [];
  const checks = new Map<string, number>();
  let children = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: GraphFetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
    const params = method === "GET" ? url.searchParams : new URLSearchParams(init.body ?? "");
    calls.push({ method, path, params, url: input });

    if (params.get("access_token") !== TOKEN) {
      return json({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400);
    }
    if (method === "GET" && path === `/${IG_USER_ID}/content_publishing_limit`) {
      return json({
        data: [
          {
            quota_usage: options.quotaUsage ?? 3,
            config: { quota_total: options.quotaTotal ?? 100, quota_duration: 86400 }
          }
        ]
      });
    }
    if (method === "POST" && path === `/${IG_USER_ID}/media`) {
      if (params.get("media_type") === "CAROUSEL") {
        return json({ id: "carousel-1" });
      }
      if (options.childCreateError) {
        return json(
          {
            error: {
              message:
                options.childErrorMessage ??
                `Invalid parameter: could not fetch ${params.get("image_url")}`,
              code: 9004
            }
          },
          400
        );
      }
      children += 1;
      return json({ id: `child-${children}` });
    }
    if (method === "POST" && path === `/${IG_USER_ID}/media_publish`) {
      if (options.publishError) {
        return json({ error: { message: "Fatal publish error", code: 2 } }, 500);
      }
      const failure = options.publishFailures?.shift();
      if (failure !== undefined) {
        return json({ error: { message: `Publish failed with ${failure}`, code: 2 } }, failure);
      }
      return json({ id: "media-1" });
    }
    if (method === "GET" && path === "/media-1") {
      if (options.permalinkError) {
        return json({ error: { message: "temporarily unavailable", code: 2 } }, 500);
      }
      return json({ id: "media-1", permalink: PERMALINK });
    }
    if (method === "GET" && /^\/(child-\d+|carousel-1)$/.test(path)) {
      if (options.containerStatusError) {
        return json({ error: { message: "Service unavailable", code: 2 } }, 500);
      }
      const id = path.slice(1);
      const check = checks.get(id) ?? 0;
      checks.set(id, check + 1);
      const status = options.status?.(id, check) ?? { status_code: "FINISHED" };
      return json({ id, ...status });
    }
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  };

  const writes = () => calls.filter((call) => call.method === "POST");
  return { fetch, calls, writes };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();
}

type DraftOptions = {
  revision?: string;
  carouselCount?: number;
  caption?: string;
  safety?: { status: "safe" | "warning" | "blocked"; message?: string };
};

async function scaffoldDraft(draftRoot: string, opts: DraftOptions = {}): Promise<string> {
  const revision = opts.revision ?? "rev-001";
  const draftPath = join(draftRoot, DATE, revision);
  await mkdir(join(draftPath, "carousel"), { recursive: true });
  await writeFile(
    join(draftPath, "caption.txt"),
    opts.caption ?? "오늘은 테스트가 초록불이었다. 내일은 모르겠다. #uncommitted\n"
  );
  await writeFile(
    join(draftPath, "metadata.json"),
    JSON.stringify({ schemaVersion: 1, status: "complete" })
  );
  const safety = opts.safety ?? { status: "safe", message: "Safety check passed." };
  await writeFile(
    join(draftPath, "safety-report.json"),
    JSON.stringify({ schemaVersion: 1, risks: [], redactionsApplied: [], ...safety })
  );
  const png = await makePng();
  for (let i = 1; i <= (opts.carouselCount ?? 3); i++) {
    await writeFile(join(draftPath, "carousel", `${String(i).padStart(2, "0")}.png`), png);
  }
  await writeFile(
    join(draftRoot, "latest.json"),
    JSON.stringify({
      schemaVersion: 1,
      targetDate: DATE,
      revision,
      path: draftPath,
      updatedAt: "2026-11-20T23:30:00.000Z"
    })
  );
  return draftPath;
}

type Env = {
  homeDir: string;
  draftRoot: string;
  draftPath: string;
  graph: ReturnType<typeof fakeGraph>;
  s3: ReturnType<typeof fakeS3>;
  sleeps: number[];
  prompts: string[];
  options: CliOptions;
};

async function setup(
  opts: {
    draft?: DraftOptions;
    graph?: FakeGraphOptions;
    instagram?: Record<string, unknown> | null;
    answer?: boolean;
  } = {}
): Promise<Env> {
  const homeDir = await mkdtemp(join(tmpdir(), "ig-publish-"));
  const draftRoot = join(homeDir, "Uncommitted", "drafts");
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  const instagram =
    opts.instagram === null
      ? undefined
      : (opts.instagram ?? {
          igUserId: IG_USER_ID,
          username: "uncommitted.ai",
          appId: "123456",
          hosting: HOSTING
        });
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    JSON.stringify({ schemaVersion: 1, draftRoot: "~/Uncommitted/drafts", instagram })
  );
  const draftPath = await scaffoldDraft(draftRoot, opts.draft);

  const graph = fakeGraph(opts.graph);
  const s3 = fakeS3();
  const sleeps: number[] = [];
  const prompts: string[] = [];
  let clock = 0;
  const options: CliOptions = {
    homeDir,
    draftRoot,
    keychainRunner: keychain(KEYCHAIN),
    graphFetch: graph.fetch,
    hostingFetch: s3.fetch,
    now: () => "2026-11-20T23:31:00.000Z",
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    clock: () => clock,
    confirm: async (question) => {
      prompts.push(question);
      return opts.answer ?? true;
    }
  };
  return { homeDir, draftRoot, draftPath, graph, s3, sleeps, prompts, options };
}

async function run(args: string[], options: CliOptions) {
  clearGlobalConfigCache();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    args,
    { stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    options
  );
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function readRecord(draftPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(draftPath, "publish-record.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function recordExists(draftPath: string): Promise<boolean> {
  return readFile(join(draftPath, "publish-record.json")).then(
    () => true,
    () => false
  );
}

function expectNothingUploaded(env: Env) {
  expect(env.s3.requests).toEqual([]);
  expect(env.graph.writes()).toEqual([]);
}

/** AC7: no token, storage key, or presigned signature query in any output. */
function expectNoSecrets(...outputs: string[]) {
  for (const output of outputs) {
    for (const secret of [TOKEN, ACCESS_KEY, SECRET_KEY]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/X-Amz-(Signature|Credential)=/);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publish instagram", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC1: confirmed publish posts the latest draft as a carousel, prints the permalink and writes publish-record.json", async () => {
    const env = await setup();
    const result = await run(["publish", "instagram"], env.options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`게시됨: ${PERMALINK}`);
    // Preview shown before the prompt: slide count, caption head, safety.
    expect(result.stdout).toContain("3장");
    expect(result.stdout).toContain("오늘은 테스트가 초록불이었다.");
    expect(result.stdout).toContain("safe");
    expect(env.prompts).toHaveLength(1);

    const writes = env.graph.writes();
    const children = writes.filter((w) => w.params.get("is_carousel_item") === "true");
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.params.get("image_url")).toMatch(/^https:\/\//);
    }
    const carousel = writes.find((w) => w.params.get("media_type") === "CAROUSEL");
    expect(carousel?.params.get("children")).toBe("child-1,child-2,child-3");
    expect(carousel?.params.get("caption")).toBe(
      "오늘은 테스트가 초록불이었다. 내일은 모르겠다. #uncommitted"
    );
    const publish = writes.find((w) => w.path === `/${IG_USER_ID}/media_publish`);
    expect(publish?.params.get("creation_id")).toBe("carousel-1");
    // The access token travels in the POST body, never in a write URL.
    for (const write of writes) {
      expect(write.url).not.toContain(TOKEN);
    }

    // Every uploaded image is cleaned up after publishing.
    expect(env.s3.count("PUT")).toBe(3);
    expect(env.s3.count("DELETE")).toBe(3);
    expect(env.s3.objects.size).toBe(0);

    expect(await readRecord(env.draftPath)).toEqual({
      platform: "instagram",
      mediaId: "media-1",
      permalink: PERMALINK,
      publishedAt: "2026-11-20T23:31:00.000Z",
      safetyStatus: "safe"
    });
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC1: checks the publishing limit before uploading and uses the Graph API version constant", async () => {
    const env = await setup();
    await run(["publish", "instagram", "--yes"], env.options);

    const first = env.graph.calls[0];
    expect(first.method).toBe("GET");
    expect(first.path).toBe(`/${IG_USER_ID}/content_publishing_limit`);
    expect(first.url).toMatch(/^https:\/\/graph\.facebook\.com\/v24\.0\//);
  });

  it("AC1: polls IN_PROGRESS containers every minute until FINISHED", async () => {
    const env = await setup({
      graph: {
        status: (id, check) =>
          id === "child-2" && check < 2 ? { status_code: "IN_PROGRESS" } : { status_code: "FINISHED" }
      }
    });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(env.sleeps).toEqual([60_000, 60_000]);
  });

  it("AC1: --yes publishes without asking", async () => {
    const env = await setup();
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(env.prompts).toEqual([]);
    expect(await recordExists(env.draftPath)).toBe(true);
  });

  it("AC1: --date and --revision pick a revision other than latest", async () => {
    const env = await setup();
    const older = env.draftPath;
    const latest = await scaffoldDraft(env.draftRoot, { revision: "rev-002" });

    const result = await run(
      ["publish", "instagram", "--yes", "--date", DATE, "--revision", "rev-001"],
      env.options
    );

    expect(result.exitCode).toBe(0);
    expect(await recordExists(older)).toBe(true);
    expect(await recordExists(latest)).toBe(false);
  });

  it("AC1: declining the prompt uploads and publishes nothing", async () => {
    const env = await setup({ answer: false });
    const result = await run(["publish", "instagram"], env.options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("취소");
    expectNothingUploaded(env);
    expect(await recordExists(env.draftPath)).toBe(false);
  });

  it("AC2: an already published revision prints the permalink and exits 0 without any API call", async () => {
    const env = await setup();
    await writeFile(
      join(env.draftPath, "publish-record.json"),
      JSON.stringify({
        platform: "instagram",
        mediaId: "media-0",
        permalink: PERMALINK,
        publishedAt: "2026-11-19T23:31:00.000Z",
        safetyStatus: "safe"
      })
    );

    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`이미 게시됨: ${PERMALINK}`);
    expect(env.graph.calls).toEqual([]);
    expect(env.s3.requests).toEqual([]);
  });

  it("AC3: --dry-run validates and previews without uploading or any Graph write", async () => {
    const env = await setup();
    const result = await run(["publish", "instagram", "--dry-run"], env.options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3장");
    expect(result.stdout).toContain("오늘은 테스트가 초록불이었다.");
    expect(result.stdout).toContain("dry-run");
    expectNothingUploaded(env);
    expect(env.prompts).toEqual([]);
    expect(await recordExists(env.draftPath)).toBe(false);
  });

  it("AC4: a safety-blocked draft is refused with exit 6 before any upload", async () => {
    const env = await setup({ draft: { safety: { status: "blocked", message: "token found" } } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("blocked");
    expect(env.graph.calls).toEqual([]);
    expect(env.s3.requests).toEqual([]);
  });

  it("warning drafts show the warning in the confirmation prompt", async () => {
    const env = await setup({
      draft: { safety: { status: "warning", message: "Redacted a private URL." } }
    });
    const result = await run(["publish", "instagram"], env.options);

    expect(result.exitCode).toBe(0);
    expect(env.prompts[0]).toContain("Redacted a private URL.");
  });

  it("warning drafts with --yes print the warning and proceed", async () => {
    const env = await setup({
      draft: { safety: { status: "warning", message: "Redacted a private URL." } }
    });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Redacted a private URL.");
    expect((await readRecord(env.draftPath)).safetyStatus).toBe("warning");
  });

  it("AC5: a child container in ERROR stops before the carousel is published, prints the stage and Meta message, and cleans up", async () => {
    const env = await setup({
      graph: {
        status: (id) =>
          id === "child-2"
            ? { status_code: "ERROR", status: "Error: Media download has failed." }
            : { status_code: "FINISHED" }
      }
    });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("하위 컨테이너");
    expect(result.stderr).toContain("Media download has failed.");
    const writes = env.graph.writes();
    expect(writes.some((w) => w.params.get("media_type") === "CAROUSEL")).toBe(false);
    expect(writes.some((w) => w.path.endsWith("/media_publish"))).toBe(false);
    expect(env.s3.count("DELETE")).toBe(env.s3.count("PUT"));
    expect(env.s3.objects.size).toBe(0);
    expect(await recordExists(env.draftPath)).toBe(false);
  });

  it("AC5: containers that never finish time out after 5 minutes and are cleaned up", async () => {
    const env = await setup({ graph: { status: () => ({ status_code: "IN_PROGRESS" }) } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("하위 컨테이너");
    expect(env.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(300_000);
    expect(env.graph.writes().some((w) => w.path.endsWith("/media_publish"))).toBe(false);
    expect(env.s3.objects.size).toBe(0);
  });

  it("a media_publish failure reports the publish stage and writes no record", async () => {
    const env = await setup({ graph: { publishError: true } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("게시 실패 [게시]");
    expect(result.stderr).toContain("Fatal publish error");
    expect(env.s3.objects.size).toBe(0);
    expect(await recordExists(env.draftPath)).toBe(false);
  });

  it("a permalink lookup failure after publishing still records the post", async () => {
    const env = await setup({ graph: { permalinkError: true } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("permalink");
    const record = await readRecord(env.draftPath);
    expect(record.mediaId).toBe("media-1");
    expect(record.permalink).toBeNull();
  });

  it("records the media ID right after media_publish, before hosting cleanup", async () => {
    const env = await setup();
    const atCleanup: (Record<string, unknown> | null)[] = [];
    const s3Fetch = env.options.hostingFetch!;
    env.options.hostingFetch = async (url, init) => {
      if (init?.method === "DELETE") {
        atCleanup.push(await readRecord(env.draftPath).catch(() => null));
      }
      return s3Fetch(url, init);
    };

    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(atCleanup.length).toBeGreaterThan(0);
    for (const record of atCleanup) {
      expect(record).toMatchObject({ mediaId: "media-1", permalink: null });
    }
    expect((await readRecord(env.draftPath)).permalink).toBe(PERMALINK);
  });

  it("refuses while another publish holds the revision lock, and releases its own lock", async () => {
    const env = await setup();
    await writeFile(join(env.draftPath, "publish.lock"), "");

    const blocked = await run(["publish", "instagram", "--yes"], env.options);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("publish.lock");
    expectNothingUploaded(env);

    await rm(join(env.draftPath, "publish.lock"));
    const result = await run(["publish", "instagram", "--yes"], env.options);
    expect(result.exitCode).toBe(0);
    await expect(readFile(join(env.draftPath, "publish.lock"))).rejects.toThrow();
  });

  it("AC6: a reached content_publishing_limit stops before uploading", async () => {
    const env = await setup({ graph: { quotaUsage: 100, quotaTotal: 100 } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("한도");
    expect(result.stderr).toContain("100/100");
    expectNothingUploaded(env);
  });

  it("AC7: a Meta error echoing the presigned URL never leaks the signature, keys or token", async () => {
    const env = await setup({ graph: { childCreateError: true } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("could not fetch");
    // The child call really did carry a presigned URL; the output must not.
    const sent = env.graph.writes()[0]?.params.get("image_url") ?? "";
    expect(sent).toContain("X-Amz-Signature=");
    expectNoSecrets(result.stdout, result.stderr);
    expect(env.s3.objects.size).toBe(0);
  });

  it("AC7: masking stays linear on a Meta message made of many '?' characters", async () => {
    const env = await setup({
      graph: { childCreateError: true, childErrorMessage: "?".repeat(200_000) }
    });
    const started = Date.now();
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a single-image draft is refused before upload", async () => {
    const env = await setup({ draft: { carouselCount: 1 } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("최소 2장");
    expectNothingUploaded(env);
  });

  it("an unconnected account is a config error (exit 2) before upload", async () => {
    const env = await setup({ instagram: { hosting: HOSTING } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("instagram connect");
    expectNothingUploaded(env);
  });

  it("rejects unknown flags and --revision without --date", async () => {
    const env = await setup();
    expect((await run(["publish", "instagram", "--nope"], env.options)).exitCode).toBe(1);
    expect(
      (await run(["publish", "instagram", "--revision", "rev-001"], env.options)).exitCode
    ).toBe(1);
    expect((await run(["publish"], env.options)).exitCode).toBe(1);
    expectNothingUploaded(env);
  });
});

// ---------------------------------------------------------------------------
// UNC-298: failure record, --retry and transient retries
// ---------------------------------------------------------------------------

async function readAttempt(draftPath: string): Promise<Record<string, unknown> | null> {
  return readFile(join(draftPath, "publish-attempt.json"), "utf8").then(
    (raw) => JSON.parse(raw) as Record<string, unknown>,
    () => null
  );
}

describe("publish instagram failure record and --retry (UNC-298)", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC5: a media_publish failure leaves publish-attempt.json with stage, container ID and time, but no secrets", async () => {
    const env = await setup({ graph: { publishError: true } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    const raw = await readFile(join(env.draftPath, "publish-attempt.json"), "utf8");
    const attempt = JSON.parse(raw) as Record<string, unknown>;
    expect(attempt).toMatchObject({
      platform: "instagram",
      stage: "게시",
      carouselContainerId: "carousel-1",
      failedAt: "2026-11-20T23:31:00.000Z"
    });
    expect(typeof attempt.containerCreatedAt).toBe("string");
    for (const secret of [TOKEN, ACCESS_KEY, SECRET_KEY]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toMatch(/X-Amz-|r2\.cloudflarestorage\.com/);
  });

  it("AC3: --retry within 24 hours publishes the existing container without uploading again", async () => {
    const env = await setup({ graph: { publishError: true } });
    await run(["publish", "instagram", "--yes"], env.options);
    const putsBefore = env.s3.count("PUT");

    const graph = fakeGraph();
    const result = await run(["publish", "instagram", "--retry", "--yes"], {
      ...env.options,
      graphFetch: graph.fetch,
      now: () => "2026-11-21T10:00:00.000Z"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(PERMALINK);
    expect(env.s3.count("PUT")).toBe(putsBefore);
    expect(graph.writes().map((w) => w.path)).toEqual([`/${IG_USER_ID}/media_publish`]);
    expect(graph.writes()[0].params.get("creation_id")).toBe("carousel-1");
    expect(await readRecord(env.draftPath)).toMatchObject({ mediaId: "media-1" });
    expect(await readAttempt(env.draftPath)).toBeNull();
  });

  it("--retry after 24 hours starts over with a new upload", async () => {
    const env = await setup({ graph: { publishError: true } });
    await run(["publish", "instagram", "--yes"], env.options);
    const putsBefore = env.s3.count("PUT");

    const graph = fakeGraph();
    const result = await run(["publish", "instagram", "--retry", "--yes"], {
      ...env.options,
      graphFetch: graph.fetch,
      now: () => "2026-11-22T00:00:00.000Z"
    });

    expect(result.exitCode).toBe(0);
    expect(env.s3.count("PUT")).toBeGreaterThan(putsBefore);
    expect(graph.writes().filter((w) => w.path.endsWith("/media")).length).toBe(4);
  });

  it("--retry without a failure record runs the normal publish", async () => {
    const env = await setup();
    const result = await run(["publish", "instagram", "--retry", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(env.s3.count("PUT")).toBe(3);
    expect(await readRecord(env.draftPath)).toMatchObject({ mediaId: "media-1" });
  });

  it("--retry refuses when the stored container was already published", async () => {
    const env = await setup({ graph: { publishError: true } });
    await run(["publish", "instagram", "--yes"], env.options);

    const graph = fakeGraph({ status: () => ({ status_code: "PUBLISHED" }) });
    const result = await run(["publish", "instagram", "--retry", "--yes"], {
      ...env.options,
      graphFetch: graph.fetch,
      now: () => "2026-11-21T10:00:00.000Z"
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("Instagram에서");
    expect(graph.writes()).toEqual([]);
    expect(await recordExists(env.draftPath)).toBe(false);
  });

  it("AC4: two 503s from media_publish are retried with backoff and the post succeeds", async () => {
    const env = await setup({ graph: { publishFailures: [503, 503] } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(0);
    expect(env.graph.writes().filter((w) => w.path.endsWith("/media_publish")).length).toBe(3);
    expect(env.sleeps.filter((ms) => ms < 60_000).length).toBe(2);
    expect(await readRecord(env.draftPath)).toMatchObject({ mediaId: "media-1" });
  });

  it("AC4: a 4xx error is reported at once without retrying", async () => {
    const env = await setup({ graph: { childCreateError: true } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(env.graph.writes().filter((w) => w.path.endsWith("/media")).length).toBe(1);
    expect(env.sleeps).toEqual([]);
  });

  it("AC4: a third transient failure gives up and reports the stage", async () => {
    const env = await setup({ graph: { publishFailures: [503, 503, 503] } });
    const result = await run(["publish", "instagram", "--yes"], env.options);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("게시 실패 [게시]");
    expect(env.graph.writes().filter((w) => w.path.endsWith("/media_publish")).length).toBe(3);
  });

  it("--retry stops without uploading when the stored container's status cannot be read", async () => {
    const env = await setup({ graph: { publishError: true } });
    await run(["publish", "instagram", "--yes"], env.options);
    const putsBefore = env.s3.count("PUT");

    const graph = fakeGraph({ containerStatusError: true });
    const result = await run(["publish", "instagram", "--retry", "--yes"], {
      ...env.options,
      graphFetch: graph.fetch,
      now: () => "2026-11-21T10:00:00.000Z"
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("컨테이너 재사용 확인");
    expect(env.s3.count("PUT")).toBe(putsBefore);
    expect(graph.writes()).toEqual([]);
    expect(await readAttempt(env.draftPath)).toMatchObject({ carouselContainerId: "carousel-1" });
  });

  it("--retry starts over when the stored container has EXPIRED", async () => {
    const env = await setup({ graph: { publishError: true } });
    await run(["publish", "instagram", "--yes"], env.options);
    const putsBefore = env.s3.count("PUT");

    const graph = fakeGraph({
      status: (id) => ({ status_code: id === "carousel-1" ? "EXPIRED" : "FINISHED" })
    });
    const result = await run(["publish", "instagram", "--retry", "--yes"], {
      ...env.options,
      graphFetch: graph.fetch,
      now: () => "2026-11-21T10:00:00.000Z"
    });

    expect(result.stdout).toContain("EXPIRED");
    expect(env.s3.count("PUT")).toBeGreaterThan(putsBefore);
  });
});
