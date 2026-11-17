#!/usr/bin/env bash
# Check fixture/packaging consistency; recompute real DNA hash if hc is available.
# This is NOT an HWC installation, genesis, runtime seed or signature test.
set -euo pipefail
[[ $# == 1 ]] || { echo 'usage: browser-poc-verify.sh target/browser-poc/<tag>' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR=$(cd "$1" && pwd) || { echo 'artifact directory missing' >&2; exit 1; }
LIB="$ROOT/scripts/browser-poc-lib.mjs"
node "$LIB" verify "$DIR"
if command -v hc >/dev/null 2>&1; then
  HASH_OUTPUT=$(hc dna hash "$DIR/dna/game.dna")
  GOT=$(printf '%s\n' "$HASH_OUTPUT" | node "$LIB" parse-hash)
  WANT=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1])).dna_hash)" "$DIR/deployment.json")
  [[ "$GOT" == "$WANT" ]] || { echo "hc DNA hash mismatch: $GOT != $WANT" >&2; exit 1; }
  echo 'hc DNA hash recomputation: PASS'
else
  echo 'hc unavailable: real DNA hash recomputation NOT RUN' >&2
fi
