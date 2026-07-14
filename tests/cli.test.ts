import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  CarouselPngRenderError,
  type CarouselHtmlToPngRenderer
} from "../src/carousel-renderer.js";
import { isDirectRun, runCli } from "../src/cli.js";
import type {
  AiProvider,
  AiProviderRawResponse,
  AiStructuredGenerationRequest
} from "../src/ai-provider.js";
import {
  createDraftRevision,
  writeLatestDraftPointer
} from "../src/draft-storage.js";
import { addProject } from "../src/project-add.js";
import { buildLaunchAgentPlist } from "../src/scheduler.js";

const execFileAsync = promisify(execFile);

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

describe("cli", () => {
  it("prints help", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["--", "--help"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: uncommitted <command>");
    expect(stdout.join("\n")).toContain("init");
    expect(stdout.join("\n")).toContain("generate");
  });

  it("routes collect without a source to an actionable message", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect <git|claude|codex|github|all>");
  });

  it("rejects extra arguments for collect git instead of silently ignoring them", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect", "git", "--date", "2026-06-14"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect git");
  });

  it("rejects extra arguments for collect claude instead of silently ignoring them", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect", "claude", "typo"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect claude");
  });

  it("rejects collect codex --date without a value", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect", "codex", "--date"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect codex");
  });

  it("rejects unknown collect codex flags", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect", "codex", "--bogus"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect codex");
  });

  it("rejects extra args after `collect github`", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect", "github", "unexpected"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect github");
  });

  it("rejects collect github --date without a value", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["collect", "github", "--date"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted collect github");
  });

  it("reports skip and exits 0 when collect claude finds no session logs", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-claude-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await mkdir(repoDir, { recursive: true });
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

    const exitCode = await runCli(["collect", "claude"], io, {
      homeDir,
      claudeHome: join(directory, "claude-home"),
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("No Claude session logs found");
  });

  it("reports skip and exits 0 when collect codex finds no session logs", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-codex-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await mkdir(repoDir, { recursive: true });
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

    const exitCode = await runCli(["collect", "codex"], io, {
      homeDir,
      codexHome: join(directory, "codex-home"),
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("No Codex session logs found");
  });

  it("collects today's Git activity for registered projects", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "app.ts"), "const today = true;\n", "utf8");
    await git(repoDir, ["add", "app.ts"]);
    await commit(repoDir, "collect target", "2026-05-06T10:00:00Z");
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir,
      now: () => "2026-05-06T13:30:00.000Z"
    });
    const outputFile = join(
      repoDir,
      ".uncommitted",
      "events",
      "git",
      "2026-05-06.json"
    );
    const output = await readJson(outputFile);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Collected Git activity for 1 project.");
    expect(output).toMatchObject({
      schemaVersion: 1,
      source: "git",
      targetDate: "2026-05-06",
      project: {
        id: "repo",
        name: "repo"
      },
      activity: {
        totals: {
          commits: 1,
          filesChanged: 1
        }
      }
    });
    expect(JSON.stringify(output)).not.toContain(repoDir);
    expect(JSON.stringify(output)).not.toContain("const today = true");
  });

  it("returns collection exit code for missing or empty project registry", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-empty-"));

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir: join(directory, "home"),
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "No registered projects. Run `uncommitted project add .` first."
    );
  });

  it("returns config exit code when collect git finds invalid projects file", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-invalid-"));
    const homeDir = join(directory, "home");

    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "projects.json"), "nope", "utf8");

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir,
      now: () => "2026-05-06T13:30:00.000Z"
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Invalid projects file.");
  });

  it("preserves successful collect output when another project fails", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-collect-partial-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "app.ts"), "const partial = true;\n", "utf8");
    await git(repoDir, ["add", "app.ts"]);
    await commit(repoDir, "partial target", "2026-05-06T10:00:00Z");
    const registered = await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });
    await writeFile(
      join(homeDir, ".uncommitted", "projects.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projects: [
            registered.project,
            {
              schemaVersion: 1,
              id: "missing-repo",
              name: "missing-repo",
              root: join(directory, "missing"),
              gitRoot: join(directory, "missing"),
              enabled: true,
              createdAt: "2026-05-06T00:00:00.000Z"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const exitCode = await runCli(["collect", "git"], io, {
      homeDir,
      now: () => "2026-05-06T13:30:00.000Z"
    });
    const output = await readJson(
      join(repoDir, ".uncommitted", "events", "git", "2026-05-06.json")
    );

    expect(exitCode).toBe(3);
    expect(stdout.join("\n")).toContain("Collected Git activity for 1 project.");
    expect(stderr.join("\n")).toContain("Failed to collect missing-repo");
    expect(output).toMatchObject({
      project: {
        id: "repo"
      },
      activity: {
        totals: {
          commits: 1
        }
      }
    });
  });

  it("routes note to the manual note handler", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-note-"));

    const exitCode = await runCli(["note", "remember this"], io, {
      homeDir: join(directory, "home"),
      cwd: directory
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Run inside a registered project.");
  });

  it("does not save note list as a manual note", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-note-list-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await execFileAsync("git", ["init", repoDir]);
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });

    const exitCode = await runCli(["note", "list"], io, {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-06T10:15:30.000Z"
    });

    await expect(
      access(join(repoDir, ".uncommitted", "events", "manual", "2026-05-06.jsonl"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["No manual notes found."]);
    expect(stderr).toEqual([]);
  });

  it("prints manual notes newest first", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-note-list-output-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await execFileAsync("git", ["init", repoDir]);
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-05-06T00:00:00.000Z"
    });

    await runCli(["note", "older note"], io, {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-06T10:15:30.000Z"
    });
    await runCli(["note", "newer note"], io, {
      cwd: repoDir,
      homeDir,
      now: () => "2026-05-06T11:00:00.000Z"
    });

    stdout.length = 0;
    stderr.length = 0;

    const exitCode = await runCli(["note", "list"], io, {
      cwd: repoDir,
      homeDir
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Manual notes (newest first):",
      "2026-05-06 11:00 newer note",
      "2026-05-06 10:15 older note"
    ]);
  });

  it("rejects note list with extra arguments", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["note", "list", "fix", "tests"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Usage: uncommitted note list"]);
  });

  it("routes project add to the project registration handler", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-add-"));

    const exitCode = await runCli(["project", "add", directory], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Not a Git repository");
  });

  it("routes project list to the global project registry", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-list-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await initGitRepo(repoDir);
    await writeConfig(homeDir, join(directory, "drafts"));
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-06-04T00:00:00.000Z"
    });
    const realRepoDir = await realpath(repoDir);

    const exitCode = await runCli(["project", "list"], io, { homeDir });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Registered projects:",
      `repo\trepo\t${realRepoDir}\tenabled\t2026-06-04T00:00:00.000Z`
    ]);
  });

  it("routes project list for an empty registry", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-list-"));
    const homeDir = join(directory, "home");

    await writeConfig(homeDir, join(directory, "drafts"));
    await writeJson(join(homeDir, ".uncommitted", "projects.json"), {
      schemaVersion: 1,
      projects: []
    });

    const exitCode = await runCli(["project", "list"], io, { homeDir });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "No registered projects. Run `uncommitted project add .` first."
    ]);
  });

  it("returns config exit code when project list is not initialized", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-list-"));

    const exitCode = await runCli(["project", "list"], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Config not found. Run `uncommitted init` first."]);
  });

  it("returns config exit code when project list finds invalid registry data", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-list-"));
    const homeDir = join(directory, "home");

    await writeConfig(homeDir, join(directory, "drafts"));
    await writeFile(join(homeDir, ".uncommitted", "projects.json"), "nope", "utf8");

    const exitCode = await runCli(["project", "list"], io, { homeDir });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Invalid projects file");
  });

  it("routes project remove to the global project registry", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-remove-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await initGitRepo(repoDir);
    await writeConfig(homeDir, join(directory, "drafts"));
    await addProject(repoDir, {
      homeDir,
      now: () => "2026-06-04T00:00:00.000Z"
    });
    const realRepoDir = await realpath(repoDir);

    const exitCode = await runCli(["project", "remove", "repo"], io, { homeDir });
    const projectsFile = await readJson(join(homeDir, ".uncommitted", "projects.json"));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Project removed: repo", realRepoDir]);
    expect(projectsFile).toEqual({
      schemaVersion: 1,
      projects: []
    });
  });

  it("returns config exit code when project remove cannot find an id", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-remove-"));
    const homeDir = join(directory, "home");

    await writeConfig(homeDir, join(directory, "drafts"));
    await writeJson(join(homeDir, ".uncommitted", "projects.json"), {
      schemaVersion: 1,
      projects: []
    });

    const exitCode = await runCli(["project", "remove", "missing"], io, {
      homeDir
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Unknown project id: missing. Run `uncommitted project list`."
    ]);
  });

  it("returns usage when project remove is missing an id", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["project", "remove"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Usage: uncommitted project remove <project-id>"]);
  });

  it("routes persona set to the persona command handler, persisting the preset", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-persona-set-"));
    const homeDir = join(directory, "home");
    const draftRoot = join(directory, "drafts");
    await writeConfig(homeDir, draftRoot);

    const exitCode = await runCli(["persona", "set", "까칠한 시니어"], io, { homeDir });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("까칠한 시니어");

    const config = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    );
    expect(config.persona.preset).toBe("까칠한 시니어");
    expect(config.draftRoot).toBe(draftRoot);
  });

  it("routes persona set with a per-knob override", async () => {
    const { io, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-persona-override-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts"));

    const exitCode = await runCli(
      ["persona", "set", "까칠한 시니어", "--emoji", "heavy"],
      io,
      { homeDir }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const config = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "config.json"), "utf8")
    );
    expect(config.persona.voice.emoji).toBe("heavy");
  });

  it("returns a config error exit code when persona set runs before init", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-persona-noinit-"));
    const homeDir = join(directory, "home");

    const exitCode = await runCli(["persona", "set", "까칠한 시니어"], io, { homeDir });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Run `uncommitted init` first.");
  });

  it("returns usage when persona set is missing a preset", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["persona", "set"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted persona set");
  });

  it("returns usage for an unknown persona preset", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-persona-badpreset-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts"));

    const exitCode = await runCli(["persona", "set", "not a real preset"], io, { homeDir });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown persona preset");
  });

  it("renders the latest draft carousel with existing visual assets", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createLatestDraftFixture();
    const renderer = new RecordingPngRenderer();

    const exitCode = await runCli(["render", "latest"], io, {
      homeDir: fixture.homeDir,
      carouselRenderer: renderer
    });
    const carouselPng = await readFile(
      join(fixture.revision.outputDir, "carousel", "01.png")
    );
    const metadata = await readJson(join(fixture.revision.outputDir, "metadata.json"));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      `Rendered carousel for ${fixture.revision.targetDate}: ${fixture.revision.outputDir}`,
      `Carousel files: ${join(fixture.revision.outputDir, "carousel")}`
    ]);
    expect(carouselPng).toEqual(pngBytes);
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]?.html).toContain("class=\"visual-asset\"");
    expect(renderer.calls[0]?.html).toContain("data:image/png;base64,");
    expect(metadata).toMatchObject({
      files: [
        "activity-summary.json",
        "story.json",
        "caption.txt",
        "metadata.json",
        "safety-report.json",
        "visuals/01.png",
        "carousel/01.png"
      ],
      carousel: {
        schemaVersion: 1,
        status: "rendered",
        files: ["carousel/01.png"],
        images: [
          {
            schemaVersion: 1,
            slideIndex: 1,
            assetSlotId: "slide-01-visual",
            sourceHtmlFileName: "01.html",
            filePath: "carousel/01.png",
            visualAssetPath: "visuals/01.png"
          }
        ]
      }
    });
  });

  it("returns a rendering error when no latest draft exists", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-render-missing-"));
    const homeDir = join(directory, "home");
    const draftRoot = join(directory, "drafts");

    await writeConfig(homeDir, draftRoot);

    const exitCode = await runCli(["render", "latest"], io, {
      homeDir,
      carouselRenderer: new RecordingPngRenderer()
    });

    expect(exitCode).toBe(5);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "No latest draft found. Run `uncommitted generate today` first."
    ]);
  });

  it("returns a rendering error for invalid latest draft story data", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createLatestDraftFixture({
      story: { schemaVersion: 1, targetDate: "2026-05-18", slides: [] }
    });

    const exitCode = await runCli(["render", "latest"], io, {
      homeDir: fixture.homeDir,
      carouselRenderer: new RecordingPngRenderer()
    });

    expect(exitCode).toBe(5);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Draft story is not renderable. Regenerate the draft."]);
    await expect(
      readFile(join(fixture.revision.outputDir, "story.json"), "utf8")
    ).resolves.toContain("\"slides\": []");
  });

  it("returns safety-blocked exit code for blocked latest drafts", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createLatestDraftFixture({
      metadata: {
        ...createDraftMetadata(),
        exportPolicy: "blocked",
        safety: {
          status: "blocked",
          message: "Safety blocked.",
          riskCount: 1
        }
      }
    });

    const exitCode = await runCli(["render", "latest"], io, {
      homeDir: fixture.homeDir,
      carouselRenderer: new RecordingPngRenderer()
    });

    expect(exitCode).toBe(6);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Draft is blocked by safety checks. Regenerate or edit before rendering."
    ]);
    await expect(
      access(join(fixture.revision.outputDir, "carousel", "01.png"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a rendering error for missing declared visual asset files", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createLatestDraftFixture({ writeVisualAsset: false });

    const exitCode = await runCli(["render", "latest"], io, {
      homeDir: fixture.homeDir,
      carouselRenderer: new RecordingPngRenderer()
    });

    expect(exitCode).toBe(5);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Could not render carousel PNGs."]);
    await expect(
      access(join(fixture.revision.outputDir, "carousel", "01.png"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns rendering exit code when the PNG renderer fails", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createLatestDraftFixture();

    const exitCode = await runCli(["render", "latest"], io, {
      homeDir: fixture.homeDir,
      carouselRenderer: new FailingPngRenderer()
    });

    expect(exitCode).toBe(5);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Could not render carousel PNGs."]);
  });

  it("runs the scheduled local workflow immediately", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createScheduleRunNowFixture();
    const renderer = new RecordingPngRenderer();

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider(),
      carouselRenderer: renderer,
      collectInvokers: nonGitStubInvokers()
    });

    const renderedPng = await readFile(
      join(fixture.draftRoot, "2026-05-31", "rev-001", "carousel", "01.png")
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Source 'git': success");
    expect(stdout.join("\n")).toContain(
      `Generated text draft for 2026-05-31: ${join(
        fixture.draftRoot,
        "2026-05-31",
        "rev-001"
      )}`
    );
    expect(stdout.join("\n")).toContain(
      `Rendered carousel for 2026-05-31: ${join(
        fixture.draftRoot,
        "2026-05-31",
        "rev-001"
      )}`
    );
    expect(renderedPng).toEqual(pngBytes);
    expect(renderer.calls).toHaveLength(3);
  });

  it("collects every config-enabled source and skips disabled ones", async () => {
    const { io, stdout } = createIo();
    const fixture = await createScheduleRunNowFixture({
      git: { enabled: true },
      claude: { enabled: true },
      codex: { enabled: true },
      github: { enabled: false }
    });
    const calls: string[] = [];
    const spy = (name: string) => async () => {
      calls.push(name);
      return { successCount: 1, failureCount: 0, detail: `${name} stub` };
    };

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider(),
      carouselRenderer: new RecordingPngRenderer(),
      collectInvokers: {
        claude: spy("claude"),
        codex: spy("codex"),
        github: spy("github")
      }
    });

    expect(exitCode).toBe(0);
    // Enabled claude/codex fan out via config; disabled github is never invoked.
    expect(calls.sort()).toEqual(["claude", "codex"]);
    const out = stdout.join("\n");
    expect(out).toContain("Source 'git': success");
    expect(out).toContain("Source 'github': disabled");
  });

  it("stops before generating when git fails and only no-op sources succeed", async () => {
    const { io, stdout } = createIo();
    const fixture = await createScheduleRunNowFixture({
      git: { enabled: true },
      claude: { enabled: true },
      codex: { enabled: true },
      github: { enabled: false }
    });

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider(),
      carouselRenderer: new RecordingPngRenderer(),
      collectInvokers: {
        git: async () => {
          throw new Error("git repo path is gone");
        },
        claude: async () => ({
          successCount: 0,
          failureCount: 0,
          detail: "no Claude session logs found"
        }),
        codex: async () => ({
          successCount: 0,
          failureCount: 0,
          detail: "no Codex session logs found"
        })
      }
    });

    // git failed and the enabled Claude/Codex sources collected nothing, so the
    // scheduler must surface the collection failure (exit 3) instead of
    // generating a draft from stale/empty data.
    expect(exitCode).toBe(3);
    expect(stdout.join("\n")).not.toContain("Generated text draft");
  });

  it("uses one target date across schedule run-now steps", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createScheduleRunNowFixture();
    const renderer = new RecordingPngRenderer();
    const clockValues = [
      "2026-05-31T23:59:59.000Z",
      "2026-06-01T00:00:01.000Z",
      "2026-06-01T00:00:02.000Z"
    ];

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => clockValues.shift() ?? "2026-06-01T00:00:03.000Z",
      aiProvider: new ScheduleAiProvider(),
      carouselRenderer: renderer,
      collectInvokers: nonGitStubInvokers()
    });

    const renderedPng = await readFile(
      join(fixture.draftRoot, "2026-05-31", "rev-001", "carousel", "01.png")
    );

    await expect(
      access(join(fixture.draftRoot, "2026-06-01", "rev-001", "story.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Generated text draft for 2026-05-31");
    expect(stdout.join("\n")).toContain("Rendered carousel for 2026-05-31");
    expect(renderedPng).toEqual(pngBytes);
  });

  it("returns collection exit code for schedule run-now when collection fails", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-empty-"));

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: join(directory, "home"),
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider(),
      carouselRenderer: new RecordingPngRenderer()
    });

    // Every enabled source fails on the empty registry; collect all reports
    // each per-source failure on stdout and run-now propagates exit 3 before
    // generation.
    expect(exitCode).toBe(3);
    const out = stdout.join("\n");
    expect(out).toContain("Source 'git': failed");
    expect(out).toContain("No registered projects");
    expect(stderr).toEqual([]);
  });

  it("preserves collect output when schedule run-now generation fails", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createScheduleRunNowFixture();

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider({ fail: true }),
      carouselRenderer: new RecordingPngRenderer(),
      collectInvokers: nonGitStubInvokers()
    });

    expect(exitCode).toBe(4);
    expect(stdout.join("\n")).toContain("Source 'git': success");
    expect(stderr).toEqual([
      "AI provider failed. Check provider configuration."
    ]);
  });

  it("preserves generated draft output when schedule run-now rendering fails", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createScheduleRunNowFixture();

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider(),
      carouselRenderer: new FailingPngRenderer(),
      collectInvokers: nonGitStubInvokers()
    });

    expect(exitCode).toBe(5);
    expect(stdout.join("\n")).toContain("Source 'git': success");
    expect(stdout.join("\n")).toContain("Generated text draft for 2026-05-31");
    expect(stderr).toEqual(["Could not render carousel PNGs."]);
  });

  it("returns safety-blocked exit code for schedule run-now", async () => {
    const { io, stdout, stderr } = createIo();
    const fixture = await createScheduleRunNowFixture();

    const exitCode = await runCli(["schedule", "run-now"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-31T23:30:00.000Z",
      aiProvider: new ScheduleAiProvider({ model: "TOKEN=abc123" }),
      carouselRenderer: new RecordingPngRenderer(),
      collectInvokers: nonGitStubInvokers()
    });

    expect(exitCode).toBe(6);
    expect(stdout.join("\n")).toContain("Source 'git': success");
    expect(stdout.join("\n")).not.toContain("Rendered carousel");
    expect(stderr).toEqual([
      "Draft blocked by safety checks. Remove blocked sensitive content."
    ]);
  });

  it("installs the macOS schedule", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-install-"));
    const homeDir = join(directory, "home");

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir,
      schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    const plistContent = await readFile(plistPath, "utf8");

    expect(stdout.join("\n")).toContain("Installed macOS schedule for 23:30.");
    expect(plistContent).toContain("<key>Hour</key>");
    expect(plistContent).toContain("<integer>23</integer>");

    vi.unstubAllGlobals();
  });

  it("refuses schedule install when the running entrypoint is a test worker path", async () => {
    // Under vitest, process.argv[1] is a tinypool worker script — exactly the
    // path shape that must never be baked into the launchd plist (UNC-190).
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-worker-"));
    const homeDir = join(directory, "home");

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir,
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("not a stable CLI entrypoint");

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    await expect(access(plistPath)).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it("records the injected stable executable path in the plist", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    const { io, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-stable-"));
    const homeDir = join(directory, "home");
    const stableCliPath = "/usr/local/lib/node_modules/uncommitted/dist/cli.js";

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir,
      schedulerExecutablePath: stableCliPath,
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    const plistContent = await readFile(plistPath, "utf8");
    expect(plistContent).toContain(`<string>${stableCliPath}</string>`);
    expect(plistContent).not.toContain("tinypool");

    vi.unstubAllGlobals();
  });

  it("persists an env GITHUB_TOKEN to config on schedule install without writing it to the plist (UNC-193)", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      env: { ...process.env, GITHUB_TOKEN: "ghp_should_never_appear_in_plist" }
    });

    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-ghtoken-"));
    const homeDir = join(directory, "home");
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`
    );

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir,
      schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    const plistContent = await readFile(plistPath, "utf8");
    expect(plistContent).not.toContain("GITHUB_TOKEN");
    expect(plistContent).not.toContain("ghp_should_never_appear_in_plist");

    expect(stdout.join("\n")).toContain(
      "Saved GITHUB_TOKEN to config for scheduled GitHub collection (not written to the launchd plist)."
    );

    const configPath = join(homeDir, ".uncommitted", "config.json");
    const configContent = JSON.parse(await readFile(configPath, "utf8"));
    expect(configContent.githubToken).toBe("ghp_should_never_appear_in_plist");

    vi.unstubAllGlobals();
  });

  it("persists env provider API keys to config on schedule install without writing them to the plist (UNC-196)", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-openai-secret",
        ANTHROPIC_API_KEY: "sk-ant-secret"
      }
    });

    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-provider-"));
    const homeDir = join(directory, "home");
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(
      join(homeDir, ".uncommitted", "config.json"),
      `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`
    );

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir,
      schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    const plistContent = await readFile(plistPath, "utf8");
    expect(plistContent).not.toContain("OPENAI_API_KEY");
    expect(plistContent).not.toContain("ANTHROPIC_API_KEY");
    expect(plistContent).not.toContain("sk-openai-secret");
    expect(plistContent).not.toContain("sk-ant-secret");

    expect(stdout.join("\n")).toContain(
      "Saved provider API keys to config for scheduled runs (not written to the launchd plist)."
    );

    const configPath = join(homeDir, ".uncommitted", "config.json");
    const configContent = JSON.parse(await readFile(configPath, "utf8"));
    expect(configContent.openaiApiKey).toBe("sk-openai-secret");
    expect(configContent.anthropicApiKey).toBe("sk-ant-secret");

    vi.unstubAllGlobals();
  });

  it("still succeeds (exit 0, scheduler installed) when GITHUB_TOKEN persistence fails (UNC-193)", async () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      env: { ...process.env, GITHUB_TOKEN: "ghp_persist_will_fail" }
    });

    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-persistfail-"));
    const homeDir = join(directory, "home");
    const configDir = join(homeDir, ".uncommitted");
    await mkdir(configDir, { recursive: true });
    // Pre-create the scheduler logs dir so installScheduler's recursive mkdir is
    // a no-op even after we lock the config dir — the install itself must still
    // succeed; only the token config write is made to fail below.
    await mkdir(join(configDir, "logs"), { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`
    );

    // Make the config directory read-only so the atomic temp-file write fails
    // with EACCES; install already succeeded, so the command must still return 0.
    await chmod(configDir, 0o500);

    try {
      const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
        homeDir,
        schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
        schedulerExecutor: async () => ({ stdout: "", stderr: "" })
      });

      expect(exitCode).toBe(0);
      expect(stdout.join("\n")).toContain("Installed macOS schedule for 23:30.");
      // No token value must ever leak, even on the failure path.
      expect(stdout.join("\n")).not.toContain("ghp_persist_will_fail");
      expect(stderr.join("\n")).not.toContain("ghp_persist_will_fail");

      // Scheduler really is installed.
      const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
      await expect(access(plistPath)).resolves.toBeUndefined();
    } finally {
      // Restore permissions so the temp dir can be cleaned up.
      await chmod(configDir, 0o700);
      vi.unstubAllGlobals();
    }
  });

  it("refuses install and preserves an existing plist when the executable path is unstable", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-preserve-"));
    const homeDir = join(directory, "home");
    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<!-- existing healthy plist -->", "utf8");

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir,
      schedulerExecutablePath:
        "/Users/user/repo/.claude/worktrees/clever-cerf-2fad25/dist/cli.js",
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("not a stable CLI entrypoint");
    expect(await readFile(plistPath, "utf8")).toBe("<!-- existing healthy plist -->");

    vi.unstubAllGlobals();
  });

  it("fails schedule install on unsupported platforms", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });

    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["macOS is required to install the scheduler."]);

    vi.unstubAllGlobals();
  });

  it("rejects schedule install without --time when config has no usable scheduleTime", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-notime-"));
    const homeDir = join(directory, "home");
    // No config file written → nothing to fall back to.

    const exitCode = await runCli(["schedule", "install"], io, { homeDir });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted schedule install --time HH:mm");
    vi.unstubAllGlobals();
  });

  it("falls back to config.scheduleTime when --time is omitted", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-configtime-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts")); // writes scheduleTime "23:30"

    const exitCode = await runCli(["schedule", "install"], io, {
      homeDir,
      schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Installed macOS schedule for 23:30.");

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    const plistContent = await readFile(plistPath, "utf8");
    expect(plistContent).toContain("<integer>23</integer>");
    expect(plistContent).toContain("<integer>30</integer>");

    vi.unstubAllGlobals();
  });

  it("prefers --time over config.scheduleTime when both are present", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-override-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts")); // config scheduleTime "23:30"

    const exitCode = await runCli(["schedule", "install", "--time", "06:45"], io, {
      homeDir,
      schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("Installed macOS schedule for 06:45.");

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    const plistContent = await readFile(plistPath, "utf8");
    expect(plistContent).toContain("<integer>6</integer>");
    expect(plistContent).toContain("<integer>45</integer>");

    vi.unstubAllGlobals();
  });

  it("rejects unknown install arguments instead of falling back to config", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-bogus-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts")); // writes scheduleTime "23:30"

    const exitCode = await runCli(["schedule", "install", "--bogus"], io, {
      homeDir,
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown argument: --bogus");
    expect(stderr.join("\n")).toContain("Usage: uncommitted schedule install --time HH:mm");

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    await expect(access(plistPath)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("rejects --time without a value instead of falling back to config", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-timenoval-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts")); // writes scheduleTime "23:30"

    const exitCode = await runCli(["schedule", "install", "--time"], io, {
      homeDir,
      schedulerExecutor: async () => ({ stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted schedule install --time HH:mm");

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.uncommitted.schedule.plist");
    await expect(access(plistPath)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("rejects invalid schedule time", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["schedule", "install", "--time", "25:00"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Schedule time must use 24-hour HH:mm format."]);
    vi.unstubAllGlobals();
  });

  it("returns error code when schedule installation fails", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { io, stdout, stderr } = createIo();
    // homeDir must be injected: without it this test would write the real
    // ~/Library/LaunchAgents plist before the executor throws.
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-fail-"));

    const exitCode = await runCli(["schedule", "install", "--time", "23:30"], io, {
      homeDir: join(directory, "home"),
      schedulerExecutablePath: "/usr/local/lib/node_modules/uncommitted/dist/cli.js",
      schedulerExecutor: async () => {
        throw new Error("launchctl failed");
      }
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["launchctl failed"]);
    vi.unstubAllGlobals();
  });

  it("routes doctor to the environment report handler", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-doctor-"));

    const exitCode = await runCli(["doctor"], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Uncommitted Doctor");
    expect(stdout.join("\n")).toContain("[fail] Global config");
  });

  it("returns config exit code when project add path is missing", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-add-"));

    const exitCode = await runCli(["project", "add", join(directory, "missing")], io, {
      homeDir: join(directory, "home")
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Path does not exist");
  });

  it("returns config exit code when project add finds invalid projects file", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-project-add-"));
    const repoDir = join(directory, "repo");
    const homeDir = join(directory, "home");

    await execFileAsync("git", ["init", repoDir]);
    await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
    await writeFile(join(homeDir, ".uncommitted", "projects.json"), "nope", "utf8");

    const exitCode = await runCli(["project", "add", repoDir], io, { homeDir });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Invalid projects file");
  });

  it("reports unknown commands", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["nope"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown command: nope");
    expect(stderr.join("\n")).toContain("Run `uncommitted --help`.");
  });

  it("detects direct runs through symlinked bin entrypoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-"));
    const realEntrypoint = join(directory, "cli.js");
    const linkedEntrypoint = join(directory, "uncommitted");

    await writeFile(realEntrypoint, "");
    await symlink(realEntrypoint, linkedEntrypoint);

    expect(isDirectRun(linkedEntrypoint, pathToFileURL(realEntrypoint).href)).toBe(true);
  });

  it("reports schedule status as not installed when plist is absent", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-status-absent-"));
    const homeDir = join(directory, "home");

    const exitCode = await runCli(["schedule", "status"], io, { homeDir });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Scheduler: not installed");
  });

  it("reports schedule status as installed and loaded when plist exists and launchctl confirms", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-status-loaded-"));
    const homeDir = join(directory, "home");
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), "<plist/>", "utf8");

    const exitCode = await runCli(["schedule", "status"], io, {
      homeDir,
      schedulerRunner: async () => ({
        exitCode: 0,
        stdout: "123\t0\tcom.uncommitted.schedule\n",
        stderr: ""
      })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Scheduler: installed, loaded");
  });

  it("reports schedule status with launchctl error degrading gracefully", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-status-lcfail-"));
    const homeDir = join(directory, "home");
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), "<plist/>", "utf8");

    const exitCode = await runCli(["schedule", "status"], io, {
      homeDir,
      schedulerRunner: async () => ({ exitCode: -1, stdout: "", stderr: "__ENOENT__" })
    });

    expect(exitCode).toBe(0);
    expect(stderr.join("\n")).toContain("launchctl");
    expect(stdout.join("\n")).toContain("Scheduler: installed, unknown");
  });

  it("reports a concise schedule time line when config and installed times match", async () => {
    const { io, stdout } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-status-match-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts")); // scheduleTime "23:30"

    const { xml } = buildLaunchAgentPlist({ homeDir, scheduleTime: "23:30" });
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), xml, "utf8");

    const exitCode = await runCli(["schedule", "status"], io, {
      homeDir,
      schedulerRunner: async () => ({
        exitCode: 0,
        stdout: "123\t0\tcom.uncommitted.schedule\n",
        stderr: ""
      })
    });

    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Schedule time: 23:30");
    expect(out).not.toMatch(/warning/i);
    expect(out).not.toMatch(/diverge/i);
  });

  it("warns and shows both times when config and installed schedule times diverge", async () => {
    const { io, stdout } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-status-diverge-"));
    const homeDir = join(directory, "home");
    await writeConfig(homeDir, join(directory, "drafts")); // config scheduleTime "23:30"

    const { xml } = buildLaunchAgentPlist({ homeDir, scheduleTime: "07:15" });
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), xml, "utf8");

    const exitCode = await runCli(["schedule", "status"], io, {
      homeDir,
      schedulerRunner: async () => ({
        exitCode: 0,
        stdout: "123\t0\tcom.uncommitted.schedule\n",
        stderr: ""
      })
    });

    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toMatch(/warning/i);
    expect(out).toContain("07:15"); // installed
    expect(out).toContain("23:30"); // config
  });

  it("degrades gracefully in status when config is unreadable", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-status-noconfig-"));
    const homeDir = join(directory, "home");
    // No config file written.

    const { xml } = buildLaunchAgentPlist({ homeDir, scheduleTime: "07:15" });
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), xml, "utf8");

    const exitCode = await runCli(["schedule", "status"], io, {
      homeDir,
      schedulerRunner: async () => ({
        exitCode: 0,
        stdout: "123\t0\tcom.uncommitted.schedule\n",
        stderr: ""
      })
    });

    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Scheduler: installed, loaded");
    // Installed time still surfaced even without config to compare against.
    expect(out).toContain("07:15");
    // No crash, no divergence warning when there is nothing to compare.
    expect(out).not.toMatch(/warning/i);
    expect(stderr).toEqual([]);
  });

  it("rejects schedule status with unexpected arguments", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["schedule", "status", "--extra"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted schedule status");
  });

  it("removes the scheduler when installed and launchctl succeeds", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-remove-installed-"));
    const homeDir = join(directory, "home");
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), "<plist/>", "utf8");

    const exitCode = await runCli(["schedule", "remove"], io, {
      homeDir,
      schedulerRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Scheduler removed.");
    expect(stdout.join("\n")).toContain("com.uncommitted.schedule.plist");
  });

  it("succeeds idempotently when scheduler is already absent", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-remove-absent-"));
    const homeDir = join(directory, "home");

    const exitCode = await runCli(["schedule", "remove"], io, {
      homeDir,
      schedulerRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("nothing to remove");
  });

  it("reports launchctl error on stderr but still reports removed when bootout fails non-fatally", async () => {
    const { io, stdout, stderr } = createIo();
    const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-remove-lcfail-"));
    const homeDir = join(directory, "home");
    const plistDir = join(homeDir, "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    await writeFile(join(plistDir, "com.uncommitted.schedule.plist"), "<plist/>", "utf8");

    const exitCode = await runCli(["schedule", "remove"], io, {
      homeDir,
      schedulerRunner: async () => ({ exitCode: 3, stdout: "", stderr: "3: No such process" })
    });

    expect(exitCode).toBe(0);
    expect(stderr.join("\n")).toContain("launchctl");
    expect(stdout.join("\n")).toContain("Scheduler removed.");
  });

  it("rejects schedule remove with unexpected arguments", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["schedule", "remove", "--extra"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: uncommitted schedule remove");
  });

  describe("preview latest", () => {
    const defaultStory = { schemaVersion: 1, title: "Test draft", slides: [] };
    const defaultMetadata = {
      schemaVersion: 1,
      targetDate: "2026-05-20",
      generatedAt: "2026-05-20T00:00:00.000Z",
      activityLevel: "moderate",
      formatName: "daily-summary",
      storyFormatVoice: "casual",
      storyFormatTone: "warm",
      projectIds: ["proj-a"],
      entryMode: "daily_global",
      slideCount: 3
    };
    const defaultSafetyReport = {
      schemaVersion: 1,
      status: "safe",
      risks: [],
      redactionsApplied: [],
      exportAllowed: true,
      message: "Safety check passed."
    };

    type PreviewArtifactOverrides = {
      caption?: string | null;
      story?: unknown;
      metadata?: unknown | "MALFORMED";
      safetyReport?: unknown;
      carouselPngs?: string[];
    };

    async function setupDraft(
      overrides: PreviewArtifactOverrides = {}
    ): Promise<{ homeDir: string; draftRoot: string; outputDir: string }> {
      const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-cli-"));
      const draftRoot = join(homeDir, "Uncommitted", "drafts");
      await mkdir(draftRoot, { recursive: true });

      const revision = await createDraftRevision({
        draftRoot,
        targetDate: "2026-05-20"
      });

      await writeFile(
        join(revision.outputDir, "story.json"),
        JSON.stringify(overrides.story ?? defaultStory, null, 2),
        "utf8"
      );

      await writeFile(
        join(revision.outputDir, "metadata.json"),
        overrides.metadata === "MALFORMED"
          ? "not valid json {{{"
          : JSON.stringify(overrides.metadata ?? defaultMetadata, null, 2),
        "utf8"
      );

      await writeFile(
        join(revision.outputDir, "safety-report.json"),
        JSON.stringify(overrides.safetyReport ?? defaultSafetyReport, null, 2),
        "utf8"
      );

      if (overrides.caption !== null) {
        await writeFile(
          join(revision.outputDir, "caption.txt"),
          overrides.caption ?? "Hello from the test caption.\n",
          "utf8"
        );
      }

      if (overrides.carouselPngs && overrides.carouselPngs.length > 0) {
        const carouselDir = join(revision.outputDir, "carousel");
        await mkdir(carouselDir, { recursive: true });
        for (const filename of overrides.carouselPngs) {
          await writeFile(join(carouselDir, filename), Buffer.alloc(0));
        }
      }

      await writeLatestDraftPointer(revision, "2026-05-20T00:00:00.000Z");

      return { homeDir, draftRoot, outputDir: revision.outputDir };
    }

    it("prints a rendered draft summary and exits 0", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupDraft({
        carouselPngs: ["01.png", "02.png"]
      });

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toContain("2026-05-20");
      expect(out).toContain("rev-001");
      expect(out).toContain("Hello from the test caption.");
      expect(out).toContain("carousel/01.png");
      expect(out).toContain("carousel/02.png");
    });

    it("prints a text-only draft summary when no carousel directory exists and exits 0", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupDraft();

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toContain("2026-05-20");
      expect(out).toContain("not yet rendered");
    });

    it("exits 1 with an actionable message when no latest draft exists", async () => {
      const { io, stdout, stderr } = createIo();
      const homeDir = await mkdtemp(
        join(tmpdir(), "uncommitted-preview-missing-")
      );

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toMatch(/No latest draft|generate today/i);
    });

    it("exits 1 with an actionable message when metadata.json is malformed", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupDraft({ metadata: "MALFORMED" });

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toMatch(/metadata\.json|invalid JSON/i);
    });

    it("shows warning safety state in stdout and exits 0", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupDraft({
        safetyReport: {
          schemaVersion: 1,
          status: "warning",
          risks: [],
          redactionsApplied: [],
          exportAllowed: true,
          message: "A test warning."
        }
      });

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out.toLowerCase()).toContain("warning");
    });

    it("shows blocked safety state in stdout and exits 0", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupDraft({
        safetyReport: {
          schemaVersion: 1,
          status: "blocked",
          risks: [],
          redactionsApplied: [],
          exportAllowed: false,
          message: "Content is blocked."
        }
      });

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out.toUpperCase()).toContain("BLOCKED");
    });

    it("does not mutate draft artifacts after a successful preview", async () => {
      const { io } = createIo();
      const { homeDir, draftRoot, outputDir } = await setupDraft({
        carouselPngs: ["01.png"]
      });

      const latestJsonPath = join(draftRoot, "latest.json");
      const metadataPath = join(outputDir, "metadata.json");
      const safetyPath = join(outputDir, "safety-report.json");

      const beforeLatest = await readFile(latestJsonPath, "utf8");
      const beforeMetadata = await readFile(metadataPath, "utf8");
      const beforeSafety = await readFile(safetyPath, "utf8");

      await runCli(["preview", "latest"], io, { homeDir });

      expect(await readFile(latestJsonPath, "utf8")).toBe(beforeLatest);
      expect(await readFile(metadataPath, "utf8")).toBe(beforeMetadata);
      expect(await readFile(safetyPath, "utf8")).toBe(beforeSafety);
    });

    it("reads draftRoot from config.json and finds drafts in a custom location", async () => {
      const { io, stdout, stderr } = createIo();
      const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-config-"));
      // Use a non-default draft root stored in config.json
      const customDraftRoot = join(homeDir, "custom", "drafts");
      await writeConfig(homeDir, customDraftRoot);

      const revision = await createDraftRevision({
        draftRoot: customDraftRoot,
        targetDate: "2026-05-20"
      });
      await writeFile(
        join(revision.outputDir, "story.json"),
        JSON.stringify(defaultStory, null, 2),
        "utf8"
      );
      await writeFile(
        join(revision.outputDir, "metadata.json"),
        JSON.stringify(defaultMetadata, null, 2),
        "utf8"
      );
      await writeFile(
        join(revision.outputDir, "safety-report.json"),
        JSON.stringify(defaultSafetyReport, null, 2),
        "utf8"
      );
      await writeFile(join(revision.outputDir, "caption.txt"), "Custom root caption\n", "utf8");
      await writeLatestDraftPointer(revision, "2026-05-20T00:00:00.000Z");

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout.join("\n")).toContain("Custom root caption");
    });

    // UNC-177/UNC-178: PreviewConfigError guard tests — central handler maps to exit 2 + unified message
    describe("readPreviewDraftRoot config guards (UNC-177/UNC-178)", () => {
      it("returns exit 2 with unified message when config has schemaVersion: 2", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-schema-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          JSON.stringify({ schemaVersion: 2, draftRoot: join(homeDir, "drafts") }),
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["preview", "latest"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("returns exit 2 with unified message when config is a record missing schemaVersion", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-noschema-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          JSON.stringify({ draftRoot: join(homeDir, "drafts") }),
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["preview", "latest"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("returns exit 2 with unified message when config is valid JSON but not a record", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-nonrecord-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          "[]",
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["preview", "latest"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("returns exit 2 with unified message when config.json contains malformed JSON", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-malformed-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          "{ not valid json ~~~",
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["preview", "latest"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("does not throw and returns resolved draftRoot when config has schemaVersion: 1", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-valid-"));
        const customDraftRoot = join(homeDir, "custom", "drafts");
        await writeConfig(homeDir, customDraftRoot);
        const { io } = createIo();
        // No throw — just reaches preview with the custom draft root (no latest draft so exits 1)
        const exitCode = await runCli(["preview", "latest"], io, { homeDir });
        expect(exitCode).toBe(1); // 1 because no draft exists, not because of config error
      });

      it("does not throw and returns default draftRoot when config.json is missing", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-missing-config-"));
        const { io } = createIo();
        // No throw — falls back to default draft root (no latest draft so exits 1)
        const exitCode = await runCli(["preview", "latest"], io, { homeDir });
        expect(exitCode).toBe(1); // 1 because no draft exists, not because of config error
      });
    });

    // UNC-178: Central config-corruption mapper tests
    describe("central config-corruption mapper (UNC-178)", () => {
      it("returns exit 2 + unified message for collect github with malformed config.json", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-collect-github-malformed-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          "{ not valid json ~~~",
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["collect", "github"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("returns exit 2 + unified message for collect git when config has an unsupported schemaVersion", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-collect-git-schema-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          JSON.stringify({ schemaVersion: 2, sources: { git: { enabled: false } } }),
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["collect", "git"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("returns exit 2 + unified message for collect git with malformed config.json (SourceConfigError path)", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-collect-git-malformed-"));
        await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
        await writeFile(
          join(homeDir, ".uncommitted", "config.json"),
          "{ not valid json ~~~",
          "utf8"
        );
        const { io, stderr } = createIo();
        const exitCode = await runCli(["collect", "git"], io, { homeDir });
        expect(exitCode).toBe(2);
        expect(stderr.join("\n")).toContain("Config error:");
        expect(stderr.join("\n")).toContain("is unreadable or malformed. Fix or remove the file.");
      });

      it("does not map exit 2 for valid config (no false positive)", async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-collect-git-valid-"));
        const draftRoot = join(homeDir, "drafts");
        await writeConfig(homeDir, draftRoot);
        const { io, stderr } = createIo();
        // collect git with valid config but no projects → exits 3 (collection error), not 2
        const exitCode = await runCli(["collect", "git"], io, { homeDir });
        expect(exitCode).toBe(3);
        expect(stderr.join("\n")).not.toContain("Config error:");
      });
    });

    it("exits 1 with usage message when no subcommand is given", async () => {
      const { io, stdout, stderr } = createIo();

      const exitCode = await runCli(["preview"], io);

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("Usage: uncommitted preview latest");
    });
  });

  describe("preview --date / --rev", () => {
    const defaultStory = { schemaVersion: 1, title: "Test draft", slides: [] };
    const defaultSafetyReport = {
      schemaVersion: 1,
      status: "safe",
      risks: [],
      redactionsApplied: [],
      exportAllowed: true,
      message: "Safety check passed."
    };

    function makeMetadata(targetDate: string): Record<string, unknown> {
      return {
        schemaVersion: 1,
        targetDate,
        generatedAt: `${targetDate}T00:00:00.000Z`,
        activityLevel: "moderate",
        formatName: "daily-summary",
        storyFormatVoice: "casual",
        storyFormatTone: "warm",
        projectIds: ["proj-a"],
        entryMode: "daily_global",
        slideCount: 3
      };
    }

    async function writeRevisionArtifacts(
      outputDir: string,
      targetDate: string,
      caption: string
    ): Promise<void> {
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        join(outputDir, "story.json"),
        JSON.stringify(defaultStory, null, 2),
        "utf8"
      );
      await writeFile(
        join(outputDir, "metadata.json"),
        JSON.stringify(makeMetadata(targetDate), null, 2),
        "utf8"
      );
      await writeFile(
        join(outputDir, "safety-report.json"),
        JSON.stringify(defaultSafetyReport, null, 2),
        "utf8"
      );
      await writeFile(join(outputDir, "caption.txt"), caption, "utf8");
    }

    async function setupTwoRevisions(): Promise<{
      homeDir: string;
      draftRoot: string;
      rev001Dir: string;
      rev002Dir: string;
    }> {
      const homeDir = await mkdtemp(
        join(tmpdir(), "uncommitted-preview-date-rev-")
      );
      const draftRoot = join(homeDir, "Uncommitted", "drafts");
      const rev001Dir = join(draftRoot, "2026-06-01", "rev-001");
      const rev002Dir = join(draftRoot, "2026-06-01", "rev-002");
      await writeRevisionArtifacts(rev001Dir, "2026-06-01", "Rev one caption\n");
      await writeRevisionArtifacts(rev002Dir, "2026-06-01", "Rev two caption\n");
      return { homeDir, draftRoot, rev001Dir, rev002Dir };
    }

    it("(a) --date <existing> selects the latest rev for that date", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--date", "2026-06-01"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toContain("2026-06-01");
      expect(out).toContain("rev-002");
      expect(out).toContain("Rev two caption");
    });

    it("(b) --date <existing> --rev rev-001 hits the specific rev", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--date", "2026-06-01", "--rev", "rev-001"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toContain("rev-001");
      expect(out).toContain("Rev one caption");
      expect(out).not.toContain("Rev two caption");
    });

    it("(c) --date <missing> exits 1 with literal 'No draft found for <date>'", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--date", "2026-05-01"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("No draft found for 2026-05-01");
    });

    it("(d) --date <existing> --rev rev-999 exits 1 with literal 'No draft rev-999 found for <date>'", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--date", "2026-06-01", "--rev", "rev-999"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain(
        "No draft rev-999 found for 2026-06-01"
      );
    });

    it("(e) preview latest still works (backward compat)", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir, draftRoot, rev002Dir } = await setupTwoRevisions();

      // Make rev-002 the latest pointer.
      const pointer = {
        schemaVersion: 1,
        targetDate: "2026-06-01",
        revision: "rev-002",
        path: rev002Dir,
        updatedAt: "2026-06-01T00:00:00.000Z"
      };
      await writeFile(
        join(draftRoot, "latest.json"),
        JSON.stringify(pointer, null, 2),
        "utf8"
      );

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toContain("rev-002");
      expect(out).toContain("Rev two caption");
    });

    it("(f1) --date with malformed value exits 1 with usage error", async () => {
      const { io, stdout, stderr } = createIo();
      const homeDir = await mkdtemp(
        join(tmpdir(), "uncommitted-preview-bad-date-")
      );

      const exitCode = await runCli(
        ["preview", "--date", "2026/06/02"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toMatch(/YYYY-MM-DD|--date/);
    });

    it("(f2) --rev with malformed value exits 1 with usage error", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--date", "2026-06-01", "--rev", "rev-1"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toMatch(/rev-NNN|--rev|Invalid revision/);
    });

    it("(f3) mixing positional 'latest' with --date exits 1 with usage error", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "latest", "--date", "2026-06-01"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toMatch(/Usage|cannot combine|latest/i);
    });

    it("(f4) --rev without --date exits 1 with usage error mentioning --date", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--rev", "rev-001"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toMatch(/--date/);
    });

    it("(f5) --date immediately followed by another flag reports a missing value", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--date", "--rev", "rev-001"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("--date requires a value");
    });

    it("(f6) --rev immediately followed by another flag reports a missing value", async () => {
      const { io, stdout, stderr } = createIo();
      const { homeDir } = await setupTwoRevisions();

      const exitCode = await runCli(
        ["preview", "--rev", "--date", "2026-06-01"],
        io,
        { homeDir }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("--rev requires a value");
    });
  });
});

it("`feedback --help` lists --date in the usage block", async () => {
  const { io, stdout } = createIo();
  const exitCode = await runCli(["feedback", "--help"], io);

  expect(exitCode).toBe(0);
  const out = stdout.join("\n");
  expect(out).toContain("uncommitted feedback");
  expect(out).toContain("--date <YYYY-MM-DD>");
});

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init", repoDir]);
  await git(repoDir, ["config", "user.name", "Fixture Dev"]);
  await git(repoDir, ["config", "user.email", "dev@example.com"]);
}

async function commit(
  repoDir: string,
  message: string,
  date: string
): Promise<void> {
  await git(repoDir, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

async function git(
  repoDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args], {
    env: {
      ...process.env,
      ...env
    }
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

type LatestDraftFixtureOptions = {
  story?: unknown;
  metadata?: Record<string, unknown>;
  writeVisualAsset?: boolean;
};

async function createLatestDraftFixture(options: LatestDraftFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-render-"));
  const homeDir = join(directory, "home");
  const draftRoot = join(directory, "drafts");
  const revision = await createDraftRevision({
    draftRoot,
    targetDate: "2026-05-18"
  });
  const story = options.story ?? createStoryDraft();
  const metadata = options.metadata ?? createDraftMetadata();

  await writeConfig(homeDir, draftRoot);
  await writeJson(join(revision.outputDir, "activity-summary.json"), {
    schemaVersion: 1
  });
  await writeJson(join(revision.outputDir, "story.json"), story);
  await writeFile(join(revision.outputDir, "caption.txt"), "Render latest\n", "utf8");
  await writeJson(join(revision.outputDir, "safety-report.json"), {
    schemaVersion: 1,
    status: "safe"
  });
  await writeJson(join(revision.outputDir, "metadata.json"), metadata);

  if (options.writeVisualAsset !== false) {
    await mkdir(join(revision.outputDir, "visuals"), { recursive: true });
    await writeFile(join(revision.outputDir, "visuals", "01.png"), pngBytes);
  }

  await writeLatestDraftPointer(revision, "2026-05-18T23:30:00.000Z");

  return {
    homeDir,
    draftRoot,
    revision
  };
}

// `schedule run-now` now collects every config-enabled source. Stub the
// non-git collectors so workflow tests stay deterministic and never touch the
// host's real ~/.claude / ~/.codex; git still runs for real against the
// fixture repo to feed generate/render.
function nonGitStubInvokers() {
  const ok = (detail: string) => async () => ({
    successCount: 1,
    failureCount: 0,
    detail
  });
  return {
    claude: ok("1 project, 0 signals (stub)"),
    codex: ok("1 project, 0 signals (stub)"),
    github: ok("0 projects, 0 signals (stub)")
  };
}

async function createScheduleRunNowFixture(
  sources?: Record<string, { enabled: boolean }>
) {
  const directory = await mkdtemp(join(tmpdir(), "uncommitted-cli-schedule-"));
  const repoDir = join(directory, "repo");
  const homeDir = join(directory, "home");
  const draftRoot = join(directory, "drafts");

  await initGitRepo(repoDir);
  await writeFile(join(repoDir, "scheduler.ts"), "const scheduled = true;\n", "utf8");
  await git(repoDir, ["add", "scheduler.ts"]);
  await commit(repoDir, "implement scheduled workflow", "2026-05-31T10:00:00Z");
  await writeConfig(homeDir, draftRoot, sources);
  await addProject(repoDir, {
    homeDir,
    now: () => "2026-05-31T00:00:00.000Z"
  });

  return {
    directory,
    repoDir,
    homeDir,
    draftRoot
  };
}

async function writeConfig(
  homeDir: string,
  draftRoot: string,
  sources?: Record<string, { enabled: boolean }>
): Promise<void> {
  await mkdir(join(homeDir, ".uncommitted"), { recursive: true });
  await writeJson(join(homeDir, ".uncommitted", "config.json"), {
    schemaVersion: 1,
    draftRoot,
    scheduleTime: "23:30",
    aiProvider: "none",
    persona: "test persona",
    roastLevel: 2,
    ...(sources ? { sources } : {})
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createStoryDraft(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    targetDate: "2026-05-18",
    title: "Render Latest Day",
    slides: [
      {
        index: 1,
        title: "Latest draft gets rendered",
        body: "The image was already generated, so render latest should use it.",
        visualMood: "polished local AI illustration"
      }
    ],
    metadata: {
      projectIds: ["uncommitted"]
    }
  };
}

function createDraftMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: 1,
    artifactVersion: 1,
    targetDate: "2026-05-18",
    date: "2026-05-18",
    status: "draft",
    files: [
      "activity-summary.json",
      "story.json",
      "caption.txt",
      "metadata.json",
      "safety-report.json",
      "visuals/01.png"
    ],
    visualAssets: [
      {
        schemaVersion: 1,
        slideIndex: 1,
        assetSlotId: "slide-01-visual",
        promptSummary: "polished local AI illustration",
        provider: "openai",
        filePath: "visuals/01.png",
        fallbackState: "none"
      }
    ]
  };
}

function createScheduleStoryFormatPlan(): Record<string, unknown> {
  return {
    mood: "grind",
    angle: "The scheduled workflow kept circling the same local activity.",
    pacing: {
      openWith: "scene",
      shape: "hook-turn-landing",
      suggestedSlideCount: 3
    },
    voice: "dry local coworker",
    tone: "concise and lightly amused",
    reason: "The scheduled workflow has real local activity to summarize.",
    structure: [
      {
        part: "Collect",
        purpose: "Name the local activity."
      },
      {
        part: "Generate",
        purpose: "Turn the activity into a diary beat."
      },
      {
        part: "Render",
        purpose: "Close with local carousel output."
      }
    ],
    captionStyle: "short practical caption",
    doNotMention: ["raw diffs", "private paths"]
  };
}

function createScheduleProviderDraft(): Record<string, unknown> {
  return {
    title: "Scheduled Workflow Day",
    slides: [
      {
        index: 1,
        title: "Collect",
        body: "Git activity was collected from the registered project.",
        visualMood: "terminal summary"
      },
      {
        index: 2,
        title: "Generate",
        body: "The text draft was generated from local activity.",
        visualMood: "draft files"
      },
      {
        index: 3,
        title: "Render",
        body: "The latest carousel was rendered locally.",
        visualMood: "finished carousel"
      }
    ],
    altText: "A local Uncommitted scheduled workflow summary."
  };
}

function createScheduleProviderCaption(): Record<string, unknown> {
  return {
    caption: "Scheduled run-now connected the local workflow.",
    hashtags: ["#Uncommitted", "#DevDiary"]
  };
}

class ScheduleAiProvider implements AiProvider {
  readonly name = "mock";
  readonly model?: string;

  constructor(private readonly options: { fail?: boolean; model?: string } = {}) {
    this.model = options.model;
  }

  async generateStructured(
    request: AiStructuredGenerationRequest
  ): Promise<AiProviderRawResponse> {
    if (this.options.fail) {
      throw new Error("provider unavailable");
    }

    if (request.task === "story-plan") {
      return { responseJson: JSON.stringify(createScheduleStoryFormatPlan()) };
    }

    if (request.task === "draft") {
      return { responseJson: JSON.stringify(createScheduleProviderDraft()) };
    }

    if (request.task === "caption") {
      return { responseJson: JSON.stringify(createScheduleProviderCaption()) };
    }

    throw new Error(`Unexpected task: ${request.task}`);
  }
}

class RecordingPngRenderer implements CarouselHtmlToPngRenderer {
  readonly calls: { html: string; width: number; height: number }[] = [];

  async renderHtmlToPng(options: {
    html: string;
    width: number;
    height: number;
  }): Promise<Uint8Array> {
    this.calls.push(options);

    return pngBytes;
  }
}

class FailingPngRenderer implements CarouselHtmlToPngRenderer {
  async renderHtmlToPng(): Promise<never> {
    throw new CarouselPngRenderError(
      "Could not render carousel PNGs.",
      "render-failed"
    );
  }
}
