import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivitySignal } from "./event-source.js";
import type { OwnAuthoredBody } from "./github-event-normalizer.js";

export type GitHubWriteInput = {
  projectRoot: string;
  targetDate: string;
  signals: ActivitySignal[];
  ownAuthoredBodies: OwnAuthoredBody[];
};

export type GitHubWriteResult = {
  signalsFile: string;
  rawArchiveFile: string;
  signalCount: number;
  rawCount: number;
};

async function atomicWrite(path: string, body: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(
    tmp,
    body,
    mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode }
  );
  await rename(tmp, path);
  // chmod after rename ensures the mode invariant survives even when overwriting an existing file
  // (the mode option on writeFile only applies when creating a new file).
  if (mode !== undefined) await chmod(path, mode);
}

export async function writeGitHubEvents(input: GitHubWriteInput): Promise<GitHubWriteResult> {
  const baseDir = join(input.projectRoot, ".uncommitted", "events", "github");
  const rawDir = join(baseDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const signalsFile = join(baseDir, `${input.targetDate}.jsonl`);
  const rawArchiveFile = join(rawDir, `${input.targetDate}.jsonl`);

  const signalsBody = input.signals.length
    ? input.signals.map((s) => JSON.stringify(s)).join("\n") + "\n"
    : "";
  const rawBody = input.ownAuthoredBodies.length
    ? input.ownAuthoredBodies.map((b) => JSON.stringify(b)).join("\n") + "\n"
    : "";

  // Write the raw archive first so the canonical signal file is only replaced
  // after the raw write (and its chmod) succeed. Otherwise a raw-write failure
  // could overwrite a previous good signal file while leaving a stale/missing
  // raw archive, breaking the failure contract for disk/permission errors.
  await atomicWrite(rawArchiveFile, rawBody, 0o600);
  await atomicWrite(signalsFile, signalsBody);

  return {
    signalsFile,
    rawArchiveFile,
    signalCount: input.signals.length,
    rawCount: input.ownAuthoredBodies.length
  };
}
