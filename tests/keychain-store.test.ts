import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearGlobalConfigCache } from "../src/global-config.js";
import {
  formatMissingSecretMessage,
  KEYCHAIN_ACCOUNT,
  type KeychainRunner,
  readSecret,
  removeConfigSecrets,
  writeConfigSecret
} from "../src/keychain-store.js";

const SPEC = { keychainService: "some-service", configKey: "someSecret" };

async function makeHome(config: Record<string, unknown> | null): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "secret-store-"));
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  if (config) {
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      JSON.stringify(config)
    );
  }
  return homeDir;
}

function keychain(
  entries: Record<string, string>,
  failure?: { exitCode: number }
): { runner: KeychainRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: KeychainRunner = async (args) => {
    calls.push(args);
    if (failure) return { exitCode: failure.exitCode, stdout: "" };
    const service = args[args.indexOf("-s") + 1];
    const value = entries[service];
    return value === undefined
      ? { exitCode: 44, stdout: "" }
      : { exitCode: 0, stdout: `${value}\n` };
  };
  return { runner, calls };
}

describe("readSecret", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("reads from the keychain first via security find-generic-password", async () => {
    const homeDir = await makeHome({
      schemaVersion: 1,
      secrets: { someSecret: "config-value" }
    });
    const { runner, calls } = keychain({ "some-service": "keychain-value" });

    const result = await readSecret(SPEC, { homeDir, keychainRunner: runner });

    expect(result).toEqual({ found: true, value: "keychain-value", source: "keychain" });
    expect(calls).toEqual([
      ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", "some-service", "-w"]
    ]);
  });

  it("falls back to config when the keychain item is missing (exit 44)", async () => {
    const homeDir = await makeHome({
      schemaVersion: 1,
      secrets: { someSecret: "config-value" }
    });
    const { runner } = keychain({});

    const result = await readSecret(SPEC, { homeDir, keychainRunner: runner });

    expect(result).toEqual({ found: true, value: "config-value", source: "config" });
  });

  it("falls back to config when the keychain is locked or access is denied", async () => {
    const homeDir = await makeHome({
      schemaVersion: 1,
      secrets: { someSecret: "config-value" }
    });
    const { runner } = keychain({}, { exitCode: 51 });

    const result = await readSecret(SPEC, { homeDir, keychainRunner: runner });

    expect(result).toEqual({ found: true, value: "config-value", source: "config" });
  });

  it("reports not found when neither source has the secret", async () => {
    const homeDir = await makeHome({ schemaVersion: 1 });
    const { runner } = keychain({});

    expect(await readSecret(SPEC, { homeDir, keychainRunner: runner })).toEqual({
      found: false
    });
  });

  it("uses an overridden keychain service name", async () => {
    const homeDir = await makeHome({ schemaVersion: 1 });
    const { runner } = keychain({ "custom-service": "v" });

    const result = await readSecret(
      { ...SPEC, keychainService: "custom-service" },
      { homeDir, keychainRunner: runner }
    );

    expect(result).toEqual({ found: true, value: "v", source: "keychain" });
  });
});

describe("writeConfigSecret / removeConfigSecrets", () => {
  beforeEach(() => clearGlobalConfigCache());

  it("writes the secret under config.secrets at 0600 and keeps other fields", async () => {
    const homeDir = await makeHome({ schemaVersion: 1, draftRoot: "~/d" });
    const configPath = join(homeDir, ".uncommitted", "config.json");

    await writeConfigSecret("someSecret", "s3cret", { homeDir });

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written).toEqual({
      schemaVersion: 1,
      draftRoot: "~/d",
      secrets: { someSecret: "s3cret" }
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses to write when config is missing (run init first)", async () => {
    const homeDir = await makeHome(null);

    await expect(
      writeConfigSecret("someSecret", "s3cret", { homeDir })
    ).rejects.toMatchObject({ code: "config-corruption" });
  });

  it("removes only the named secrets", async () => {
    const homeDir = await makeHome({
      schemaVersion: 1,
      secrets: { someSecret: "a", other: "b" }
    });

    const removed = await removeConfigSecrets(["someSecret", "missing"], { homeDir });

    expect(removed).toEqual(["someSecret"]);
    const written = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    );
    expect(written.secrets).toEqual({ other: "b" });
  });
});

describe("formatMissingSecretMessage", () => {
  it("names both storage methods, with the pbpaste keychain form", () => {
    const message = formatMissingSecretMessage({
      label: "Some secret",
      spec: SPEC,
      configCommand: "pbpaste | uncommitted thing --secret-from-stdin"
    });

    expect(message).toContain("Some secret");
    expect(message).toContain(
      `security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s some-service -w "$(pbpaste)"`
    );
    expect(message).toContain("pbpaste | uncommitted thing --secret-from-stdin");
  });
});
