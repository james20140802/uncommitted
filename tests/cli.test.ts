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

describe("cli", () => {
  it("prints help", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["--", "--help"], io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: uncommitted <command>");
    expect(stdout.join("\n")).toContain("init");
    expect(stdout.join("\n")).toContain("generate");
  });

  it("routes known commands to placeholder handlers", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["init"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Command not implemented yet: init");
  });

  it("reports unknown commands", async () => {
    const { io, stdout, stderr } = createIo();

    const exitCode = await runCli(["nope"], io);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown command: nope");
    expect(stderr.join("\n")).toContain("Run `uncommitted --help`.");
  });
});
