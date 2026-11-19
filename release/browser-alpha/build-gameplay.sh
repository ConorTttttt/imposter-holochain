#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: build-gameplay.sh <pinned-game-checkout> <new-output-dir>' >&2
  exit 2
fi
rc=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$rc" rev-parse --show-toplevel)
game=$(cd "$1" && pwd)
output=$(realpath -m "$2")
test "$(git -C "$game" rev-parse HEAD)" = "$(jq -er .game_commit "$rc/pins.json")"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/ui"
git -C "$game" show HEAD:ui/browser-demo.html > "$scratch/ui/browser-demo.html"
(cd "$scratch" && git apply --unidiff-zero "$repo/ci/installed-role/browser-demo.patch")
mkdir "$output"
node "$rc/build-gameplay-page.mjs" "$scratch/ui/browser-demo.html" "$output/browser-demo.html"
"$repo/ui/node_modules/.bin/esbuild" "$repo/ui/src/browser/movement-relay.ts" \
  --bundle --platform=node --target=node22 --external:bufferutil --external:utf-8-validate \
  --log-level=warning --outfile="$output/movement-relay.cjs"
(cd "$output" && sha256sum browser-demo.html movement-relay.cjs > SHA256SUMS)
