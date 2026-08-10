import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPaths } from "../src/config-paths.js";
import {
  createDraftRevision,
  readLatestDraftPointer,
  writeCaptionFailureDiagnostics,
  writeDraftArtifactJson,
  writeDraftArtifactText,
  writeIncompleteDraftMarker,
  writeLatestDraftPointer,
  writeTextDraftRevision
} from "../src/draft-storage.js";

describe("draft storage", () => {
  it("writes the first text draft revision under the configured draft root", async () => {
    const draftRoot = await createDraftRoot();
    const result = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activitySummary: { schemaVersion: 1, targetDate: "2026-05-18" },
      story: { schemaVersion: 1, title: "First draft" },
      caption: "First caption\n",
      metadata: { schemaVersion: 1, files: ["activity-summary.json"] }
    });

    expect(result).toEqual({
      targetDate: "2026-05-18",
      revision: "rev-001",
      dateDir: join(draftRoot, "2026-05-18"),
      outputDir: join(draftRoot, "2026-05-18", "rev-001"),
      latestPointerPath: join(draftRoot, "latest.json"),
      dateLatestPointerPath: join(draftRoot, "2026-05-18", "latest.json"),
      files: [
        "activity-summary.json",
        "story.json",
        "caption.txt",
        "metadata.json"
      ]
    });
    await expectJson(join(result.outputDir, "activity-summary.json"), {
      schemaVersion: 1,
      targetDate: "2026-05-18"
    });
    await expectJson(join(result.outputDir, "story.json"), {
      schemaVersion: 1,
      title: "First draft"
    });
    await expect(readFile(join(result.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "First caption\n"
    );
    await expectJson(join(result.outputDir, "metadata.json"), {
      schemaVersion: 1,
      files: ["activity-summary.json"]
    });
  });

  it("creates the next revision without overwriting existing draft artifacts", async () => {
    const draftRoot = await createDraftRoot();

    const first = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1, title: "First" },
      caption: "First caption\n",
      metadata: { schemaVersion: 1 }
    });
    const second = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:45:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1, title: "Second" },
      caption: "Second caption\n",
      metadata: { schemaVersion: 1 }
    });

    expect(first.revision).toBe("rev-001");
    expect(second.revision).toBe("rev-002");
    await expect(readFile(join(first.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "First caption\n"
    );
    await expect(readFile(join(second.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "Second caption\n"
    );
  });

  it("updates latest pointers to the newest revision", async () => {
    const draftRoot = await createDraftRoot();

    await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:30:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1 },
      caption: "First\n",
      metadata: { schemaVersion: 1 }
    });
    const latestRevision = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-18",
      generatedAt: "2026-05-18T23:45:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1 },
      caption: "Second\n",
      metadata: { schemaVersion: 1 }
    });

    await expectJson(latestRevision.latestPointerPath, {
      schemaVersion: 1,
      targetDate: "2026-05-18",
      revision: "rev-002",
      path: latestRevision.outputDir,
      updatedAt: "2026-05-18T23:45:00.000Z"
    });
    await expectJson(latestRevision.dateLatestPointerPath, {
      schemaVersion: 1,
      targetDate: "2026-05-18",
      revision: "rev-002",
      path: latestRevision.outputDir,
      updatedAt: "2026-05-18T23:45:00.000Z"
    });
    await expect(readLatestDraftPointer(draftRoot)).resolves.toEqual({
      schemaVersion: 1,
      targetDate: "2026-05-18",
      revision: "rev-002",
      path: latestRevision.outputDir,
      updatedAt: "2026-05-18T23:45:00.000Z"
    });
  });

  it("uses draft roots resolved through config path helpers", async () => {
    const homeDir = await createDraftRoot();
    const draftRoot = resolveConfigPaths({
      homeDir,
      draftRoot: "configured-drafts"
    }).defaultDraftRoot;
    const result = await writeTextDraftRevision({
      draftRoot,
      targetDate: "2026-05-19",
      generatedAt: "2026-05-19T23:30:00.000Z",
      activitySummary: { schemaVersion: 1 },
      story: { schemaVersion: 1 },
      caption: "Configured root\n",
      metadata: { schemaVersion: 1 }
    });

    expect(result.outputDir).toBe(
      join(homeDir, "configured-drafts", "2026-05-19", "rev-001")
    );
  });

  it("supports partial artifact writes before finalizing latest pointers", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-05-20"
    });

    await writeDraftArtifactJson(revision, "activity-summary.json", {
      schemaVersion: 1,
      targetDate: "2026-05-20"
    });
    await writeDraftArtifactText(revision, "caption.txt", "Partial caption\n");
    await writeLatestDraftPointer(revision, "2026-05-20T23:30:00.000Z");

    await expectJson(join(revision.outputDir, "activity-summary.json"), {
      schemaVersion: 1,
      targetDate: "2026-05-20"
    });
    await expect(readFile(join(revision.outputDir, "caption.txt"), "utf8")).resolves.toBe(
      "Partial caption\n"
    );
    await expectJson(revision.latestPointerPath, {
      revision: "rev-001",
      path: revision.outputDir
    });
  });

  it("fails with an actionable error when JSON artifact content is invalid", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-05-20"
    });

    await expect(
      writeDraftArtifactJson(revision, "metadata.json", undefined)
    ).rejects.toMatchObject({
      code: "invalid-json",
      message: "Draft artifact JSON is invalid."
    });
  });

  it("marks a revision incomplete without touching the latest pointer", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeIncompleteDraftMarker(revision, {
      stage: "caption",
      reason: "AI provider returned invalid caption.",
      failedAt: "2026-08-10T14:30:00.000Z",
      targetDate: "2026-08-10"
    });

    const metadata = JSON.parse(
      await readFile(join(revision.outputDir, "metadata.json"), "utf8")
    ) as Record<string, unknown>;

    expect(metadata.status).toBe("incomplete");
    expect(metadata.incomplete).toMatchObject({
      stage: "caption",
      reason: "AI provider returned invalid caption.",
      failedAt: "2026-08-10T14:30:00.000Z"
    });
    await expect(readFile(join(draftRoot, "latest.json"), "utf8")).rejects.toThrow();
  });

  it("redacts secrets, tokens, absolute paths, and emails from the incomplete marker reason", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeIncompleteDraftMarker(revision, {
      stage: "caption",
      reason:
        "provider error at /Users/someone/secret, contact dev@example.com, token: sk-abcdef1234567890abcdef",
      failedAt: "2026-08-10T14:30:00.000Z",
      targetDate: "2026-08-10"
    });

    const raw = await readFile(join(revision.outputDir, "metadata.json"), "utf8");
    const metadata = JSON.parse(raw) as Record<string, unknown>;
    const reason = (metadata.incomplete as Record<string, unknown>).reason as string;

    expect(reason).not.toContain("dev@example.com");
    expect(reason).not.toContain("/Users/someone/secret");
    expect(reason).not.toContain("sk-abcdef1234567890abcdef");
  });

  it("writes redacted caption failure diagnostics", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeCaptionFailureDiagnostics(revision, {
      failedAt: "2026-08-10T14:30:00.000Z",
      reason: "AI provider returned invalid caption.",
      violations: ["caption-empty", "hashtags-count-out-of-range"],
      attempts: 2,
      rawResponseJson:
        '{"caption":"", "note":"reach me at dev@example.com or /Users/someone/secret, token: sk-abcdef1234567890abcdef"}'
    });

    const raw = await readFile(
      join(revision.outputDir, "caption-failure.json"),
      "utf8"
    );
    const diagnostics = JSON.parse(raw) as Record<string, unknown>;

    expect(diagnostics.violations).toEqual([
      "caption-empty",
      "hashtags-count-out-of-range"
    ]);
    expect(diagnostics.failedAt).toBe("2026-08-10T14:30:00.000Z");
    expect(diagnostics.attempts).toBe(2);
    expect(diagnostics.stage).toBe("caption");

    // AC4: secret·토큰·로컬 절대경로·이메일이 남지 않는다.
    expect(raw).not.toContain("dev@example.com");
    expect(raw).not.toContain("/Users/someone/secret");
    expect(raw).not.toContain("sk-abcdef1234567890abcdef");
  });

  // `detectSecrets`'s ASSIGNMENT_PATTERN (src/credential-detector.ts:38-41) only fires
  // when the secret keyword is immediately followed by `:` or `=`, and its high-entropy
  // sweep only fires at >=32 chars, so a secret leaked in prose with neither delimiter
  // nor length ("here's the token sk-...") is NOT redacted by detectSecrets alone.
  //
  // This is deliberately not closed by widening credential-detector.ts: that detector is
  // shared with the safety-report/export-blocking pipeline, and making the assignment
  // heuristic match "keyword + whitespace" would redact the word after every ordinary
  // use of "secret"/"token"/"auth" in prose ("secret sauce", "token bucket") — a
  // product-wide false-positive regression (see UNC-257 review). Instead,
  // `redactDiagnosticText` in draft-storage.ts adds a local, prefix-anchored token pass
  // (matching on a vendor prefix like "sk-" rather than a preceding keyword, so it
  // cannot produce that false positive) that closes this specific case.
  it("redacts an undelimited sk- token in prose via the local prefix-anchored pass", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeCaptionFailureDiagnostics(revision, {
      failedAt: "2026-08-10T14:30:00.000Z",
      reason: "AI provider returned invalid caption.",
      violations: ["caption-empty", "hashtags-count-out-of-range"],
      attempts: 2,
      rawResponseJson:
        '{"caption":"", "note":"reach me at dev@example.com or /Users/someone/secret, token sk-abcdef1234567890abcdef"}'
    });

    const raw = await readFile(
      join(revision.outputDir, "caption-failure.json"),
      "utf8"
    );

    // AC4 as literally worded: no secret/token survives, delimited or not.
    expect(raw).not.toContain("sk-abcdef1234567890abcdef");
    expect(raw).toContain("[redacted-secret]");
  });

  // UNC-257 review follow-up: the prefix-anchored pass above only fires on a
  // recognized vendor prefix. A token with no vendor prefix, under 32 chars,
  // and no `key:`/`key=` delimiter ("token abc123def456ghi789") slipped past
  // every pass and was persisted verbatim into caption-failure.json. Diagnostics
  // redaction is fail-closed: a keyword-anchored pass shaped to token-like
  // candidates closes it.
  it("redacts an undelimited non-vendor token that follows a credential keyword", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeCaptionFailureDiagnostics(revision, {
      failedAt: "2026-08-10T14:30:00.000Z",
      reason: "AI provider returned invalid caption.",
      violations: ["hashtags-count-out-of-range"],
      attempts: 2,
      rawResponseJson:
        '{"caption":"", "note":"use token abc123def456ghi789 and password Hunter2Hunter2 to retry"}'
    });

    const raw = await readFile(
      join(revision.outputDir, "caption-failure.json"),
      "utf8"
    );

    expect(raw).not.toContain("abc123def456ghi789");
    expect(raw).not.toContain("Hunter2Hunter2");
    expect(raw).toContain("[redacted-secret]");
  });

  // The same pass must not eat ordinary prose. Plain lowercase words after a
  // credential keyword ("token bucket", "secret sauce") are exactly the
  // false positive that kept this heuristic out of the shared
  // credential-detector.ts, so it stays shaped to token-like candidates.
  it("leaves ordinary prose after a credential keyword intact", async () => {
    const draftRoot = await createDraftRoot();
    const revision = await createDraftRevision({
      draftRoot,
      targetDate: "2026-08-10"
    });

    await writeCaptionFailureDiagnostics(revision, {
      failedAt: "2026-08-10T14:30:00.000Z",
      reason:
        "token bucket exhausted while the secret sauce configuration reloaded",
      violations: ["caption-empty"],
      attempts: 2
    });

    const diagnostics = JSON.parse(
      await readFile(join(revision.outputDir, "caption-failure.json"), "utf8")
    ) as Record<string, unknown>;

    expect(diagnostics.reason).toBe(
      "token bucket exhausted while the secret sauce configuration reloaded"
    );
  });

  it("returns a short error for unusable draft roots", async () => {
    const directory = await createDraftRoot();
    const draftRoot = join(directory, "draft-root-file");

    await writeFile(draftRoot, "not a directory", "utf8");

    await expect(
      writeTextDraftRevision({
        draftRoot,
        targetDate: "2026-05-21",
        generatedAt: "2026-05-21T23:30:00.000Z",
        activitySummary: { schemaVersion: 1 },
        story: { schemaVersion: 1 },
        caption: "Blocked by storage\n",
        metadata: { schemaVersion: 1 }
      })
    ).rejects.toMatchObject({
      code: "inspect-failed",
      message: "Could not inspect draft revisions."
    });
  });
});

async function createDraftRoot(): Promise<string> {
  const root = join(tmpdir(), `uncommitted-draft-storage-${randomUUID()}`);

  await mkdir(root, { recursive: true });

  return root;
}

async function expectJson(path: string, value: Record<string, unknown>): Promise<void> {
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(value);
}
