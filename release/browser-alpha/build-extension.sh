#!/usr/bin/env bash
# Apply only the non-instrumented compatibility patches to the pinned checkout.
set -euo pipefail
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
hwc=$(cd "$1" && pwd)
kit=$repo/compatibility/hwc-imposter-compatibility
pin=$(jq -er .hwc_commit "$repo/release/browser-alpha/pins.json")
test "$(git -C "$hwc" rev-parse HEAD)" = "$pin"
test -z "$(git -C "$hwc" status --porcelain)"
python3 "$kit/verify_pinned_sources.py" "$hwc"
git -C "$hwc" switch -c fix/imposter-hwc-compatibility
python3 "$kit/apply.py" "$hwc" --write
python3 "$kit/private-role/apply_restricted_hwc_handler.py" "$hwc" --write
python3 "$kit/private-role/apply_installed_hwc_receiver.py" "$hwc" --write
python3 "$kit/private-role/apply_browser_lobbies.py" "$hwc"
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
