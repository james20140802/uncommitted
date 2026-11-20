import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliOptions } from "../src/cli.js";
import { clearGlobalConfigCache } from "../src/global-config.js";
import type { KeychainRunner } from "../src/keychain-store.js";
import {
  HOSTING_NOT_CONFIGURED_MESSAGE,
  HostingError,
  type HostingFetch,
  type ImageHost,
  resolveImageHost,
  withHostedImages
} from "../src/instagram-hosting.js";

const ACCESS_KEY = "AKIDKEYCHAIN0123456789";
const SECRET_KEY = "keychain-secret-access-key-0123456789abcdef";
const CONFIG_ACCESS_KEY = "AKIDCONFIG0123456789";
const CONFIG_SECRET_KEY = "config-secret-access-key-0123456789abcdef";
const ENDPOINT = "https://acct123.r2.cloudflarestorage.com";
const BUCKET = "uncommitted-publish";

type Recorded = {
  method: string;
  url: URL;
  headers: Record<string, string>;
};

type FakeS3Options = {
  /** Override the status of the anonymous GET while the object exists. */
  getStatus?: number;
  deleteStatus?: number;
  putStatus?: number;
};

/** In-memory S3: PUT/DELETE need SigV4 headers; GET is anonymous (presigned/public). */
function fakeS3(options: FakeS3Options = {}) {
  const objects = new Map<string, Uint8Array>();
  const requests: Recorded[] = [];
  const fetch: HostingFetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    requests.push({ method, url, headers });
    const key = url.pathname;
    if (method === "PUT") {
      if (!headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=")) {
        return new Response("", { status: 403 });
      }
      if (options.putStatus) return new Response("", { status: options.putStatus });
      objects.set(key, init.body ?? new Uint8Array());
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      if (options.deleteStatus) return new Response("", { status: options.deleteStatus });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const body = objects.get(key);
    if (!body) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    if (options.getStatus) return new Response("", { status: options.getStatus });
    return new Response(Buffer.from(body), { status: 200 });
  };
  return { fetch, requests, objects };
}

function keychain(entries: Record<string, string>): KeychainRunner {
  return async (args) => {
    const service = args[args.indexOf("-s") + 1];
    const value = entries[service];
    return value === undefined
      ? { exitCode: 44, stdout: "" }
      : { exitCode: 0, stdout: `${value}\n` };
  };
}

const KEYCHAIN_KEYS = {
  "r2-access-key-id": ACCESS_KEY,
  "r2-secret-access-key": SECRET_KEY
};

const HOSTING = { provider: "s3", endpoint: ENDPOINT, bucket: BUCKET, region: "auto" };

async function makeHome(
  extra: Record<string, unknown> = {},
  prefix = "ig-hosting-"
): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    JSON.stringify({ schemaVersion: 1, draftRoot: "~/Uncommitted/drafts", ...extra })
  );
  return homeDir;
}

async function readConfig(homeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
  ) as Record<string, unknown>;
}

async function run(args: string[], options: CliOptions) {
  clearGlobalConfigCache();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    args,
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    },
    options
  );
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function expectNoSecrets(...outputs: string[]) {
  for (const output of outputs) {
    for (const secret of [ACCESS_KEY, SECRET_KEY, CONFIG_ACCESS_KEY, CONFIG_SECRET_KEY]) {
      expect(output).not.toContain(secret);
    }
  }
}

function jpeg(): { bytes: Uint8Array; contentType: string } {
  return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" };
}

/** A fake host that records uploads and cleanups without any network. */
function fakeHost(options: { failCleanup?: boolean; failUploadAt?: number } = {}) {
  const uploaded: string[] = [];
  const cleaned: string[] = [];
  const host: ImageHost = {
    async upload() {
      if (options.failUploadAt === uploaded.length) {
        throw new HostingError("업로드 실패", 1);
      }
      const url = `https://fake.example/${uploaded.length + 1}.jpg`;
      uploaded.push(url);
      return {
        url,
        async cleanup() {
          if (options.failCleanup) throw new Error("delete failed");
          cleaned.push(url);
        }
      };
    }
  };
  return { host, uploaded, cleaned };
}

describe("instagram host set", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("stores endpoint, bucket and region in config without any secret", async () => {
    const homeDir = await makeHome();

    const result = await run(
      ["instagram", "host", "set", "--endpoint", `${ENDPOINT}/`, "--bucket", BUCKET],
      { homeDir, keychainRunner: keychain(KEYCHAIN_KEYS) }
    );

    expect(result.exitCode).toBe(0);
    const config = await readConfig(homeDir);
    expect((config.instagram as Record<string, unknown>).hosting).toEqual({
      provider: "s3",
      endpoint: ENDPOINT,
      bucket: BUCKET,
      region: "auto"
    });
    expect(result.stdout).toContain("uncommitted instagram host test");
  });

  it("--keys-from-stdin saves both keys to config at 0600 without echoing them", async () => {
    const homeDir = await makeHome();

    const result = await run(
      [
        "instagram",
        "host",
        "set",
        "--endpoint",
        ENDPOINT,
        "--bucket",
        BUCKET,
        "--keys-from-stdin"
      ],
      {
        homeDir,
        keychainRunner: keychain({}),
        readStdin: async () => `${CONFIG_ACCESS_KEY}\n${CONFIG_SECRET_KEY}\n`
      }
    );

    expect(result.exitCode).toBe(0);
    const config = await readConfig(homeDir);
    expect(config.secrets).toMatchObject({
      hostingAccessKeyId: CONFIG_ACCESS_KEY,
      hostingSecretAccessKey: CONFIG_SECRET_KEY
    });
    const mode = (await stat(join(homeDir, ".uncommitted", "config.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("rejects a non-https endpoint", async () => {
    const homeDir = await makeHome();
    const result = await run(
      ["instagram", "host", "set", "--endpoint", "http://example.com", "--bucket", BUCKET],
      { homeDir }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("https");
  });
});

describe("instagram host test", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC1: upload → anonymous GET 200 → delete → GET fails, then prints 호스팅 OK", async () => {
    const homeDir = await makeHome({ instagram: { hosting: HOSTING } });
    const s3 = fakeS3();

    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: s3.fetch
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("호스팅 OK");
    expect(s3.requests.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE", "GET"]);
    const [put, get, , getAfter] = s3.requests;
    expect(put.url.origin).toBe(ENDPOINT);
    expect(put.url.pathname.startsWith(`/${BUCKET}/uncommitted/`)).toBe(true);
    // Anonymous: no Authorization header, presigned query instead.
    expect(get.headers.authorization).toBeUndefined();
    expect(get.url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(get.url.pathname).toBe(put.url.pathname);
    expect(getAfter.url.pathname).toBe(put.url.pathname);
    expect(s3.objects.size).toBe(0);
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC1: reports a one-line failure and still deletes when the public GET fails", async () => {
    const homeDir = await makeHome({ instagram: { hosting: HOSTING } });
    const s3 = fakeS3({ getStatus: 403 });

    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: s3.fetch
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("호스팅 실패");
    expect(result.stderr).toContain("403");
    expect(s3.requests.map((r) => r.method)).toContain("DELETE");
    expect(s3.objects.size).toBe(0);
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("fails when the object is still readable after delete", async () => {
    const homeDir = await makeHome({ instagram: { hosting: HOSTING } });
    // DELETE "succeeds" but the fake keeps the object.
    const s3 = fakeS3();
    const keepingFetch: HostingFetch = async (input, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : s3.fetch(input, init);

    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: keepingFetch
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("호스팅 실패");
  });

  it("uses the public base URL instead of a presigned URL when configured", async () => {
    const homeDir = await makeHome({
      instagram: { hosting: { ...HOSTING, publicBaseUrl: "https://img.example.com" } }
    });
    const s3 = fakeS3();
    // Map the public host onto the fake bucket path.
    const publicFetch: HostingFetch = async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "img.example.com") {
        return s3.fetch(`${ENDPOINT}/${BUCKET}${url.pathname}`, init);
      }
      return s3.fetch(input, init);
    };

    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: publicFetch
    });

    expect(result.exitCode).toBe(0);
    const gets = s3.requests.filter((r) => r.method === "GET");
    expect(gets[0].url.searchParams.has("X-Amz-Signature")).toBe(false);
  });
});

describe("object keys", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC2: keys carry no date, project name, local path or user name", async () => {
    const homeDir = await makeHome({ instagram: { hosting: HOSTING } }, "alice-myproject-");
    const s3 = fakeS3();
    const host = await resolveImageHost({
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: s3.fetch
    });

    const before = new Date();
    const first = await host.upload(jpeg());
    const second = await host.upload(jpeg());
    const after = new Date();
    // Upload-day strings in YYYY-MM-DD and YYYYMMDD, local and UTC, for both
    // ends of the upload window (a run can cross midnight). Matching a date
    // regex instead would flake whenever the random hex contains "20dddddd".
    const pad = (n: number) => String(n).padStart(2, "0");
    const uploadDays = [before, after].flatMap((d) => [
      [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())],
      [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())]
    ]);
    const dateStrings = uploadDays.flatMap((parts) => [parts.join("-"), parts.join("")]);

    const keys = s3.requests
      .filter((r) => r.method === "PUT")
      .map((r) => decodeURIComponent(r.url.pathname).slice(`/${BUCKET}/`.length));
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^uncommitted\/[0-9a-f]{32}\/\d{2}\.jpg$/);
      for (const date of dateStrings) {
        expect(key).not.toContain(date);
      }
      expect(key).not.toContain("alice");
      expect(key).not.toContain("myproject");
      expect(key).not.toContain(homeDir);
      expect(key).not.toContain(process.env.USER ?? "never-a-user");
    }
    expect(keys[0].split("/")[1]).not.toBe(keys[1].split("/")[1]);
    await first.cleanup();
    await second.cleanup();
  });
});

describe("withHostedImages (publish flow)", () => {
  it("AC3: cleans up every upload after a successful publish", async () => {
    const { host, uploaded, cleaned } = fakeHost();

    const result = await withHostedImages(host, [jpeg(), jpeg()], async (urls) => {
      expect(urls).toEqual(uploaded);
      return "published";
    });

    expect(result).toBe("published");
    expect(cleaned).toEqual(uploaded);
  });

  it("AC3: cleans up every upload when publishing fails and rethrows the failure", async () => {
    const { host, uploaded, cleaned } = fakeHost();

    await expect(
      withHostedImages(host, [jpeg(), jpeg()], async () => {
        throw new Error("publish failed");
      })
    ).rejects.toThrow("publish failed");

    expect(uploaded).toHaveLength(2);
    expect(cleaned).toEqual(uploaded);
  });

  it("AC3: cleans up earlier uploads when a later upload fails", async () => {
    const { host, uploaded, cleaned } = fakeHost({ failUploadAt: 1 });

    await expect(
      withHostedImages(host, [jpeg(), jpeg()], async () => "never")
    ).rejects.toThrow("업로드 실패");

    expect(uploaded).toHaveLength(1);
    expect(cleaned).toEqual(uploaded);
  });

  it("AC3: a cleanup failure only warns and keeps the publish result", async () => {
    const { host } = fakeHost({ failCleanup: true });
    const warnings: string[] = [];

    const result = await withHostedImages(host, [jpeg()], async () => "published", {
      onWarning: (message) => warnings.push(message)
    });

    expect(result).toBe("published");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("정리");
  });
});

describe("hosting not configured", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC4: resolving a host without config fails with the set-up message and exit 2", async () => {
    const homeDir = await makeHome();

    const error = await resolveImageHost({ homeDir, keychainRunner: keychain(KEYCHAIN_KEYS) })
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostingError);
    expect((error as HostingError).message).toBe(HOSTING_NOT_CONFIGURED_MESSAGE);
    expect((error as HostingError).exitCode).toBe(2);
    expect(HOSTING_NOT_CONFIGURED_MESSAGE).toBe(
      "이미지 호스팅이 설정되지 않았습니다. `uncommitted instagram host set`을 실행하세요."
    );
  });

  it("AC4: host test without config prints the message and exits 2", async () => {
    const homeDir = await makeHome();
    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: fakeS3().fetch
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(HOSTING_NOT_CONFIGURED_MESSAGE);
  });
});

describe("hosting secrets", () => {
  beforeEach(() => clearGlobalConfigCache());

  const configSecrets = {
    hostingAccessKeyId: CONFIG_ACCESS_KEY,
    hostingSecretAccessKey: CONFIG_SECRET_KEY
  };

  async function credentialUsed(options: {
    keychainRunner: KeychainRunner;
    secrets?: Record<string, string>;
  }): Promise<string | undefined> {
    const homeDir = await makeHome({
      instagram: { hosting: HOSTING },
      ...(options.secrets ? { secrets: options.secrets } : {})
    });
    const s3 = fakeS3();
    const host = await resolveImageHost({
      homeDir,
      keychainRunner: options.keychainRunner,
      hostingFetch: s3.fetch
    });
    await host.upload(jpeg());
    const auth = s3.requests.find((r) => r.method === "PUT")?.headers.authorization ?? "";
    return /Credential=([^/]+)\//.exec(auth)?.[1];
  }

  it("AC5: uses keychain keys when present", async () => {
    expect(await credentialUsed({ keychainRunner: keychain(KEYCHAIN_KEYS) })).toBe(ACCESS_KEY);
  });

  it("AC5: falls back to config keys when the keychain has none", async () => {
    expect(
      await credentialUsed({ keychainRunner: keychain({}), secrets: configSecrets })
    ).toBe(CONFIG_ACCESS_KEY);
  });

  it("AC5: falls back to config keys when the keychain read fails", async () => {
    const failing: KeychainRunner = async () => {
      throw new Error("security crashed");
    };
    expect(await credentialUsed({ keychainRunner: failing, secrets: configSecrets })).toBe(
      CONFIG_ACCESS_KEY
    );
  });

  it("AC5: prefers keychain keys when both keychain and config have them", async () => {
    expect(
      await credentialUsed({ keychainRunner: keychain(KEYCHAIN_KEYS), secrets: configSecrets })
    ).toBe(ACCESS_KEY);
  });

  it("AC5: honours keychain service names overridden in config", async () => {
    const homeDir = await makeHome({
      instagram: {
        hosting: {
          ...HOSTING,
          accessKeyIdKeychainService: "custom-akid",
          secretAccessKeyKeychainService: "custom-secret"
        }
      }
    });
    const s3 = fakeS3();
    const host = await resolveImageHost({
      homeDir,
      keychainRunner: keychain({ "custom-akid": ACCESS_KEY, "custom-secret": SECRET_KEY }),
      hostingFetch: s3.fetch
    });
    await host.upload(jpeg());
    expect(s3.requests[0].headers.authorization).toContain(`Credential=${ACCESS_KEY}/`);
  });

  it("exits 2 with both storage methods when keys are missing everywhere", async () => {
    const homeDir = await makeHome({ instagram: { hosting: HOSTING } });
    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain({}),
      hostingFetch: fakeS3().fetch
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("security add-generic-password -a uncommitted -s r2-access-key-id");
    expect(result.stderr).toContain("--keys-from-stdin");
  });

  it("AC6: host status shows only the key sources, never the values", async () => {
    const homeDir = await makeHome({
      instagram: { hosting: HOSTING },
      secrets: { hostingSecretAccessKey: CONFIG_SECRET_KEY }
    });

    const result = await run(["instagram", "host", "status"], {
      homeDir,
      keychainRunner: keychain({ "r2-access-key-id": ACCESS_KEY })
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("access key 출처: keychain");
    expect(result.stdout).toContain("secret key 출처: config");
    expect(result.stdout).toContain(BUCKET);
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC6: host status reports 설정 안 됨 when hosting is not configured", async () => {
    const homeDir = await makeHome();
    const result = await run(["instagram", "host", "status"], { homeDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("설정 안 됨");
  });

  it("AC6: storage errors never echo keys or presigned URLs", async () => {
    const homeDir = await makeHome({ instagram: { hosting: HOSTING } });
    const leaky: HostingFetch = async (input) => {
      throw new Error(`connect failed for ${input} with ${ACCESS_KEY}`);
    };

    const result = await run(["instagram", "host", "test"], {
      homeDir,
      keychainRunner: keychain(KEYCHAIN_KEYS),
      hostingFetch: leaky
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("X-Amz-");
    expect(result.stderr).not.toContain(ENDPOINT);
    expectNoSecrets(result.stdout, result.stderr);
  });
});
