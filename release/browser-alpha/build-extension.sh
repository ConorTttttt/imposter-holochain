#!/usr/bin/env bash
# Apply only the non-instrumented compatibility patches to the pinned checkout.
set -euo pipefail
fail(){ echo "Browser alpha extension build: $*" >&2; exit 1; }
[[ $# == 1 ]] || fail 'supply the clean pinned HWC checkout path'
for tool in git jq node npm npx python3; do
  command -v "$tool" >/dev/null || fail "install $tool before building"
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail 'use Python 3.11 or later'
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
hwc=$(cd "$1" && pwd)
kit=$repo/compatibility/hwc-imposter-compatibility
pins="$repo/release/browser-alpha/pins.json"
pin=$(jq -er .hwc_commit "$pins")
node_version=$(jq -er .node_version "$pins")
test "$(node --version)" = "$node_version" || fail "use Node $node_version"
test "$(git -C "$hwc" rev-parse HEAD)" = "$pin" || fail 'wrong HWC commit'
test -z "$(git -C "$hwc" status --porcelain)" || fail 'use a clean pinned HWC checkout'
python3 "$kit/verify_pinned_sources.py" "$hwc"
git -C "$hwc" switch -c fix/imposter-hwc-compatibility
python3 "$kit/apply.py" "$hwc" --write
python3 "$kit/private-role/apply_restricted_hwc_handler.py" "$hwc" --write
python3 "$kit/private-role/apply_installed_hwc_receiver.py" "$hwc" --write
git -C "$hwc" diff --check
(
  cd "$hwc"
  npm ci
  npx --no-install tsc -p packages/shared/tsconfig.json
  npx --no-install tsc -p packages/lair/tsconfig.json
  npx --no-install tsc -p packages/core/tsconfig.json
  npx --no-install tsc --noEmit -p packages/extension/tsconfig.json
  npm run build:chrome --workspace @hwc/extension
)
