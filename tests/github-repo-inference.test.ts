import { describe, it, expect } from "vitest";
import { inferGitHubOriginRepo } from "../src/github-repo-inference.js";

describe("inferGitHubOriginRepo", () => {
  it("parses https github remote", () => {
    const r = inferGitHubOriginRepo("https://github.com/james20140802/uncommitted.git");
    expect(r).toEqual({ host: "github.com", owner: "james20140802", repo: "uncommitted", isGitHub: true });
  });

  it("parses ssh github remote", () => {
    const r = inferGitHubOriginRepo("git@github.com:james20140802/uncommitted.git");
    expect(r).toEqual({ host: "github.com", owner: "james20140802", repo: "uncommitted", isGitHub: true });
  });

  it("parses remote without .git suffix", () => {
    const r = inferGitHubOriginRepo("https://github.com/foo/bar");
    expect(r).toEqual({ host: "github.com", owner: "foo", repo: "bar", isGitHub: true });
  });

  it("returns isGitHub=false for non-github hosts (graceful skip)", () => {
    const r = inferGitHubOriginRepo("git@gitlab.com:foo/bar.git");
    expect(r.isGitHub).toBe(false);
    expect(r.host).toBe("gitlab.com");
  });

  it("returns isGitHub=false for empty / unparseable remotes", () => {
    expect(inferGitHubOriginRepo("")).toEqual({ host: null, owner: null, repo: null, isGitHub: false });
    expect(inferGitHubOriginRepo("not-a-url")).toEqual({ host: null, owner: null, repo: null, isGitHub: false });
  });
});
