#!/usr/bin/env bash
# Integration runner for an AUTHORISED checkout of HWC at the pinned commit.
# Does not push or merge. Requires an existing branch with the exact name.
set -euo pipefail
ROOT="${1:-.}"
ROOT="$(cd "$ROOT" && pwd)"
BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="fix/imposter-hwc-compatibility"
PIN="0c391226e78769d44ccb4661881ed8998b15f903"
if [[ "$(git -C "$ROOT" rev-parse HEAD)" != "$PIN" ]]; then echo 'FAIL: wrong HWC revision' >&2; exit 1; fi
if [[ "$(git -C "$ROOT" branch --show-current)" != "$BRANCH" ]]; then echo 'FAIL: wrong branch' >&2; exit 1; fi
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then echo 'FAIL: dirty source checkout' >&2; exit 1; fi
python3 "$BUNDLE/verify_pinned_sources.py" "$ROOT"
python3 "$BUNDLE/apply.py" "$ROOT" --check
python3 "$BUNDLE/apply.py" "$ROOT" --patch "$ROOT/.git/imposter-hwc.patch"
python3 "$BUNDLE/apply.py" "$ROOT" --write
cd "$ROOT"
# Include the six newly created tests in the diff whitespace check.
git add -N \
  packages/core/src/ribosome/wasm-io-types.imposter.test.ts \
  packages/core/src/hash/system-entry.imposter.test.ts \
  packages/core/src/ribosome/host-fn/dna-info-imposter.test.ts \
  packages/core/src/dht/private-entry.imposter.test.ts \
  packages/core/src/storage/private-entry-persistence.imposter.test.ts \
  packages/core/src/storage/cell-isolation.imposter.test.ts \
  packages/core/src/dht/publish-upgrade.imposter.test.ts
git diff --check
# Record all stages; a failure never becomes a misleading PASS.
LOG="$(git rev-parse --git-dir)/imposter-integration.log"
: > "$LOG"
FAILED=0
run(){
  printf '\n### %s\n' "$*" | tee -a "$LOG"
  set +e
  "$@" 2>&1 | tee -a "$LOG"
  result=${PIPESTATUS[0]}
  set -e
  echo "EXIT CODE: $result" | tee -a "$LOG"
  if [[ $result -ne 0 ]]; then FAILED=1; fi
}
run npm ci
# Do not run misleading test commands without dependencies.
if [[ $FAILED -ne 0 ]]; then echo 'BLOCKED: dependency installation failed' | tee -a "$LOG"; exit 1; fi
# Build first because existing extension unit tests inspect generated browser bundles.
# Typecheck HWC runtime workspaces independently: the pinned standalone
# @holo-host/web-conductor-client's @holo-host/joining-service/client exports
# are unresolved in npm ci and fail the upstream root typecheck for reasons
# outside HWC core/extension; first two CI attempts preserve that exact error.
run npx tsc -p packages/shared/tsconfig.json
run npx tsc -p packages/lair/tsconfig.json
run npx tsc -p packages/core/tsconfig.json
run npx tsc --noEmit -p packages/extension/tsconfig.json
run npm run build:chrome --workspace @hwc/extension
run npm run build:firefox --workspace @hwc/extension
# HWC core/extension are the integration gates; @holo-host/web-conductor-client's
# pinned baseline has unresolved external @holo-host/joining-service/client imports.
run npm run test --workspace @hwc/core
run npm run test --workspace @hwc/extension
run npm run test:integration
run npm run test --workspace @hwc/core -- src/ribosome/wasm-io-types.imposter.test.ts src/hash/system-entry.imposter.test.ts src/storage/private-entry-persistence.imposter.test.ts src/storage/cell-isolation.imposter.test.ts src/dht/private-entry.imposter.test.ts src/dht/publish-upgrade.imposter.test.ts src/ribosome/host-fn/dna-info-imposter.test.ts
run npm run test --workspace @holo-host/lair
run npm run test --workspace @hwc/shared
if [[ $FAILED -ne 0 ]]; then echo 'FAIL: one or more integration steps failed' | tee -a "$LOG"; exit 1; fi
echo 'PASS: HWC package checks completed. Real Imposter WASM and multi-browser security tests remain separate release gates.' | tee -a "$LOG"
