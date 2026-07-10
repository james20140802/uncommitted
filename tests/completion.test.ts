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

  it("registers the completer under both fpath autoload and eval/source", () => {
    const script = generateCompletionScript("zsh");
    // fpath autoload path still relies on the compdef tag.
    expect(script.startsWith("#compdef uncommitted")).toBe(true);
    // eval/source path must bind the completer explicitly, since #compdef is
    // just a comment when the script is eval'd rather than autoloaded.
    expect(script).toContain("funcstack[1]");
    expect(script).toContain("compdef _uncommitted uncommitted");
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
  it("gives a zsh install hint using a user-writable completions dir", () => {
    const hint = completionInstallHint("zsh");
    expect(hint).toContain("uncommitted completion zsh");
    // Recommend a user-writable dir, not the often root-owned ${fpath[1]}.
    expect(hint).toContain("~/.zsh/completions");
    expect(hint).not.toContain("${fpath[1]}");
  });

  it("gives a bash install hint that works on macOS stock bash 3.2", () => {
    const hint = completionInstallHint("bash");
    expect(hint).toContain("uncommitted completion bash");
    // `source <(...)` process substitution fails on /bin/bash 3.2.57; the
    // primary one-liner must be the eval form.
    expect(hint).toContain('eval "$(uncommitted completion bash)"');
  });
});
