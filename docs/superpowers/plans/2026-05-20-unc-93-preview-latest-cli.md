# Preview Latest CLI Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `preview-loader.ts` and `preview-formatter.ts` into the `uncommitted preview latest` CLI command, with full integration test coverage.

**Architecture:** The loader (`loadLatestDraftPreview`) and formatter (`formatPreview`) are already implemented on the branch. This task adds a single `runPreview` handler to `src/cli.ts` (following the exact same pattern as `runRender`) and wires it into the command dispatch. Integration tests go in the existing `tests/cli.test.ts`.

**Tech Stack:** TypeScript, Node.js, vitest, pnpm. All paths must use `node:path` join. Tests must use `tmpdir`-based temp directories.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/cli.ts` | Modify | Add `runPreview()` function + dispatch routing |
| `tests/cli.test.ts` | Modify | Add `describe("preview latest", ...)` with 6 integration tests + read-only assertion |

**Do NOT touch:** `src/preview-loader.ts`, `src/preview-formatter.ts`, `src/commands.ts` (already lists `preview`), `pnpm-lock.yaml`, any `.env*` file.

---

## Task 1: Write Failing Integration Tests

**Files:**
- Modify: `tests/cli.test.ts`

> All test helpers needed already exist at the top of `tests/cli.test.ts` (`createIo`, `mkdtemp`, etc.). The preview-loader tests in `tests/preview-loader.test.ts` use their own `writeDraftRevision`/`writeLatestPointer` helpers. For CLI integration tests, use the real `createDraftRevision` + `writeLatestDraftPointer` from `draft-storage.ts` (already imported), plus direct `writeFile` for individual artifacts.

- [ ] **Step 1.1: Add the describe block with a shared draft-creation helper to `tests/cli.test.ts`**

Append this entire block at the end of the `describe("cli", ...)` block (before its closing `}`):

```typescript
  describe("preview latest", () => {
    // Shared artifact defaults — mirrors preview-loader.test.ts defaults
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

    /**
     * Creates a temp draft root, writes a draft revision with the given overrides,
     * writes the root-level latest.json, and returns the homeDir for use in CliOptions.
     *
     * `homeDir` is configured so that resolveConfigPaths({ homeDir }).defaultDraftRoot
     * resolves to our temp draftRoot. We achieve this by setting draftRoot explicitly
     * in the CliOptions (exposed via `options.draftRoot` → passed to resolveConfigPaths).
     * Since CliOptions doesn't have a `draftRoot` field we can pass, we instead point
     * homeDir to a directory where ~/Uncommitted/drafts WOULD be our tempDir. The
     * cleanest approach: write a minimal config and inject `draftRoot` via a symlink
     * — but actually, the cleanest is to use the same approach as render tests:
     * use `createDraftRevision` to write inside a temp draftRoot, then inject via
     * `options.homeDir` set to a temp dir where `Uncommitted/drafts` is a symlink.
     *
     * Simplest correct approach: create a temp homeDir whose structure is:
     *   <homeDir>/Uncommitted/drafts/<targetDate>/rev-001/{artifacts}
     *   <homeDir>/Uncommitted/drafts/latest.json
     * That matches `resolveConfigPaths({ homeDir }).defaultDraftRoot` which expands
     * `~/Uncommitted/drafts` using the provided homeDir.
     */
    async function setupDraft(overrides: {
      caption?: string | null;
      story?: unknown;
      metadata?: unknown;
      safetyReport?: unknown;
      carouselPngs?: string[];
    } = {}): Promise<{ homeDir: string; draftRoot: string; outputDir: string }> {
      const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-cli-"));
      const draftRoot = join(homeDir, "Uncommitted", "drafts");
      await mkdir(draftRoot, { recursive: true });

      const revision = await createDraftRevision({ draftRoot, targetDate: "2026-05-20" });

      // Write story.json
      await writeFile(
        join(revision.outputDir, "story.json"),
        JSON.stringify(overrides.story ?? defaultStory, null, 2),
        "utf8"
      );

      // Write metadata.json
      if (overrides.metadata !== "SKIP") {
        await writeFile(
          join(revision.outputDir, "metadata.json"),
          overrides.metadata === "MALFORMED"
            ? "not valid json {{{"
            : JSON.stringify(overrides.metadata ?? defaultMetadata, null, 2),
          "utf8"
        );
      }

      // Write safety-report.json
      await writeFile(
        join(revision.outputDir, "safety-report.json"),
        JSON.stringify(overrides.safetyReport ?? defaultSafetyReport, null, 2),
        "utf8"
      );

      // Write caption.txt (skip if null)
      if (overrides.caption !== null) {
        await writeFile(
          join(revision.outputDir, "caption.txt"),
          overrides.caption ?? "Hello from the test caption.\n",
          "utf8"
        );
      }

      // Write carousel PNGs if requested
      if (overrides.carouselPngs && overrides.carouselPngs.length > 0) {
        const carouselDir = join(revision.outputDir, "carousel");
        await mkdir(carouselDir, { recursive: true });
        for (const filename of overrides.carouselPngs) {
          await writeFile(join(carouselDir, filename), Buffer.alloc(0));
        }
      }

      // Write latest.json pointer
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
      const { homeDir } = await setupDraft(); // no carouselPngs

      const exitCode = await runCli(["preview", "latest"], io, { homeDir });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toContain("2026-05-20");
      // formatter emits this line for text-only drafts
      expect(out).toContain("not yet rendered");
    });

    it("exits 1 with an actionable message when no latest draft exists", async () => {
      const { io, stdout, stderr } = createIo();
      const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-preview-missing-"));
      // no draftRoot created, no latest.json

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

    it("exits 1 with usage message when no subcommand is given", async () => {
      const { io, stdout, stderr } = createIo();

      const exitCode = await runCli(["preview"], io);

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("Usage: uncommitted preview latest");
    });
  });
```

- [ ] **Step 1.2: Run the tests to confirm they all fail (expected)**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test -- --reporter=verbose 2>&1 | grep -A2 "preview latest"
```

Expected: All 8 tests in the `preview latest` describe block fail because `runCli(["preview", "latest"])` currently falls through to `Command not implemented yet: preview`.

---

## Task 2: Implement `runPreview` in `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 2.1: Add imports for `loadLatestDraftPreview` and `formatPreview` and `resolveConfigPaths`**

At the top of `src/cli.ts`, add to the existing import block. Find the existing import for `RenderCommandError` and add after it:

```typescript
import { loadLatestDraftPreview } from "./preview-loader.js";
import { formatPreview } from "./preview-formatter.js";
import { resolveConfigPaths } from "./config-paths.js";
```

- [ ] **Step 2.2: Add the `runPreview` function**

Add this function anywhere before the final `io.stderr(\`Command not implemented yet...\`)` line — e.g., between `runRender` and `runGenerate`:

```typescript
async function runPreview(
  args: string[],
  io: CliIo,
  options: CliOptions
): Promise<number> {
  const [subcommand] = args;

  if (subcommand !== "latest" || args.length !== 1) {
    io.stderr("Usage: uncommitted preview latest");
    return 1;
  }

  const { defaultDraftRoot } = resolveConfigPaths({ homeDir: options.homeDir });
  const result = await loadLatestDraftPreview(defaultDraftRoot);

  if (result.outcome === "success") {
    io.stdout(formatPreview(result));
    return 0;
  }

  // missing or malformed — format returns an "Error: ..." string; send to stderr
  io.stderr(formatPreview(result));
  return 1;
}
```

- [ ] **Step 2.3: Wire the dispatch in `runCli`**

In `runCli`, find the `if (command === "render")` block and add directly after it:

```typescript
  if (command === "preview") {
    return await runPreview(commandArgs, io, options);
  }
```

- [ ] **Step 2.4: Run the tests to confirm they all pass**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|preview latest)"
```

Expected: All 8 tests in `preview latest` pass. All pre-existing tests continue to pass.

---

## Task 3: Typecheck and Build

**Files:** (no changes)

- [ ] **Step 3.1: Run typecheck**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm typecheck 2>&1
```

Expected: No errors.

- [ ] **Step 3.2: Run build**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm build 2>&1
```

Expected: Build succeeds with no errors.

- [ ] **Step 3.3: Run full test suite**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
pnpm test 2>&1 | tail -20
```

Expected: All tests pass.

---

## Task 4: Commit

- [ ] **Step 4.1: Stage only the two changed files**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
git add src/cli.ts tests/cli.test.ts
git diff --staged --stat
```

- [ ] **Step 4.2: Commit with gitmoji + Refs footer**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
git commit -m "$(cat <<'EOF'
✨ feat(preview-export): wire preview latest CLI command end-to-end

Add runPreview handler to src/cli.ts that calls loadLatestDraftPreview
and formatPreview, mapping missing/malformed outcomes to exit 1 and
success to exit 0. Add 8 integration tests covering rendered preview,
text-only preview, missing latest, malformed metadata, warning safety,
blocked safety, read-only mutation check, and invalid subcommand.

Refs: UNC-93
🤖 Generated with Routine B (Uncommitted Builder)
EOF
)"
```

- [ ] **Step 4.3: Push to origin**

```bash
cd /Users/drchasekim/Developer/uncommitted-UNC-77
git push origin claude/UNC-77-implement-preview-latest
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] `preview latest` prints a useful summary → Task 1 test 1 + Task 2 implementation
- [x] Exit code 0 on success, non-zero on missing/malformed → Task 2 implementation + Task 1 tests 3,4
- [x] Warning and blocked visible in stdout → Task 1 tests 5,6
- [x] No draft artifact mutated → Task 1 test 7
- [x] Integration tests cover rendered, text-only, missing, malformed, warning, blocked → Task 1 tests 1-6

**Placeholder scan:** None found — all steps have concrete code and commands.

**Type consistency:**
- `loadLatestDraftPreview(draftRoot: string)` ← matches `preview-loader.ts` export
- `formatPreview(result: PreviewLoaderResult)` ← matches `preview-formatter.ts` export
- `resolveConfigPaths({ homeDir })` returns `{ defaultDraftRoot: string, ... }` ← matches `config-paths.ts`
- `createDraftRevision({ draftRoot, targetDate })` returns `DraftRevision` with `.outputDir`, `.latestPointerPath` ← matches `draft-storage.ts`
- `writeLatestDraftPointer(revision, updatedAt)` ← matches `draft-storage.ts`

**Exit code for blocked/warning:** Confirmed `preview` is read-only review; formatter shows status in stdout; exit 0. Only loader failures (missing, malformed) → exit 1.
