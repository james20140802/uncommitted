import { describe, expect, it } from "vitest";
import { commands } from "../src/commands.js";
import {
  COMPLETION_SHELLS,
  completionInstallHint,
  generateCompletionScript,
  isCompletionShell
} from "../src/completion.js";

describe("generateCompletionScript zsh", () => {
  it("starts with the #compdef header", () => {
    const script = generateCompletionScript("zsh");
    expect(script.startsWith("#compdef uncommitted")).toBe(true);
  });

  it("lists every top-level command name from the registry", () => {
    const script = generateCompletionScript("zsh");
    for (const command of commands) {
      expect(script).toContain(command.name);
    }
  });

  it("offers project subcommands", () => {
    const script = generateCompletionScript("zsh");
    expect(script).toContain("add");
    expect(script).toContain("list");
    expect(script).toContain("remove");
  });

  it("offers schedule subcommands", () => {
    const script = generateCompletionScript("zsh");
    expect(script).toContain("install");
    expect(script).toContain("status");
    expect(script).toContain("remove");
    expect(script).toContain("run-now");
  });

  it("is derived from the passed command list, not hardcoded", () => {
    const script = generateCompletionScript("zsh", [
      { name: "zzznewcmd", summary: "x" }
    ]);
    expect(script).toContain("zzznewcmd");
  });
});

describe("generateCompletionScript bash", () => {
  it("lists every top-level command name from the registry", () => {
    const script = generateCompletionScript("bash");
    for (const command of commands) {
      expect(script).toContain(command.name);
    }
  });

  it("registers a completion function for uncommitted", () => {
    const script = generateCompletionScript("bash");
    expect(script).toContain("complete");
    expect(script).toContain("uncommitted");
    expect(/complete\s+-F\s+\S+\s+uncommitted/.test(script)).toBe(true);
  });

  it("is derived from the passed command list, not hardcoded", () => {
    const script = generateCompletionScript("bash", [
      { name: "zzznewcmd", summary: "x" }
    ]);
    expect(script).toContain("zzznewcmd");
  });
});

describe("isCompletionShell", () => {
  it("accepts zsh and bash", () => {
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("bash")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isCompletionShell("fish")).toBe(false);
    expect(isCompletionShell("")).toBe(false);
    expect(isCompletionShell("ZSH")).toBe(false);
  });
});

describe("COMPLETION_SHELLS", () => {
  it("is exactly zsh then bash", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["zsh", "bash"]);
  });
});

describe("completionInstallHint", () => {
  it("gives a zsh install hint", () => {
    const hint = completionInstallHint("zsh");
    expect(hint).toContain("uncommitted completion zsh");
  });

  it("gives a bash install hint", () => {
    const hint = completionInstallHint("bash");
    expect(hint).toContain("uncommitted completion bash");
  });
});
