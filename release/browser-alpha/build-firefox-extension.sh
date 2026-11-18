#!/usr/bin/env bash
# Build the desktop development add-on in a clean, isolated HWC checkout.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "Usage: $0 HWC_CHECKOUT NEW_OUTPUT_DIRECTORY" >&2
  exit 2
fi

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
hwc=$(cd "$1" && pwd)
out=$(realpath -m "$2")
release=$repo/release/browser-alpha
kit=$repo/compatibility/hwc-imposter-compatibility
export PYTHONDONTWRITEBYTECODE=1

test ! -e "$out"
test "$hwc" = "$(git -C "$hwc" rev-parse --show-toplevel)"
test "$(git -C "$hwc" rev-parse HEAD)" = "$(jq -er .hwc_commit "$release/pins.json")"
test -z "$(git -C "$hwc" status --porcelain)"
test "$(node --version)" = "$(jq -er .node_version "$release/pins.json")"

python3 "$kit/verify_pinned_sources.py" "$hwc"
if [[ $(git -C "$hwc" branch --show-current) != fix/imposter-hwc-compatibility ]]; then
  git -C "$hwc" switch -c fix/imposter-hwc-compatibility
fi
python3 "$kit/apply.py" "$hwc" --write
python3 "$kit/private-role/apply_restricted_hwc_handler.py" "$hwc" --write
python3 "$kit/private-role/apply_installed_hwc_receiver.py" "$hwc" --write
git -C "$hwc" apply --check "$kit/private-role/firefox-desktop.patch"
git -C "$hwc" apply "$kit/private-role/firefox-desktop.patch"
git -C "$hwc" diff --check

(
  cd "$hwc"
  npm ci
  npx --no-install tsc -p packages/shared/tsconfig.json
  npx --no-install tsc -p packages/lair/tsconfig.json
  npx --no-install tsc -p packages/core/tsconfig.json
  npx --no-install tsc --noEmit -p packages/extension/tsconfig.json
  npm run build:firefox --workspace @hwc/extension
)
python3 "$release/package-firefox.py" build "$hwc/packages/extension/dist-firefox" "$out"
