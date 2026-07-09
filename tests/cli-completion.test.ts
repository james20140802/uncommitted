import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

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

describe("cli completion command", () => {
  it("prints the zsh script to stdout", async () => {
    const { io, stdout } = createIo();
    const exitCode = await runCli(["completion", "zsh"], io);

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("#compdef uncommitted");
  });

  it("prints the bash script to stdout", async () => {
    const { io, stdout } = createIo();
    const exitCode = await runCli(["completion", "bash"], io);

    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("complete");
    expect(out).toContain("uncommitted");
  });

  it("writes the install hint to stderr, keeping stdout script-only", async () => {
    const { io, stdout, stderr } = createIo();
    const exitCode = await runCli(["completion", "zsh"], io);

    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    const err = stderr.join("\n");
    // Hint belongs on stderr so `uncommitted completion zsh > _uncommitted`
    // captures only the script.
    expect(err).toContain("uncommitted completion zsh");
    expect(out).not.toContain("~/.zsh/completions");
    expect(out).not.toContain("uncommitted completion zsh >");
  });

  it("requires a shell argument", async () => {
    const { io, stderr } = createIo();
    const exitCode = await runCli(["completion"], io);

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain(
      "Usage: uncommitted completion <zsh|bash>"
    );
  });

  it("rejects an unsupported shell", async () => {
    const { io, stderr } = createIo();
    const exitCode = await runCli(["completion", "fish"], io);

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("Usage: uncommitted completion");
  });

  it("appears in the registry-driven help text", async () => {
    const { io, stdout } = createIo();
    const exitCode = await runCli(["--", "--help"], io);

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("completion");
  });
});
