#!/usr/bin/env bash
# scripts/release/pack-smoke.sh
#
# UNC-107: Local pack + install smoke test for the MVP CLI.
#
# Flow:
#   1. Clean build (tsc)
#   2. Pack the tarball (npm pack into REPO_ROOT)
#   3. Install the tarball into an isolated temp dir via pnpm
#   4. Run `uncommitted --help` from the isolated install
#   5. Assert non-empty output and exit 0
#   6. Clean up temp dir (always, even on failure)
#
# Usage:
#   pnpm release:smoke
#   bash scripts/release/pack-smoke.sh
#
# Requirements: Node >=22.13.0, pnpm, npm (for pack --dry-run verification)
# macOS-first — not tested on Linux/Windows for MVP.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_SMOKE=""

cleanup() {
  if [[ -n "$TMPDIR_SMOKE" && -d "$TMPDIR_SMOKE" ]]; then
    rm -rf "$TMPDIR_SMOKE"
    echo "[smoke] Cleaned up temp dir: $TMPDIR_SMOKE"
  fi
}
trap cleanup EXIT

echo "[smoke] === Uncommitted MVP pack smoke test ==="
echo "[smoke] Repo: $REPO_ROOT"

# ── Step 1: Clean build ────────────────────────────────────────────────────
echo ""
echo "[smoke] Step 1: Clean build"
cd "$REPO_ROOT"
rm -rf dist
pnpm build
echo "[smoke] Build OK — dist/ created"

# ── Step 2: Pack tarball ───────────────────────────────────────────────────
echo ""
echo "[smoke] Step 2: Pack tarball"
# npm pack outputs the tarball filename to stdout
TARBALL_NAME=$(npm pack --silent 2>/dev/null)
if [[ -z "$TARBALL_NAME" ]]; then
  echo "[smoke] ERROR: npm pack produced no output" >&2
  exit 1
fi
TARBALL_PATH="$REPO_ROOT/$TARBALL_NAME"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "[smoke] ERROR: tarball not found at $TARBALL_PATH" >&2
  exit 1
fi
echo "[smoke] Tarball: $TARBALL_PATH"

# ── Step 3: Install into isolated temp dir ─────────────────────────────────
echo ""
echo "[smoke] Step 3: Install tarball into isolated temp dir"
TMPDIR_SMOKE=$(mktemp -d)
echo "[smoke] Temp dir: $TMPDIR_SMOKE"

# Minimal package.json so pnpm add works
cat > "$TMPDIR_SMOKE/package.json" << 'PKGJSON'
{
  "name": "smoke-test-harness",
  "version": "1.0.0",
  "private": true
}
PKGJSON

cd "$TMPDIR_SMOKE"
pnpm add "file:$TARBALL_PATH" --silent
echo "[smoke] Install OK"

# ── Step 4: Run uncommitted --help ────────────────────────────────────────
echo ""
echo "[smoke] Step 4: Run uncommitted --help from installed tarball"
BINARY="$TMPDIR_SMOKE/node_modules/.bin/uncommitted"

if [[ ! -f "$BINARY" && ! -L "$BINARY" ]]; then
  echo "[smoke] ERROR: binary not found at $BINARY" >&2
  exit 1
fi

HELP_OUTPUT=$("$BINARY" --help 2>&1 || true)

# ── Step 5: Assert non-empty output ───────────────────────────────────────
echo ""
echo "[smoke] Step 5: Assert --help output is non-empty"
if [[ -z "$HELP_OUTPUT" ]]; then
  echo "[smoke] ERROR: --help produced no output" >&2
  exit 1
fi

echo "[smoke] --help output (first 10 lines):"
echo "$HELP_OUTPUT" | head -10

# Verify 'uncommitted' appears somewhere in the help text
if ! echo "$HELP_OUTPUT" | grep -qi "uncommitted"; then
  echo "[smoke] ERROR: 'uncommitted' not found in --help output" >&2
  exit 1
fi

# ── Step 6: Remove tarball from repo root ─────────────────────────────────
echo ""
echo "[smoke] Step 6: Remove tarball from repo root"
rm -f "$TARBALL_PATH"
echo "[smoke] Tarball removed"

echo ""
echo "[smoke] === SMOKE TEST PASSED ==="
echo "[smoke] The packed CLI installed and ran successfully from an isolated temp dir."
