import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTier1Archives,
  buildRawNarrativeProjection
} from "../src/raw-narrative-archive.js";
import {
  defaultSourceConfigMap,
  type SourceConfigMap,
  type SourceName
} from "../src/source-config.js";

type RawSource = "claude" | "codex" | "github";

const TARGET_DATE = "2026-06-29";

const allEnabled = (): SourceConfigMap => defaultSourceConfigMap();

const withDisabled = (...sources: SourceName[]): SourceConfigMap => {
  const map = defaultSourceConfigMap();
  for (const source of sources) {
    map[source] = { enabled: false };
  }
  return map;
};

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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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

  it("skips a github issue-body (attributed on closer, not author) but keeps pr-body", async () => {
    await seedRawArchive(projectRoot, "github", [
      JSON.stringify({
        source: "issue-body",
        number: 7,
        visibility: "public",
        text: "A teammate's issue description the user merely closed.",
        timestamp: "2026-06-29T09:00:00.000Z"
      }),
      JSON.stringify({
        source: "pr-body",
        number: 8,
        visibility: "public",
        text: "The user's own PR description.",
        timestamp: "2026-06-29T09:05:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      sourceConfig: allEnabled(),
      targetDate: TARGET_DATE
    });

    expect(turns.map((t) => t.text)).toEqual(["The user's own PR description."]);
  });

  it("carries the conversation role through onto the narrative turn", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "user",
        text: "Please add a prune step.",
        timestamp: "2026-06-29T10:00:00.000Z"
      })
    ]);

    const { turns } = await readTier1Archives({
      projects: [{ id: "proj-a", root: projectRoot }],
      sourceConfig: allEnabled(),
      targetDate: TARGET_DATE
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("user");
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
      sourceConfig: withDisabled("claude"),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: withDisabled("claude", "codex", "github"),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
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
      sourceConfig: allEnabled(),
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });

    expect(projection.droppedTurns).toBeGreaterThanOrEqual(1);
    for (const turn of projection.turns) {
      expect(turn.text).not.toContain("ghp_");
    }
  });

  it("drops user-role request turns and keeps assistant evidence", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "user",
        text: "Please rewrite the whole renderer from scratch tomorrow.",
        timestamp: "2026-06-29T10:00:00.000Z"
      }),
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "Fixed the flaky carousel test and tidied the summary.",
        timestamp: "2026-06-29T10:01:00.000Z"
      })
    ]);

    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      sourceConfig: allEnabled(),
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });

    const texts = projection.turns.map((t) => t.text);
    expect(texts).toContain("Fixed the flaky carousel test and tidied the summary.");
    expect(texts).not.toContain(
      "Please rewrite the whole renderer from scratch tomorrow."
    );
    // The dropped user turn is still accounted for.
    expect(projection.droppedTurns).toBeGreaterThanOrEqual(1);
  });

  it("drops a raw-code turn before egress and keeps clean prose", async () => {
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "function renderCard() { return draw(slides); }",
        timestamp: "2026-06-29T10:00:00.000Z"
      }),
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "Walked through the failure and landed a clean fix.",
        timestamp: "2026-06-29T10:01:00.000Z"
      })
    ]);

    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      sourceConfig: allEnabled(),
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 1000
    });

    const texts = projection.turns.map((t) => t.text);
    expect(texts).toEqual(["Walked through the failure and landed a clean fix."]);
    expect(texts.join(" ")).not.toContain("function renderCard");
    expect(projection.droppedTurns).toBeGreaterThanOrEqual(1);
  });

  it("counts turns selection omits under a tight token budget", async () => {
    // Two clean prose turns in the same session, each ~12 tokens. A budget of
    // 12 fits only one, so selection must omit the other AND report it dropped.
    await seedRawArchive(projectRoot, "claude", [
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "a".repeat(48),
        timestamp: "2026-06-29T10:00:00.000Z"
      }),
      JSON.stringify({
        kind: "turn",
        role: "assistant",
        text: "b".repeat(48),
        timestamp: "2026-06-29T10:01:00.000Z"
      })
    ]);

    const projection = await buildRawNarrativeProjection({
      projects: [{ id: "proj-a", root: projectRoot }],
      sourceConfig: allEnabled(),
      configFilePath: join(projectRoot, "config.json"),
      targetDate: TARGET_DATE,
      budget: 12
    });

    expect(projection.turns.length).toBe(1);
    expect(projection.droppedTurns).toBe(1);
    expect(projection.droppedTokens).toBeGreaterThan(0);
  });
});
