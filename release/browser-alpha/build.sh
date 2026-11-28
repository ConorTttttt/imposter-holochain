#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 6 ]]; then
  echo 'Usage: build.sh <pinned-game-checkout> <pinned-HWC-checkout> <host-public-key> <seed> <pinned-gateway> <new-output-dir>' >&2
  exit 2
fi
rc=$(cd "$(dirname "$0")" && pwd)
fail(){ echo "Browser alpha build: $*" >&2; exit 1; }
for tool in git jq node npm npx nix python3 realpath sha256sum; do
  command -v "$tool" >/dev/null || fail "install $tool before building"
done
repo=$(git -C "$rc" rev-parse --show-toplevel)
game=$(cd "$1" && pwd)
hwc=$(cd "$2" && pwd)
host=$3
seed=$4
gateway=$(realpath "$5")
output=$(realpath -m "$6")
[[ ! -e "$output" && ! -L "$output" && -d "$(dirname "$output")" ]] ||
  fail 'use a new output directory under an existing parent'
test -z "$(git -C "$repo" status --porcelain --untracked-files=no)" || fail 'commit release source changes first'
test -z "$(git -C "$game" status --porcelain)" || fail 'use a clean pinned game checkout'
test "$(git -C "$game" rev-parse HEAD)" = "$(jq -er .game_commit "$rc/pins.json")" || fail 'wrong game commit'
test "$(git -C "$hwc" rev-parse HEAD)" = "$(jq -er .hwc_commit "$rc/pins.json")" || fail 'wrong HWC commit'
node_version=$(jq -er .node_version "$rc/pins.json")
test "$(node --version)" = "$node_version" || fail "use Node $node_version"
[[ "$seed" == "g1.$host."* ]] || fail 'the seed must bind the supplied public host key'
test -f "$gateway" || fail 'the accepted gateway executable is missing'
node "$game/scripts/browser-poc-lib.mjs" validate-seed "$seed"
printf '%s  %s\n' "$(jq -er .gateway.sha256 "$rc/pins.json")" "$gateway" | sha256sum --check

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git init --quiet "$scratch/hwc"
git -C "$scratch/hwc" fetch --quiet --depth=1 "$hwc" "$(jq -er .hwc_commit "$rc/pins.json")"
git -C "$scratch/hwc" switch --detach FETCH_HEAD
bash "$rc/build-extension.sh" "$scratch/hwc"
git init --quiet "$scratch/game"
git -C "$scratch/game" fetch --quiet "$game" "$(jq -er .game_commit "$rc/pins.json")"
git -C "$scratch/game" switch --detach FETCH_HEAD
game=$scratch/game
git -C "$game" apply --check "$rc/native-repeatable.patch"
git -C "$game" apply "$rc/native-repeatable.patch"
git -C "$game" apply "$rc/native-unified.patch"
source_epoch=$(git -C "$game" show -s --format=%ct HEAD)
native_identity=UNVERIFIED_OPERATOR_INPUT
package_identity=OPERATOR_SUPPLIED_PUBLIC_INPUT
if [[ ${BROWSER_ALPHA_CI_PROFILE:-} == 1 ]]; then
  test "${CI:-}" = true
  native_identity=EPHEMERAL_HWC_BROWSER_PROFILE
  package_identity=EPHEMERAL_CI_ONLY
fi
(
  cd "$game"
  export SOURCE_DATE_EPOCH=$source_epoch
  export BROWSER_POC_IDENTITY_SOURCE=$native_identity
  nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file --command bash scripts/browser-poc-build.sh "$seed"
)
tag=$(printf %s "$seed" | sha256sum | cut -c1-16)
native="$game/target/browser-poc/$tag"
(
  cd "$game"
  nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file --command bash -euc '
    command -v hc >/dev/null
    bash scripts/browser-poc-verify.sh "$1"
  ' verify-native "$native"
)
(
  cd "$scratch/hwc"
  npx --no-install esbuild packages/core/src/bundle/unpacker.ts --bundle --platform=node --format=cjs --outfile="$scratch/unpacker.cjs"
)
node "$rc/verify-native.mjs" "$scratch/unpacker.cjs" "$native/app/imposter-browser-poc.happ" "$native/dna/game.dna" "$native/deployment.json"
git init --quiet "$scratch/firefox"
git -C "$scratch/firefox" fetch --quiet --depth=1 "$hwc" "$(jq -er .hwc_commit "$rc/pins.json")"
git -C "$scratch/firefox" switch --detach FETCH_HEAD
bash "$rc/build-firefox-extension.sh" "$scratch/firefox" "$scratch/firefox-package"
npm --prefix "$repo/ui" ci
node "$rc/build-gameplay-page.mjs" "$rc/frontend/browser-demo.html" "$scratch/browser-demo.html"
"$repo/ui/node_modules/.bin/esbuild" "$repo/ui/src/browser/movement-relay.ts" --bundle --platform=node \
  --target=node22 --format=esm --external:bufferutil --external:utf-8-validate \
  --banner:js="import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" \
  --outfile="$scratch/movement-relay.mjs"
python3 "$rc/package.py" assemble "$output" --native "$native" \
  --extension "$scratch/hwc/packages/extension/dist-chrome" --gateway "$gateway" \
  --relay "$scratch/movement-relay.mjs" --firefox "$scratch/firefox-package/firefox-desktop-hwc.zip" \
  --demo "$scratch/browser-demo.html" --release-commit "$(git -C "$repo" rev-parse HEAD)" \
  --identity "$package_identity" \
  --node-version "$(node --version)" --npm-version "$(npm --version)"
