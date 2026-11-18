#!/usr/bin/env bash
# P0 only: package the real Rust game and game_integrity zomes on a fixed DNA.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/scripts/browser-poc-lib.mjs"
PIN=111e6a44795e6572ed01191a98245ed723788c12
fail(){ echo "browser-poc-build: $*" >&2; exit 1; }
[[ $# == 1 ]] || fail 'usage: browser-poc-build.sh g1.<real-HWC-host-key>.<32-lowercase-hex>'
SEED=$1
command -v node >/dev/null 2>&1 || fail 'Node 22 missing'
node "$LIB" validate-seed "$SEED" || fail 'malformed host-bound seed'
# Retry within the committed Nix shell when Holochain is not already available.
if ! command -v hc >/dev/null 2>&1; then
  command -v nix >/dev/null 2>&1 || fail 'hc and nix unavailable; use pinned Nix shell'
  exec sh "$ROOT/scripts/in-nix.sh" bash "$ROOT/scripts/browser-poc-build.sh" "$SEED"
fi
for cmd in git npm cargo node sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing $cmd"
done
git -C "$ROOT" cat-file -e "$PIN^{commit}" || fail 'pinned commit missing'
git -C "$ROOT" merge-base --is-ancestor "$PIN" HEAD || fail 'not based on pinned commit'
# Allow only the reviewed coordinator role-authorization source to change;
# preserve pinned native integrity, DNA manifests and build dependencies.
INPUTS=(Cargo.toml Cargo.lock flake.nix flake.lock dnas/game scripts/in-nix.sh package.json
  ':(exclude)dnas/game/zomes/coordinator/game/src/lib.rs'
  ':(exclude)dnas/game/zomes/coordinator/game/src/recipient_keys.rs'
  ':(exclude)dnas/game/zomes/integrity/game_integrity/src/lib.rs'
  ':(exclude)dnas/game/zomes/integrity/game_integrity/src/recipient_keys.rs')
git -C "$ROOT" diff --quiet "$PIN" HEAD -- "${INPUTS[@]}" || fail 'pinned DNA/build dependencies changed; review first'
git -C "$ROOT" diff --quiet "$PIN" -- "${INPUTS[@]}" || fail 'working tree contains DNA/build source changes'
# Verify the legacy integrity rules are byte-identical to the original pin
# after removing ONLY the explicitly reviewed attestation glue.
python3 - "$PIN" "$ROOT" <<'PY'
from pathlib import Path
import subprocess, sys
pin, root = sys.argv[1:]
path = "dnas/game/zomes/integrity/game_integrity/src/lib.rs"
current = (Path(root) / path).read_text()
additions = [
    "mod recipient_keys;\npub use recipient_keys::*;\n",
    "    RecipientKeyAttestation(RecipientKeyAttestation),\n",
    "    RecipientKeyByAgent,\n",
    "            LinkTypes::RecipientKeyByAgent => validate_recipient_key_link(&action),\n",
    "        EntryTypes::RecipientKeyAttestation(a) => validate_recipient_key(a, &author, action.timestamp()),\n",
]
for fragment in additions:
    assert current.count(fragment) == 1, "missing or duplicated scoped attestation glue"
    current = current.replace(fragment, "", 1)
pinned = subprocess.check_output(["git", "-C", root, "show", f"{pin}:{path}"], text=True)
assert current == pinned, "legacy native integrity rules changed; refuse unreviewed build"
print("Native legacy integrity byte-for-byte preservation: PASS")
PY
REV=$(git -C "$ROOT" rev-parse HEAD)
TAG=$(printf %s "$SEED" | sha256sum | cut -c1-16)
OUT="$ROOT/target/browser-poc/$TAG"
node "$LIB" assert-absent "$OUT" || fail 'existing output must not be overwritten'
mkdir -p "$(dirname "$OUT")"
STAGE=$(mktemp -d "$(dirname "$OUT")/.staging.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/dna" "$STAGE/app"
(cd "$ROOT" && npm run build:zomes) || fail 'real WASM compilation failed'
for z in game_integrity game; do
  WASM="$ROOT/target/wasm32-unknown-unknown/release/$z.wasm"
  node "$LIB" require-wasm "$WASM" || fail "compiled $z WASM unavailable"
  cp "$WASM" "$STAGE/dna/$z.wasm"
done
node "$LIB" render-dna "$ROOT/dnas/game/workdir/dna.yaml" "$STAGE/dna/dna.yaml" "$SEED"
hc dna pack "$STAGE/dna" || fail 'hc dna pack failed'
[[ -s "$STAGE/dna/game.dna" ]] || fail 'hc dna pack did not produce game.dna'
HASH_OUTPUT=$(hc dna hash "$STAGE/dna/game.dna") || fail 'hc dna hash failed'
HASH=$(printf '%s\n' "$HASH_OUTPUT" | node "$LIB" parse-hash) || fail 'ambiguous or missing hc DNA hash'
node "$LIB" render-happ "$ROOT/workdir/browser-poc.happ.yaml" "$STAGE/app/happ.yaml" "$SEED" "$HASH"
cp "$STAGE/dna/game.dna" "$STAGE/app/game.dna"
hc app pack "$STAGE/app" || fail 'hc app pack failed'
[[ -s "$STAGE/app/imposter-browser-poc.happ" ]] || fail 'hc app pack produced no hApp'
node "$LIB" write-metadata "$STAGE" "$SEED" "$HASH" "$REV"
node "$LIB" write-checksums "$STAGE"
node "$LIB" verify "$STAGE"
# Avoid replacing an existing final output even if created during staging.
node "$LIB" assert-absent "$OUT"
mv -n "$STAGE" "$OUT"
[[ ! -e "$STAGE" ]] || fail 'output race: staging directory not moved; refusing to claim success'
[[ -s "$OUT/deployment.json" ]] || fail 'final artifact not moved'
trap - EXIT
printf 'P0 packaging only; HWC runtime UNTESTED\nArtifact: %s\nSeed: %s\nDNA hash: %s\n' "$OUT" "$SEED" "$HASH"
