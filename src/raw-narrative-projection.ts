import { readFile } from "node:fs/promises";

export type NarrativeSource = "claude" | "codex" | "github";

export type NarrativeTurn = {
  source: NarrativeSource;
  text: string;
  timestamp: string; // ISO-8601; "" when none
  sessionId: string; // grouping key
  hasCodeOrToolMarker: boolean;
};

export type ProjectionTurn = {
  source: NarrativeSource;
  text: string;
  tokenEstimate: number;
};

export type RawNarrativeProjection = {
  turns: ProjectionTurn[];
  totalTokens: number;
  droppedTurns: number;
  droppedTokens: number;
  budget: number;
};

export interface TokenCounter {
  estimate(text: string): number;
}

export const defaultTokenCounter: TokenCounter = {
  estimate(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / 4);
  }
};

export const DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET = 4000;

export function emptyRawNarrativeProjection(
  budget: number
): RawNarrativeProjection {
  return {
    turns: [],
    totalTokens: 0,
    droppedTurns: 0,
    droppedTokens: 0,
    budget
  };
}

export function assembleRawNarrativeProjection(
  orderedTurns: NarrativeTurn[],
  options: { budget: number; tokenCounter?: TokenCounter }
): RawNarrativeProjection {
  const { budget } = options;
  const tokenCounter = options.tokenCounter ?? defaultTokenCounter;

  if (orderedTurns.length === 0 || budget <= 0) {
    return emptyRawNarrativeProjection(budget);
  }

  const turns: ProjectionTurn[] = [];
  let totalTokens = 0;
  let droppedTurns = 0;
  let droppedTokens = 0;

  for (const turn of orderedTurns) {
    const tokenEstimate = tokenCounter.estimate(turn.text);
    if (totalTokens + tokenEstimate <= budget) {
      turns.push({
        source: turn.source,
        text: turn.text,
        tokenEstimate
      });
      totalTokens += tokenEstimate;
    } else {
      droppedTurns += 1;
      droppedTokens += tokenEstimate;
    }
  }

  return {
    turns,
    totalTokens,
    droppedTurns,
    droppedTokens,
    budget
  };
}

export async function readCaptionProjectionTokenBudget(
  configFilePath: string
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(configFilePath, "utf8");
  } catch {
    return DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET;
  }
  const value = (parsed as Record<string, unknown>)
    .captionProjectionTokenBudget;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CAPTION_PROJECTION_TOKEN_BUDGET;
  }
  return Math.floor(value);
}
