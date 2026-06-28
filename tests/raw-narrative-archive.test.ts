import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTier1Archives,
  buildRawNarrativeProjection
} from "../src/raw-narrative-archive.js";

type RawSource = "claude" | "codex" | "github";

const TARGET_DATE = "2026-06-29";

async function makeProjectRoot(prefix = "unc-164-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function seedRawArchive(
  projectRoot: string,
  source: RawSource,
  lines: string[],
  targetDate = TARGET_DATE
): Promise<string> {
  const rawDir = join(projectRoot, ".uncommitted", "events", source, "raw");
  await mkdir(rawDir, { recursive: true });
  const file = join(rawDir, `${targetDate}.jsonl`);
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

describe("readTier1Archives", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await makeProjectRoot();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("normalizes a claude conversation turn into a NarrativeTurn", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "I refactored the parser today.",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      source: "claude",
      text: "I refactored the parser today.",
      timestamp: "2026-06-29T10:00:00.000Z",
      sessionId: `claude:proj-a:${TARGET_DATE}`,
      hasCodeOrToolMarker: false
    });
  });

  it("normalizes a claude tool entry, combining tool + target with marker true", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "tool",
        tool: "Edit",
        target: "src/index.ts",
        timestamp: "2026-06-29T10:01:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Edit src/index.ts");
    expect(turns[0].hasCodeOrToolMarker).toBe(true);
    expect(turns[0].source).toBe("claude");
  });

  it("normalizes a codex tool entry without target", async () => {
    await seedRawArchive(projectRoot, "codex", [
      JSON.stringify({
        kind: "tool",
        tool: "Bash",
        timestamp: "2026-06-29T10:02:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Bash");
    expect(turns[0].hasCodeOrToolMarker).toBe(true);
    expect(turns[0].source).toBe("codex");
  });

  it("extracts authored text from a github own-authored body entry", async () => {
    await seedRawArchive(projectRoot, "github", [
      JSON.stringify({
        source: "pr-body",
        number: 42,
        visibility: "public",
        text: "This PR wires the archive reader into generate.",
        timestamp: "2026-06-29T09:00:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      source: "github",
      text: "This PR wires the archive reader into generate.",
      timestamp: "2026-06-29T09:00:00.000Z",
      sessionId: `github:proj-a:${TARGET_DATE}`
    });
  });

  it("gates a disabled source to zero turns with status 'disabled', distinct from 'no-archive'", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "user",
        text: "hello",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);
    // codex has no file at all.

    const { turns, discoveries } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: { sources: { claude: { enabled: false } } },
      targetDate: TARGET_DATE
    });

    expect(turns).toHaveLength(0);

    const claude = discoveries.find((d) => d.source === "claude");
    const codex = discoveries.find((d) => d.source === "codex");
    expect(claude?.status).toBe("disabled");
    expect(claude?.turnCount).toBe(0);
    expect(codex?.status).toBe("no-archive");
    expect(codex?.turnCount).toBe(0);
    // disabled vs absent are distinguishable.
    expect(claude?.status).not.toBe(codex?.status);
  });

  it("marks an enabled source with a present file as 'read'", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "user",
        text: "hello there",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);

    const { discoveries } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    const claude = discoveries.find((d) => d.source === "claude");
    expect(claude?.status).toBe("read");
    expect(claude?.turnCount).toBe(1);
  });

  it("skips malformed JSONL lines without throwing and keeps surrounding valid lines", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "user",
        text: "first",
        timestamp: "2026-06-29T10:00:00.000Z"
      }),
      "{ this is not valid json",
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "second",
        timestamp: "2026-06-29T10:01:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
  });

  it("skips turn entries with empty or non-string text", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({ kind: "turn", role: "user", text: "", timestamp: "x" }),
      JSON.stringify({ kind: "turn", role: "user", text: 5, timestamp: "x" }),
      JSON.stringify({ kind: "turn", role: "user", text: "kept", timestamp: "x" })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      targetDate: TARGET_DATE
    });

    expect(turns.map((t) => t.text)).toEqual(["kept"]);
  });
});

describe("buildRawNarrativeProjection", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await makeProjectRoot();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("produces a non-empty projection within budget from present archives", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "Implemented the Tier 1 archive reader.",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);

    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });

    expect(projection.turns.length).toBeGreaterThan(0);
    expect(projection.totalTokens).toBeLessThanOrEqual(projection.budget);
    expect(projection.budget).toBe(1000);
  });

  it("returns an empty projection when all archives are absent", async () => {
    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 500
    });

    expect(projection.turns).toEqual([]);
    expect(projection.totalTokens).toBe(0);
    expect(projection.droppedTurns).toBe(0);
    expect(projection.droppedTokens).toBe(0);
    expect(projection.budget).toBe(500);
  });

  it("returns an empty projection when every source is disabled", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "user",
        text: "present but disabled",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);

    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {
        sources: {
          claude: { enabled: false },
          codex: { enabled: false },
          github: { enabled: false }
        }
      },
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 500
    });

    expect(projection.turns).toEqual([]);
    expect(projection.budget).toBe(500);
  });

  it("yields a visibly different (non-empty vs empty) projection present vs absent (Q4)", async () => {
    const absent = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });
    expect(absent.turns).toHaveLength(0);

    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "Now there is real raw narrative material to project.",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);

    const present = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });

    expect(present.turns.length).toBeGreaterThan(0);
    expect(present.turns.length).not.toBe(absent.turns.length);
  });

  it("drops a turn containing a planted secret in the egress step and counts it", async () => {
    const secret = "ghp_" + "a".repeat(36);
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: `Here is the token to use: ${secret}`,
        timestamp: "2026-06-29T10:00:00.000Z"
      }),
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "A perfectly clean follow-up line of narrative.",
        timestamp: "2026-06-29T10:01:00.000Z"
      })
    ]);

    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      config: {},
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });

    expect(projection.droppedTurns).toBeGreaterThanOrEqual(1);
    for (const turn of projection.turns) {
      expect(turn.text).not.toContain("ghp_");
    }
  });
});
