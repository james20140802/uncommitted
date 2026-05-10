import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DraftStorageErrorCode = "inspect-failed" | "write-failed" | "invalid-pointer";

export class DraftStorageError extends Error {
  constructor(
    message: string,
    public readonly code: DraftStorageErrorCode
  ) {
    super(message);
    this.name = "DraftStorageError";
  }
}

export type DraftRevision = {
  targetDate: string;
  revision: string;
  dateDir: string;
  outputDir: string;
  latestPointerPath: string;
  dateLatestPointerPath: string;
};

export type LatestDraftPointer = {
  schemaVersion: 1;
  targetDate: string;
  revision: string;
  path: string;
  updatedAt: string;
};

export type TextDraftRevisionInput = {
  draftRoot: string;
  targetDate: string;
  generatedAt: string;
  activitySummary: unknown;
  story: unknown;
  caption: string;
  metadata: unknown;
};

export type TextDraftWriteResult = DraftRevision & {
  files: string[];
};

const textDraftFiles = [
  "activity-summary.json",
  "story.json",
  "caption.txt",
  "metadata.json"
];

export async function writeTextDraftRevision(
  input: TextDraftRevisionInput
): Promise<TextDraftWriteResult> {
  const revision = await createDraftRevision({
    draftRoot: input.draftRoot,
    targetDate: input.targetDate
  });

  await writeDraftArtifactJson(
    revision,
    "activity-summary.json",
    input.activitySummary
  );
  await writeDraftArtifactJson(revision, "story.json", input.story);
  await writeDraftArtifactText(revision, "caption.txt", input.caption);
  await writeDraftArtifactJson(revision, "metadata.json", input.metadata);
  await writeLatestDraftPointer(revision, input.generatedAt);

  return {
    ...revision,
    files: [...textDraftFiles]
  };
}

export async function createDraftRevision(options: {
  draftRoot: string;
  targetDate: string;
}): Promise<DraftRevision> {
  const dateDir = join(options.draftRoot, options.targetDate);
  const revision = await allocateNextRevision(dateDir);
  const outputDir = join(dateDir, revision);

  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }

  return {
    targetDate: options.targetDate,
    revision,
    dateDir,
    outputDir,
    latestPointerPath: join(options.draftRoot, "latest.json"),
    dateLatestPointerPath: join(dateDir, "latest.json")
  };
}

export async function writeDraftArtifactJson(
  revision: DraftRevision,
  filename: string,
  value: unknown
): Promise<void> {
  await writeDraftArtifactText(
    revision,
    filename,
    `${JSON.stringify(value, null, 2)}\n`
  );
}

export async function writeDraftArtifactText(
  revision: DraftRevision,
  filename: string,
  value: string
): Promise<void> {
  try {
    await writeFile(join(revision.outputDir, filename), value, "utf8");
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }
}

export async function writeLatestDraftPointer(
  revision: DraftRevision,
  updatedAt: string
): Promise<LatestDraftPointer> {
  const pointer: LatestDraftPointer = {
    schemaVersion: 1,
    targetDate: revision.targetDate,
    revision: revision.revision,
    path: revision.outputDir,
    updatedAt
  };

  await writeDraftPointer(revision.latestPointerPath, pointer);
  await writeDraftPointer(revision.dateLatestPointerPath, pointer);

  return pointer;
}

export async function readLatestDraftPointer(
  draftRoot: string
): Promise<LatestDraftPointer> {
  try {
    const parsed = JSON.parse(
      await readFile(join(draftRoot, "latest.json"), "utf8")
    ) as unknown;

    if (isLatestDraftPointer(parsed)) {
      return parsed;
    }
  } catch (error) {
    if (isNodeError(error) && error.code !== "ENOENT") {
      throw new DraftStorageError(
        "Latest draft pointer is invalid.",
        "invalid-pointer"
      );
    }
  }

  throw new DraftStorageError("Latest draft pointer is missing.", "invalid-pointer");
}

async function allocateNextRevision(dateDir: string): Promise<string> {
  let entries: string[];

  try {
    entries = await readdir(dateDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return formatRevision(1);
    }

    throw new DraftStorageError(
      "Could not inspect draft revisions.",
      "inspect-failed"
    );
  }

  const highestRevision = entries.reduce((highest, entry) => {
    const match = /^rev-(\d{3})$/.exec(entry);

    if (!match) {
      return highest;
    }

    return Math.max(highest, Number(match[1]));
  }, 0);

  return formatRevision(highestRevision + 1);
}

async function writeDraftPointer(
  path: string,
  pointer: LatestDraftPointer
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  } catch {
    throw new DraftStorageError("Could not write draft files.", "write-failed");
  }
}

function formatRevision(value: number): string {
  return `rev-${String(value).padStart(3, "0")}`;
}

function isLatestDraftPointer(value: unknown): value is LatestDraftPointer {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.targetDate === "string" &&
    typeof value.revision === "string" &&
    /^rev-\d{3}$/.test(value.revision) &&
    typeof value.path === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
