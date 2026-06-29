import { detectSecrets } from "./credential-detector.js";
import {
  defaultTokenCounter,
  type NarrativeTurn,
  type TokenCounter
} from "./raw-narrative-projection.js";

export type EgressRevalidationResult = {
  kept: NarrativeTurn[];
  droppedTurns: number;
  droppedTokens: number;
};

/**
 * Egress safety filter for the raw conversation turns that are about to leave
 * the machine for the external caption-writer LLM. The pipeline applies this
 * BEFORE selection/assembly (which only subset turns, never add or mutate
 * text), so no unsafe text can reach the provider. We over-redact on purpose.
 *
 * A turn is DROPPED ENTIRELY (never salvaged) when any of:
 *   - {@link detectSecrets} fires a signature (`categories.length > 0`), or
 *   - the detector mutated the text at all (`value !== turn.text`), or
 *   - the turn carries a raw code / tool marker (`hasCodeOrToolMarker`).
 *
 * The first two are the secret gate; the `value !== text` check is
 * belt-and-suspenders so a future detector that redacts without firing a
 * category still cannot leak. The third enforces the project rule "do not send
 * raw code/diffs to AI providers": plain code that trips no secret signature
 * (e.g. `function renderCard() { ... }`, an unbackticked `import ...`) must not
 * egress either (UNC-156 review). Clean prose turns are kept UNCHANGED (same
 * object reference and text), preserving input order. Dropped turns are counted
 * toward `droppedTurns` and their token estimates summed into `droppedTokens` so
 * callers can fold them into the final projection counters.
 */
export function revalidateTurnsForEgress(
  turns: NarrativeTurn[],
  tokenCounter: TokenCounter = defaultTokenCounter
): EgressRevalidationResult {
  const kept: NarrativeTurn[] = [];
  let droppedTurns = 0;
  let droppedTokens = 0;

  for (const turn of turns) {
    const { categories, value } = detectSecrets(turn.text);
    if (
      categories.length > 0 ||
      value !== turn.text ||
      turn.hasCodeOrToolMarker
    ) {
      droppedTurns += 1;
      droppedTokens += tokenCounter.estimate(turn.text);
      continue;
    }
    kept.push(turn);
  }

  return { kept, droppedTurns, droppedTokens };
}
