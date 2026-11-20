import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDoctorReport,
  formatDoctorReport,
  getDoctorExitCode,
  type DoctorOptions
} from "../src/doctor-command.js";
import { clearGlobalConfigCache } from "../src/global-config.js";
import type { HostingFetch } from "../src/instagram-hosting.js";
import {
  fakeGraph,
  fakeKeychain,
  IG_APP_SECRET,
  IG_TOKEN,
  INSTAGRAM_CONFIG,
  R2_ACCESS_KEY,
  R2_SECRET_KEY
} from "./instagram-fakes.js";

// UNC-298: Instagram items in `uncommitted doctor`. Graph API, S3 storage and
// the keychain are in-memory fakes; nothing touches the network.

const NOW = "2026-11-20T12:00:00.000Z";
const NOW_SECONDS = Date.parse(NOW) / 1000;
const DAY = 24 * 60 * 60;

/** S3 that serves an object after PUT and 404s after DELETE, like a real bucket. */
function workingS3(): HostingFetch {
  const objects = new Set<string>();
  return async (input, init = {}) => {
    const method = init.method ?? "GET";
    const key = new URL(input).pathname;
    if (method === "PUT") {
      objects.add(key);
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(objects.has(key) ? "jpeg" : "", { status: objects.has(key) ? 200 : 404 });
  };
}

async function setup(
  opts: {
    instagram?: Record<string, unknown> | null;
    token?: NonNullable<Parameters<typeof fakeGraph>[0]>["token"];
  } = {}
): Promise<DoctorOptions> {
  const homeDir = await mkdtemp(join(tmpdir(), "ig-doctor-"));
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  const instagram = opts.instagram === null ? undefined : (opts.instagram ?? INSTAGRAM_CONFIG);
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      draftRoot: "~/Uncommitted/drafts",
      aiProvider: "mock",
      instagram
    })
  );
  return {
    homeDir,
    env: {},
    nodeVersion: "v22.13.0",
    checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" }),
    checkAccess: async () => true,
    keychainRunner: fakeKeychain().runner,
    graphFetch: fakeGraph({ token: opts.token }).fetch,
    hostingFetch: workingS3(),
    now: () => NOW
  };
}

function instagramChecks(report: Awaited<ReturnType<typeof createDoctorReport>>) {
  return report.checks.filter((check) => check.id.startsWith("instagram-"));
}

function expectNoSecrets(output: string) {
  for (const secret of [IG_TOKEN, IG_APP_SECRET, R2_ACCESS_KEY, R2_SECRET_KEY]) {
    expect(output).not.toContain(secret);
  }
  expect(output).not.toMatch(/X-Amz-/);
}

describe("doctor Instagram checks (UNC-298)", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC1: a healthy connection shows every Instagram item as pass without printing secrets", async () => {
    const report = await createDoctorReport(await setup());
    const checks = instagramChecks(report);

    expect(checks.map((check) => check.id)).toEqual([
      "instagram-connection",
      "instagram-token",
      "instagram-permission",
      "instagram-hosting",
      "instagram-quota"
    ]);
    expect(checks.filter((check) => check.status !== "pass")).toEqual([]);
    const output = formatDoctorReport(report);
    expect(output).toContain("@uncommitted.ai");
    expect(output).toContain("만료 없음");
    expect(output).toContain("1/100");
    expectNoSecrets(output);
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("AC2: an expired token fails the token item and points at instagram connect", async () => {
    const report = await createDoctorReport(
      await setup({ token: { isValid: false, expiresAt: NOW_SECONDS - DAY } })
    );
    const token = report.checks.find((check) => check.id === "instagram-token");

    expect(token?.status).toBe("fail");
    expect(token?.message).toContain("instagram connect");
    expect(getDoctorExitCode(report)).toBe(2);
    expectNoSecrets(formatDoctorReport(report));
  });

  it("a token expiring within 7 days is a warning with the days left", async () => {
    const report = await createDoctorReport(
      await setup({ token: { expiresAt: NOW_SECONDS + 3 * DAY } })
    );
    const token = report.checks.find((check) => check.id === "instagram-token");

    expect(token?.status).toBe("warn");
    expect(token?.message).toContain("3일");
    expect(token?.message).toContain("instagram connect");
  });

  it("a missing publish permission fails the permission item", async () => {
    const report = await createDoctorReport(
      await setup({ token: { scopes: ["instagram_basic"] } })
    );
    expect(report.checks.find((check) => check.id === "instagram-permission")?.status).toBe(
      "fail"
    );
  });

  it("missing image hosting fails the hosting item", async () => {
    const withoutHosting: Record<string, unknown> = { ...INSTAGRAM_CONFIG };
    delete withoutHosting.hosting;
    const report = await createDoctorReport(await setup({ instagram: withoutHosting }));
    const hosting = report.checks.find((check) => check.id === "instagram-hosting");

    expect(hosting?.status).toBe("fail");
    expect(hosting?.message).toContain("instagram host set");
  });

  it("an unconnected account shows one optional item and makes no network call", async () => {
    const options = await setup({ instagram: null });
    let called = false;
    options.graphFetch = async () => {
      called = true;
      throw new Error("no network");
    };
    const report = await createDoctorReport(options);

    expect(instagramChecks(report)).toEqual([
      expect.objectContaining({ id: "instagram-connection", status: "pass" })
    ]);
    expect(called).toBe(false);
    expect(getDoctorExitCode(report)).toBe(0);
  });
});
