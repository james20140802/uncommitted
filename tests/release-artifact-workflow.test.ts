// tests/release-artifact-workflow.test.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../");
const workflowPath = resolve(
  repoRoot,
  ".github/workflows/release-artifact.yml"
);

describe("release-artifact.yml", () => {
  it("exists at .github/workflows/release-artifact.yml", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("supports workflow_dispatch trigger", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("workflow_dispatch");
  });

  it("does not have a tag push trigger (release.yml owns tag-based publishing)", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).not.toContain("tags:");
    expect(content).not.toContain("- 'v*'");
  });

  it("pins pnpm to 10.10.0", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("version: 10.10.0");
  });

  it("uses Node.js 22", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("node-version: 22");
  });

  it("runs all validation steps before packaging", () => {
    const content = readFileSync(workflowPath, "utf8");
    const lintPos = content.indexOf("pnpm lint");
    const typecheckPos = content.indexOf("pnpm typecheck");
    const buildPos = content.indexOf("pnpm build");
    const testPos = content.indexOf("pnpm test");
    const packPos = content.indexOf("pnpm pack");
    expect(lintPos, "lint step missing").toBeGreaterThan(-1);
    expect(typecheckPos, "typecheck step missing").toBeGreaterThan(-1);
    expect(buildPos, "build step missing").toBeGreaterThan(-1);
    expect(testPos, "test step missing").toBeGreaterThan(-1);
    expect(packPos, "pack step missing").toBeGreaterThan(-1);
    // pnpm pack must come AFTER all four validation steps
    expect(packPos, "pack must be after lint").toBeGreaterThan(lintPos);
    expect(packPos, "pack must be after typecheck").toBeGreaterThan(typecheckPos);
    expect(packPos, "pack must be after build").toBeGreaterThan(buildPos);
    expect(packPos, "pack must be after test").toBeGreaterThan(testPos);
  });

  it("uploads artifact via actions/upload-artifact with *.tgz glob", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("actions/upload-artifact");
    expect(content).toContain("*.tgz");
  });

  it("does not reference npm publish credentials", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).not.toContain("NPM_TOKEN");
    expect(content).not.toContain("npm publish");
    expect(content).not.toContain("NODE_AUTH_TOKEN");
  });

  it("has concurrency control", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("concurrency:");
  });

  it("sets if-no-files-found to error on artifact upload", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("if-no-files-found: error");
  });

  it("sets retention-days to 30 on artifact upload", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("retention-days: 30");
  });

  it("sets cancel-in-progress on concurrency", () => {
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("cancel-in-progress: true");
  });

  it("sanitizes ref name before using it as artifact name", () => {
    const content = readFileSync(workflowPath, "utf8");
    // Raw github.ref_name must not appear directly in the artifact name field —
    // slashes in branch names (e.g. feature/foo) cause upload-artifact to fail.
    expect(content).not.toContain("name: uncommitted-cli-${{ github.ref_name }}");
    // Sanitized value must be used instead
    expect(content).toContain("GITHUB_OUTPUT");
    expect(content).toContain("tr '/' '-'");
  });
});
