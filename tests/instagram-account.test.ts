import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliOptions } from "../src/cli.js";
import { clearGlobalConfigCache } from "../src/global-config.js";
import { buildLaunchAgentPlist, captureProviderEnv } from "../src/scheduler.js";
import type { KeychainRunner } from "../src/keychain-store.js";

const TOKEN = "EAAtest-system-user-token-0123456789";
const APP_SECRET = "app-secret-abcdef0123456789";
const IG_ID = "17841400000000000";
const APP_ID = "1100000000000000";

type Graph = {
  account?: { status: number; body: unknown };
  app?: { status: number; body: unknown };
  debug?: { status: number; body: unknown };
};

function graphFetch(graph: Graph = {}): {
  fetch: NonNullable<CliOptions["graphFetch"]>;
  urls: URL[];
} {
  const urls: URL[] = [];
  const fetch: NonNullable<CliOptions["graphFetch"]> = async (input) => {
    const url = new URL(input);
    urls.push(url);
    const path = url.pathname.split("/").slice(2).join("/");
    const pick =
      path === "debug_token"
        ? (graph.debug ?? {
            status: 200,
            body: {
              data: {
                is_valid: true,
                expires_at: 0,
                app_id: APP_ID,
                scopes: ["instagram_basic", "instagram_content_publish"]
              }
            }
          })
        : path === "app"
          ? (graph.app ?? { status: 200, body: { id: APP_ID } })
          : (graph.account ?? {
              status: 200,
              body: { id: IG_ID, username: "uncommitted.story" }
            });
    return new Response(JSON.stringify(pick.body), { status: pick.status });
  };
  return { fetch, urls };
}

function graphError(code: number, message = "error") {
  return { status: 400, body: { error: { message, type: "OAuthException", code } } };
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

const FULL_KEYCHAIN = {
  "instagram-access-token": TOKEN,
  "meta-app-secret": APP_SECRET
};

async function makeHome(extra: Record<string, unknown> = {}): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "ig-account-"));
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
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(APP_SECRET);
  }
}

describe("instagram connect", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC1: stores the IG user ID and handle (no token) and prints 연결됨", async () => {
    const homeDir = await makeHome();
    const { fetch, urls } = graphFetch();

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("연결됨: @uncommitted.story");
    const config = await readConfig(homeDir);
    expect(config.instagram).toMatchObject({
      igUserId: IG_ID,
      username: "uncommitted.story",
      appId: APP_ID
    });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(JSON.stringify(config)).not.toContain(APP_SECRET);
    expect(urls[0].hostname).toBe("graph.facebook.com");
    expect(urls[0].pathname).toMatch(new RegExp(`/${IG_ID}$`));
    expect(urls[0].searchParams.get("fields")).toBe("id,username");
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC2: uses the config token when the keychain has none", async () => {
    const homeDir = await makeHome({
      secrets: { instagramAccessToken: "config-token", metaAppSecret: APP_SECRET }
    });
    const { fetch, urls } = graphFetch();

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain({}),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(0);
    expect(urls[0].searchParams.get("access_token")).toBe("config-token");
  });

  it("AC2: prefers the keychain token when both sources have one", async () => {
    const homeDir = await makeHome({
      secrets: { instagramAccessToken: "config-token" }
    });
    const { fetch, urls } = graphFetch();

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(0);
    expect(urls[0].searchParams.get("access_token")).toBe(TOKEN);
  });

  it("AC3: exits 2 with both storage methods when no token exists anywhere", async () => {
    const homeDir = await makeHome();
    const { fetch, urls } = graphFetch();

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain({}),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'security add-generic-password -a uncommitted -s instagram-access-token -w "$(pbpaste)"'
    );
    expect(result.stderr).toContain("--token-from-stdin");
    expect(urls).toEqual([]);
  });

  it("--token-from-stdin stores the token in config at 0600 and connects with it", async () => {
    const homeDir = await makeHome();
    const { fetch, urls } = graphFetch();

    const result = await run(
      ["instagram", "connect", "--token-from-stdin", "--ig-user-id", IG_ID],
      {
        homeDir,
        keychainRunner: keychain({ "meta-app-secret": APP_SECRET }),
        graphFetch: fetch,
        readStdin: async () => `${TOKEN}\n`
      }
    );

    expect(result.exitCode).toBe(0);
    const config = await readConfig(homeDir);
    expect(config.secrets).toEqual({ instagramAccessToken: TOKEN });
    const mode = (await stat(join(homeDir, ".uncommitted", "config.json"))).mode;
    expect(mode & 0o777).toBe(0o600);
    expect(urls[0].searchParams.get("access_token")).toBe(TOKEN);
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC5: exits 2 with re-issue guidance on an invalid/revoked token (code 190)", async () => {
    const homeDir = await makeHome();
    const { fetch } = graphFetch({
      account: graphError(190, `Error validating access token ${TOKEN}`)
    });

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("토큰");
    expect(result.stderr).toContain("다시 발급");
    expect((await readConfig(homeDir)).instagram).toBeUndefined();
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC5: exits 2 when the token lacks instagram_content_publish", async () => {
    const homeDir = await makeHome();
    const { fetch } = graphFetch({
      debug: {
        status: 200,
        body: { data: { is_valid: true, expires_at: 0, scopes: ["instagram_basic"] } }
      }
    });

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("instagram_content_publish");
    expect((await readConfig(homeDir)).instagram).toBeUndefined();
  });

  it("exits 2 when the ID is not a reachable professional account (code 100)", async () => {
    const homeDir = await makeHome();
    const { fetch } = graphFetch({ account: graphError(100, "Unsupported get request") });

    const result = await run(["instagram", "connect", "--ig-user-id", IG_ID], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("프로페셔널");
  });

  it("requires --ig-user-id when nothing is connected yet", async () => {
    const homeDir = await makeHome();

    const result = await run(["instagram", "connect"], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: graphFetch().fetch
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--ig-user-id");
  });
});

describe("instagram status", () => {
  beforeEach(() => clearGlobalConfigCache());

  async function connectedHome(extra: Record<string, unknown> = {}) {
    return makeHome({
      instagram: { igUserId: IG_ID, username: "uncommitted.story", appId: APP_ID },
      ...extra
    });
  }

  it("AC4: prints handle, ID, token status, publish permission and sources only", async () => {
    const homeDir = await connectedHome({
      secrets: { metaAppSecret: APP_SECRET }
    });
    const { fetch, urls } = graphFetch();

    const result = await run(["instagram", "status"], {
      homeDir,
      keychainRunner: keychain({ "instagram-access-token": TOKEN }),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@uncommitted.story");
    expect(result.stdout).toContain(IG_ID);
    expect(result.stdout).toContain("유효 (만료 없음)");
    expect(result.stdout).toMatch(/게시 권한: 있음/);
    expect(result.stdout).toMatch(/액세스 토큰 출처: keychain/);
    expect(result.stdout).toMatch(/앱 시크릿 출처: config/);
    const debug = urls.find((url) => url.pathname.endsWith("/debug_token"));
    expect(debug?.searchParams.get("input_token")).toBe(TOKEN);
    expect(debug?.searchParams.get("access_token")).toBe(`${APP_ID}|${APP_SECRET}`);
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC5: exits 2 when debug_token says the token is no longer valid", async () => {
    const homeDir = await connectedHome();
    const { fetch } = graphFetch({
      debug: { status: 200, body: { data: { is_valid: false, scopes: [] } } }
    });

    const result = await run(["instagram", "status"], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("다시 발급");
    expectNoSecrets(result.stdout, result.stderr);
  });

  it("AC5: exits 2 when the publish permission is missing", async () => {
    const homeDir = await connectedHome();
    const { fetch } = graphFetch({
      debug: {
        status: 200,
        body: { data: { is_valid: true, expires_at: 0, scopes: ["instagram_basic"] } }
      }
    });

    const result = await run(["instagram", "status"], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toMatch(/게시 권한: 없음/);
    expect(result.stderr).toContain("instagram_content_publish");
  });

  it("exits 2 with storage guidance when the app secret is missing", async () => {
    const homeDir = await connectedHome();

    const result = await run(["instagram", "status"], {
      homeDir,
      keychainRunner: keychain({ "instagram-access-token": TOKEN }),
      graphFetch: graphFetch().fetch
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("-s meta-app-secret");
    expect(result.stderr).toContain("--app-secret-from-stdin");
  });

  it("prints 연결 안 됨 when nothing is connected", async () => {
    const homeDir = await makeHome();

    const result = await run(["instagram", "status"], {
      homeDir,
      keychainRunner: keychain(FULL_KEYCHAIN),
      graphFetch: graphFetch().fetch
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("연결 안 됨");
  });
});

describe("instagram disconnect", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("AC6: clears the connection and config secrets, keeps the keychain, then status says 연결 안 됨", async () => {
    const homeDir = await makeHome({
      instagram: { igUserId: IG_ID, username: "uncommitted.story", appId: APP_ID },
      secrets: { instagramAccessToken: TOKEN, metaAppSecret: APP_SECRET, other: "x" }
    });
    const keychainCalls: string[][] = [];
    const runner: KeychainRunner = async (args) => {
      keychainCalls.push(args);
      return keychain(FULL_KEYCHAIN)(args);
    };

    const result = await run(["instagram", "disconnect"], {
      homeDir,
      keychainRunner: runner,
      graphFetch: graphFetch().fetch
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "security delete-generic-password -a uncommitted -s instagram-access-token"
    );
    const config = await readConfig(homeDir);
    expect(config.instagram).toBeUndefined();
    expect(config.secrets).toEqual({ other: "x" });
    expect(keychainCalls.some((args) => args[0] !== "find-generic-password")).toBe(false);
    expectNoSecrets(result.stdout, result.stderr);

    const status = await run(["instagram", "status"], {
      homeDir,
      keychainRunner: runner,
      graphFetch: graphFetch().fetch
    });
    expect(status.stdout).toContain("연결 안 됨");
  });
});

describe("AC7: secrets never reach the launchd plist", () => {
  it("builds the plist without Instagram/Meta secret values", () => {
    const plist = buildLaunchAgentPlist({
      homeDir: "/tmp/home",
      scheduleTime: "23:30",
      executablePath: "/usr/local/bin/uncommitted",
      environmentVariables: captureProviderEnv({
        INSTAGRAM_ACCESS_TOKEN: TOKEN,
        META_APP_SECRET: APP_SECRET,
        OPENAI_API_KEY: "sk-x"
      })
    });

    expect(plist.xml).not.toContain(TOKEN);
    expect(plist.xml).not.toContain(APP_SECRET);
  });
});
