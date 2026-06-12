import { describe, it, expect } from "vitest";
import { attributeCwdToProject } from "../src/claude-session-attribution.js";
import type { ProjectRecord } from "../src/project-registry.js";

const sample = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  schemaVersion: 1,
  id: "p1",
  name: "uncommitted",
  root: "/Users/alice/Developer/uncommitted",
  gitRoot: "/Users/alice/Developer/uncommitted",
  enabled: true,
  createdAt: "2026-06-13T00:00:00.000Z",
  ...overrides
});

describe("attributeCwdToProject", () => {
  it("matches exact cwd to project root", () => {
    const projects = [sample()];
    const result = attributeCwdToProject(
      "/Users/alice/Developer/uncommitted",
      projects
    );
    expect(result).toEqual({
      projectId: "p1",
      projectName: "uncommitted",
      matchedCwd: "/Users/alice/Developer/uncommitted"
    });
  });

  it("matches cwd nested inside project root", () => {
    const projects = [sample()];
    const result = attributeCwdToProject(
      "/Users/alice/Developer/uncommitted/src/cli.ts",
      projects
    );
    expect(result?.projectId).toBe("p1");
  });

  it("returns null when no project root matches", () => {
    const projects = [sample()];
    const result = attributeCwdToProject(
      "/Users/alice/Developer/other-repo",
      projects
    );
    expect(result).toBeNull();
  });

  it("does not match a sibling prefix (uncommitted vs uncommitted-foo)", () => {
    const projects = [sample()];
    const result = attributeCwdToProject(
      "/Users/alice/Developer/uncommitted-foo",
      projects
    );
    expect(result).toBeNull();
  });

  it("returns the first matching project in input order", () => {
    const projects = [
      sample({ id: "p1", root: "/Users/alice/Developer/uncommitted" }),
      sample({ id: "p2", root: "/Users/alice/Developer/uncommitted" })
    ];
    const result = attributeCwdToProject(
      "/Users/alice/Developer/uncommitted",
      projects
    );
    expect(result?.projectId).toBe("p1");
  });
});
