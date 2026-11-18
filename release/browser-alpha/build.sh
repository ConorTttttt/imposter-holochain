#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 6 ]]; then
  echo 'Usage: build.sh <pinned-game-checkout> <pinned-HWC-checkout> <host-public-key> <seed> <pinned-gateway> <new-output-dir>' >&2
  exit 2
fi
rc=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$rc" rev-parse --show-toplevel)
game=$(cd "$1" && pwd)
hwc=$(cd "$2" && pwd)
host=$3
seed=$4
gateway=$(realpath "$5")
output=$(realpath -m "$6")
test ! -e "$output" && test ! -L "$output"
test -z "$(git -C "$repo" status --porcelain --untracked-files=no)"
test -z "$(git -C "$game" status --porcelain)"
test "$(git -C "$game" rev-parse HEAD)" = "$(jq -er .game_commit "$rc/pins.json")"
test "$(git -C "$hwc" rev-parse HEAD)" = "$(jq -er .hwc_commit "$rc/pins.json")"
[[ $(node --version) == v22.* ]]
[[ "$seed" == "g1.$host."* ]]
node "$game/scripts/browser-poc-lib.mjs" validate-seed "$seed"
printf '%s  %s\n' "$(jq -er .gateway.sha256 "$rc/pins.json")" "$gateway" | sha256sum --check

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git clone --quiet --no-checkout --no-hardlinks "$hwc" "$scratch/hwc"
git -C "$scratch/hwc" switch --detach "$(jq -er .hwc_commit "$rc/pins.json")"
bash "$rc/build-extension.sh" "$scratch/hwc"
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
  nix develop --no-write-lock-file --command bash scripts/browser-poc-build.sh "$seed"
)
tag=$(printf %s "$seed" | sha256sum | cut -c1-16)
native="$game/target/browser-poc/$tag"
(
  cd "$game"
  nix develop --no-write-lock-file --command bash -euc '
    command -v hc >/dev/null
    bash scripts/browser-poc-verify.sh "$1"
  ' verify-native "$native"
)
(
  cd "$scratch/hwc"
  npx --no-install esbuild packages/core/src/bundle/unpacker.ts --bundle --platform=node --format=cjs --outfile="$scratch/unpacker.cjs"
)
node "$rc/verify-native.mjs" "$scratch/unpacker.cjs" "$native/app/imposter-browser-poc.happ" "$native/dna/game.dna" "$native/deployment.json"
git -C "$game" show HEAD:ui/browser-demo.html > "$scratch/browser-demo.html"
# Apply the exact reviewed UI overlay in the scratch checkout layout.
mkdir "$scratch/ui"
mv "$scratch/browser-demo.html" "$scratch/ui/browser-demo.html"
(
  cd "$scratch"
  git apply --unidiff-zero "$repo/ci/installed-role/browser-demo.patch"
)
python3 "$rc/package.py" assemble "$output" --native "$native" \
  --extension "$scratch/hwc/packages/extension/dist-chrome" --gateway "$gateway" \
  --demo "$scratch/ui/browser-demo.html" --release-commit "$(git -C "$repo" rev-parse HEAD)" \
  --identity "$package_identity" \
  --node-version "$(node --version)" --npm-version "$(npm --version)"
