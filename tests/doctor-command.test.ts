import { constants } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDoctorReport,
  formatDoctorReport,
  getDoctorExitCode
} from "../src/doctor-command.js";

describe("doctor command", () => {
  it("creates a passing environment report", async () => {
    const homeDir = await createHomeWithConfig({
      aiProvider: "openai",
      draftRoot: "~/Uncommitted/drafts"
    });

    const report = await createDoctorReport({
      homeDir,
      env: { OPENAI_API_KEY: "test-key" },
      nodeVersion: "v22.13.0",
      checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" })
    });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config", status: "pass" }),
        expect.objectContaining({ id: "node", status: "pass" }),
        expect.objectContaining({ id: "git", status: "pass" }),
        expect.objectContaining({ id: "ai-api-key", status: "pass" })
      ])
    );
    expect(getDoctorExitCode(report)).toBe(0);
    expect(formatDoctorReport(report)).toContain("[pass] Git");
  });

  it("reports missing config as a config error", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-doctor-missing-config-"));

    const report = await createDoctorReport({
      homeDir,
      env: {},
      nodeVersion: "v22.13.0",
      checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" })
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "config",
        status: "fail",
        message: expect.stringContaining("Config file is missing")
      })
    );
    expect(getDoctorExitCode(report)).toBe(2);
  });

  it("reports missing Git as a blocking failure", async () => {
    const homeDir = await createHomeWithConfig();

    const report = await createDoctorReport({
      homeDir,
      env: {},
      nodeVersion: "v22.13.0",
      checkCommand: async () => ({ ok: false, detail: "git was not found" })
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "git",
        status: "fail",
        message: "Git is not installed or not available on PATH."
      })
    );
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("reports missing AI API keys as warning-level", async () => {
    const homeDir = await createHomeWithConfig({
      aiProvider: "anthropic",
      draftRoot: "~/Uncommitted/drafts"
    });

    const report = await createDoctorReport({
      homeDir,
      env: {},
      nodeVersion: "v22.13.0",
      checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" })
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "ai-api-key",
        status: "warn",
        message: "ANTHROPIC_API_KEY is not set."
      })
    );
    expect(getDoctorExitCode(report)).toBe(0);
  });

  it("fails when the configured AI provider is unsupported", async () => {
    const homeDir = await createHomeWithConfig({
      aiProvider: "typo-provider",
      draftRoot: "~/Uncommitted/drafts"
    });

    const report = await createDoctorReport({
      homeDir,
      env: {},
      nodeVersion: "v22.13.0",
      checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" })
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "ai-api-key",
        status: "fail",
        message: "Unsupported AI provider: typo-provider."
      })
    );
    expect(getDoctorExitCode(report)).toBe(2);
  });

  it("fails when a required directory is not writable", async () => {
    const homeDir = await createHomeWithConfig();
    const blockedDirectory = join(homeDir, ".uncommitted", "logs");

    const report = await createDoctorReport({
      homeDir,
      env: {},
      nodeVersion: "v22.13.0",
      checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" }),
      checkAccess: async (path, mode) => {
        if (path === blockedDirectory && mode === constants.W_OK) {
          return false;
        }

        return true;
      }
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "directory-logs",
        status: "fail",
        message: expect.stringContaining("Directory is not writable")
      })
    );
    expect(getDoctorExitCode(report)).toBe(1);
  });

  it("fails when Node.js is below the supported version", async () => {
    const homeDir = await createHomeWithConfig();

    const report = await createDoctorReport({
      homeDir,
      env: {},
      nodeVersion: "v22.12.0",
      checkCommand: async () => ({ ok: true, detail: "git version 2.49.0" })
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "node",
        status: "fail",
        message: "Node.js v22.13.0 or newer is required."
      })
    );
    expect(getDoctorExitCode(report)).toBe(1);
  });
});

async function createHomeWithConfig(
  overrides: Partial<{ aiProvider: string; draftRoot: string }> = {}
): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-doctor-"));
  const configDir = join(homeDir, ".uncommitted");
  const draftRoot = join(homeDir, "Uncommitted", "drafts");

  await mkdir(join(configDir, "history"), { recursive: true });
  await mkdir(join(configDir, "drafts"), { recursive: true });
  await mkdir(join(configDir, "logs"), { recursive: true });
  await mkdir(draftRoot, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      draftRoot: overrides.draftRoot ?? draftRoot,
      scheduleTime: "23:30",
      aiProvider: overrides.aiProvider ?? "none",
      persona: "wry coworker",
      roastLevel: 2
    })}\n`,
    "utf8"
  );

  return homeDir;
}
