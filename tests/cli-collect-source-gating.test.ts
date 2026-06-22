import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

type SourceName = "git" | "claude" | "codex" | "github";

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

async function writeProjectsFile(
  homeDir: string,
  repoDir: string
): Promise<void> {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeFile(
    join(homeDir, ".uncommitted", "projects.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        projects: [
          {
            schemaVersion: 1,
            id: "p1",
            name: "demo",
            root: repoDir,
            gitRoot: repoDir,
            enabled: true,
            createdAt: "2026-05-01T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function configWith(disabled: SourceName): Record<string, unknown> {
  const sources: Record<string, { enabled: boolean }> = {
    git: { enabled: true },
    claude: { enabled: true },
    codex: { enabled: true },
    github: { enabled: true }
  };
  sources[disabled] = { enabled: false };
  return {
    schemaVersion: 1,
    sources
  };
}

describe("cli collect <source> per-source gating", () => {
  for (const source of ["git", "claude", "codex", "github"] as const) {
    it(`exits 0 with a disabled message when sources.${source}.enabled is false`, async () => {
      const { io, stdout, stderr } = createIo();
      const directory = await mkdtemp(
        join(tmpdir(), `uncommitted-cli-collect-gate-${source}-`)
      );
      const repoDir = join(directory, "repo");
      const homeDir = join(directory, "home");

      await mkdir(repoDir, { recursive: true });
      await writeProjectsFile(homeDir, repoDir);
      await writeConfig(homeDir, configWith(source));

      const exitCode = await runCli(["collect", source], io, {
        homeDir,
        claudeHome: join(directory, "claude-home"),
        codexHome: join(directory, "codex-home"),
        now: () => "2026-05-06T13:30:00.000Z"
      });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout.join("\n")).toContain(
        `Source '${source}' is disabled in config; skipping collection.`
      );
    });
  }

  it("rejects a dangling codex --date even when codex is disabled", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-cli-collect-codex-typo-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, configWith("codex"));

    const exitCode = await runCli(["collect", "codex", "--date"], io, {
      homeDir
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain(
      "Usage: uncommitted collect codex [--date YYYY-MM-DD]"
    );
    // The disabled-skip must NOT short-circuit the argument validation.
    expect(stdout.join("\n")).not.toContain("disabled in config");
  });

  it("rejects an unknown github flag even when github is disabled", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-cli-collect-github-typo-")
    );
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, configWith("github"));

    const exitCode = await runCli(["collect", "github", "--bogus"], io, {
      homeDir
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain(
      "Usage: uncommitted collect github [--date YYYY-MM-DD]"
    );
    expect(stdout.join("\n")).not.toContain("disabled in config");
  });

  it("exits 2 (config error) when config.json is malformed", async () => {
    const { io, stderr } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-cli-collect-malformed-")
    );
    const homeDir = join(directory, "home");
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      "{ not valid json",
      "utf8"
    );

    const exitCode = await runCli(["collect", "git"], io, { homeDir });

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Malformed source config");
  });

  it("invokes the claude collector when sources.claude.enabled is true (sanity)", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(
      join(tmpdir(), "uncommitted-cli-collect-gate-enabled-")
    );
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await mkdir(repoDir, { recursive: true });
    await writeProjectsFile(homeDir, repoDir);
    await writeConfig(homeDir, {
      schemaVersion: 1,
      sources: {
        git: { enabled: true },
        claude: { enabled: true },
        codex: { enabled: true },
        github: { enabled: true }
      }
    });

    const exitCode = await runCli(["collect", "claude"], io, {
      homeDir,
      claudeHome: join(directory, "claude-home"),
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    // Sanity: the collector runs (claude-home does not exist, so it reports the
    // "no Claude session logs" path that only the collector can emit). The
    // disabled-message must NOT appear.
    expect(stdout.join("\n")).toContain("No Claude session logs found");
    expect(stdout.join("\n")).not.toContain("disabled in config");
  });
});
