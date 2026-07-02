/**
 * Pure classifier for HTTP 429 response bodies from OpenAI-compatible /
 * Anthropic providers.
 *
 * A 429 can mean either a temporary rate limit ("slow down, retry later") or
 * billing/quota exhaustion ("out of credit, waiting will not help"). The latter
 * must NOT be surfaced as a temporary rate-limit message, which previously
 * misled diagnosis.
 *
 * This module owns the billing-key set and the shared English billing message.
 * Call sites keep their own verbatim generic rate-limit message.
 */

export type Provider429Classification = "billing" | "generic";

/**
 * Provider `error.type` / `error.code` values that indicate billing/quota
 * exhaustion rather than a temporary rate limit.
 */
const BILLING_429_KEYS: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached"
]);

/**
 * Shared, user-facing message for billing-class 429 responses. Names a
 * credit/billing-quota cause and deliberately avoids implying "just wait and
 * retry". Contains no raw provider internals, secrets, or tokens.
 */
export const BILLING_429_MESSAGE =
  "AI provider credit/billing quota exhausted. Check your plan and billing details.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a 429 response body as billing-class vs generic rate-limit.
 *
 * Matches billing if EITHER `error.type` OR `error.code` is in the billing key
 * set. Any parse failure, missing/non-object error, or unrecognized type & code
 * safely falls back to "generic".
 */
export function classify429ResponseBody(
  body: unknown
): Provider429Classification {
  if (!isRecord(body) || !isRecord(body.error)) {
    return "generic";
  }

  const { type, code } = body.error;

  if (typeof type === "string" && BILLING_429_KEYS.has(type)) {
    return "billing";
  }

  if (typeof code === "string" && BILLING_429_KEYS.has(code)) {
    return "billing";
  }

  return "generic";
}
