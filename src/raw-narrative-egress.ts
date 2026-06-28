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
 * Final pre-egress secret re-validation for the raw conversation turns that
 * are about to leave the machine for the external caption-writer LLM. This is
 * the only point where raw narrative text egresses, so we re-validate every
 * selected turn aggressively and over-redact on purpose.
 *
 * For each turn we run {@link detectSecrets}. If any signature fires
 * (`categories.length > 0`) OR the detector mutated the text at all
 * (`value !== turn.text`) the ENTIRE turn is dropped — we do not attempt to
 * salvage the redacted value, because a turn that trips any signature is
 * terminal. The `value !== text` check is belt-and-suspenders: it removes this
 * gate's dependency on the detector's implicit "mutate ⟹ category" invariant,
 * so a future detector that ever redacts without firing a category still cannot
 * leak here. Clean turns are kept UNCHANGED (same object reference and text),
 * preserving input order. Dropped turns are counted toward `droppedTurns` and
 * their token estimates summed into `droppedTokens` so callers (T4) can fold
 * them into the final projection counters.
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
    if (categories.length > 0 || value !== turn.text) {
      droppedTurns += 1;
      droppedTokens += tokenCounter.estimate(turn.text);
      continue;
    }
    kept.push(turn);
  }

  return { kept, droppedTurns, droppedTokens };
}
