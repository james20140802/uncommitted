export type SecretCategory =
  | "vendor api tokens"
  | "high-entropy tokens"
  | "assignment secrets";

export const SECRET_CATEGORY_ORDER: SecretCategory[] = [
  "vendor api tokens",
  "high-entropy tokens",
  "assignment secrets"
];

export type SecretDetectionResult = {
  value: string;
  categories: SecretCategory[];
};

const PLACEHOLDER = "[redacted-secret]";

const VENDOR_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgho_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsk_live_[0-9a-zA-Z]{24,}\b/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{1,4096}\.eyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\b/g,
  // HTTP headers are case-insensitive and many tools log them lowercase
  // (e.g. "authorization: bearer <token>"), so match the header/scheme name
  // case-insensitively to catch non-JWT bearer tokens below the entropy cutoff.
  /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{1,4096}\b/gi
];

// Capture the key half and the (quoted or bare) value half. We replace just
// the value run; we keep the key + assignment operator intact so callers can
// still see "password=" or "api_key:" in the redacted text.
const ASSIGNMENT_PATTERN =
  /\b(password|api[_-]?key|secret|token|auth)(\s*[:=]\s*)(['"]?)([^\s'"]{6,4096})\3/gi;

const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9_\-/+=]{32,4096}/g;
const ENTROPY_THRESHOLD = 3.5;

export function detectSecrets(input: string): SecretDetectionResult {
  const fired = new Set<SecretCategory>();
  let value = input;

  // Layer 1: vendor signatures.
  for (const pattern of VENDOR_PATTERNS) {
    if (pattern.test(value)) {
      fired.add("vendor api tokens");
      pattern.lastIndex = 0;
      value = value.replace(pattern, PLACEHOLDER);
    }
  }

  // Layer 2: assignment heuristic — replace value half only.
  if (ASSIGNMENT_PATTERN.test(value)) {
    fired.add("assignment secrets");
    ASSIGNMENT_PATTERN.lastIndex = 0;
    value = value.replace(
      ASSIGNMENT_PATTERN,
      (_match, key: string, sep: string, quote: string, val: string) => {
        // Credit layer 3 too when the captured value would itself qualify
        // as a high-entropy token; layer 3 won't see it after replacement.
        if (looksLikeHighEntropyToken(val)) {
          fired.add("high-entropy tokens");
        }
        return `${key}${sep}${quote}${PLACEHOLDER}${quote}`;
      }
    );
  }

  // Layer 3: high-entropy sweep on what's left.
  value = value.replace(HIGH_ENTROPY_CANDIDATE, (token) => {
    if (!hasLetter(token) || !hasDigit(token)) {
      return token;
    }
    if (shannonEntropy(token) < ENTROPY_THRESHOLD) {
      return token;
    }
    fired.add("high-entropy tokens");
    return PLACEHOLDER;
  });

  return {
    value,
    categories: SECRET_CATEGORY_ORDER.filter((category) => fired.has(category))
  };
}

function looksLikeHighEntropyToken(s: string): boolean {
  if (s.length < 32) return false;
  if (!/^[A-Za-z0-9_\-/+=]+$/.test(s)) return false;
  if (!hasLetter(s) || !hasDigit(s)) return false;
  return shannonEntropy(s) >= ENTROPY_THRESHOLD;
}

function hasLetter(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

function hasDigit(s: string): boolean {
  return /[0-9]/.test(s);
}

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let h = 0;
  const len = s.length;
  for (const c of counts.values()) {
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return h;
}
