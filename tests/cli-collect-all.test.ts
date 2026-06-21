import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { SourceName } from "../src/source-config.js";

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    },
    stdout,
    stderr
  };
}

async function writeConfig(
  homeDir: string,
  config: Record<string, unknown>
): Promise<void> {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );
}

function configWithSources(
  overrides: Partial<Record<SourceName, boolean>> = {}
): Record<string, unknown> {
  const sources: Record<string, { enabled: boolean }> = {
    git: { enabled: overrides.git ?? true },
    claude: { enabled: overrides.claude ?? true },
    codex: { enabled: overrides.codex ?? true },
    github: { enabled: overrides.github ?? true }
  };
  return {
    schemaVersion: 1,
    sources
  };
}

type StubResult = {
  ok: boolean;
  message: string;
};

function createStubInvokers(
  responses: Partial<Record<SourceName, StubResult>>,
  calls: SourceName[]
): Record<SourceName, () => Promise<{ successCount: number; failureCount: number; detail?: string }>> {
  const make = (name: SourceName) => async () => {
    calls.push(name);
    const response = responses[name];
    if (!response) {
      return { successCount: 1, failureCount: 0, detail: "ok" };
    }
    if (!response.ok) {
      throw new Error(response.message);
    }
    return { successCount: 1, failureCount: 0, detail: response.message };
  };
  return {
    git: make("git"),
    claude: make("claude"),
    codex: make("codex"),
    github: make("github")
  };
}

describe("cli collect all orchestration", () => {
  it("invokes every enabled source and exits 0 when all succeed", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-collect-all-success-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, configWithSources());

    const calls: SourceName[] = [];
    const collectInvokers = createStubInvokers(
      {
        git: { ok: true, message: "git ok" },
        claude: { ok: true, message: "claude ok" },
        codex: { ok: true, message: "codex ok" },
        github: { ok: true, message: "github ok" }
      },
      calls
    );

    const exitCode = await runCli(["collect", "all"], io, {
      homeDir,
      collectInvokers
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(calls.sort()).toEqual(["claude", "codex", "git", "github"]);
    const out = stdout.join("\n");
    expect(out).toContain("Source 'git': success");
    expect(out).toContain("Source 'claude': success");
    expect(out).toContain("Source 'codex': success");
    expect(out).toContain("Source 'github': success");
  });

  it("isolates per-source failures: one throws, others succeed, exit 0", async () => {
    const { io, stdout } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-collect-all-isolate-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, configWithSources());

    const calls: SourceName[] = [];
    const collectInvokers = createStubInvokers(
      {
        git: { ok: true, message: "git ok" },
        claude: { ok: true, message: "claude ok" },
        codex: { ok: true, message: "codex ok" },
        github: { ok: false, message: "no GitHub token configured" }
      },
      calls
    );

    const exitCode = await runCli(["collect", "all"], io, {
      homeDir,
      collectInvokers
    });

    expect(exitCode).toBe(0);
    expect(calls.sort()).toEqual(["claude", "codex", "git", "github"]);
    const out = stdout.join("\n");
    expect(out).toContain("Source 'git': success");
    expect(out).toContain("Source 'claude': success");
    expect(out).toContain("Source 'codex': success");
    expect(out).toContain("Source 'github': failed");
    expect(out).toContain("no GitHub token configured");
  });

  it("returns exit 3 when every enabled source fails", async () => {
    const { io, stdout } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-collect-all-all-fail-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, configWithSources());

    const calls: SourceName[] = [];
    const collectInvokers = createStubInvokers(
      {
        git: { ok: false, message: "git broke" },
        claude: { ok: false, message: "claude broke" },
        codex: { ok: false, message: "codex broke" },
        github: { ok: false, message: "github broke" }
      },
      calls
    );

    const exitCode = await runCli(["collect", "all"], io, {
      homeDir,
      collectInvokers
    });

    expect(exitCode).toBe(3);
    expect(calls.sort()).toEqual(["claude", "codex", "git", "github"]);
    const out = stdout.join("\n");
    expect(out).toContain("Source 'git': failed");
    expect(out).toContain("Source 'claude': failed");
    expect(out).toContain("Source 'codex': failed");
    expect(out).toContain("Source 'github': failed");
  });

  it("only invokes enabled sources; disabled ones are reported but not called", async () => {
    const { io, stdout } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-collect-all-mostly-disabled-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(
      homeDir,
      configWithSources({ claude: false, codex: false, github: false })
    );

    const calls: SourceName[] = [];
    const collectInvokers = createStubInvokers(
      {
        git: { ok: true, message: "git ok" },
        claude: { ok: true, message: "should not run" },
        codex: { ok: true, message: "should not run" },
        github: { ok: true, message: "should not run" }
      },
      calls
    );

    const exitCode = await runCli(["collect", "all"], io, {
      homeDir,
      collectInvokers
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["git"]);
    const out = stdout.join("\n");
    expect(out).toContain("Source 'git': success");
    expect(out).toContain("Source 'claude': disabled");
    expect(out).toContain("Source 'codex': disabled");
    expect(out).toContain("Source 'github': disabled");
  });

  it("exits 0 with a no-sources-enabled marker when every source is disabled", async () => {
    const { io, stdout } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-collect-all-none-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(
      homeDir,
      configWithSources({
        git: false,
        claude: false,
        codex: false,
        github: false
      })
    );

    const calls: SourceName[] = [];
    const collectInvokers = createStubInvokers({}, calls);

    const exitCode = await runCli(["collect", "all"], io, {
      homeDir,
      collectInvokers
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
    const out = stdout.join("\n");
    expect(out).toContain("no sources enabled");
  });
});
