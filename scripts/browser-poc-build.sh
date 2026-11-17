#!/usr/bin/env bash
# P0: package the real game and game_integrity WASMs as one seeded provisioned DNA.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN=111e6a44795e6572ed01191a98245ed723788c12
HWC=0c391226e78769d44ccb4661881ed8998b15f903
LINKER=cab242d32c988fe5e4e9fd06ebc82ed043541aa2
fail(){ echo "browser-poc-build: $*" >&2; exit 1; }
[[ $# == 1 ]] || fail 'usage: browser-poc-build.sh g1.<real-HWC-host-key>.<32-lowercase-hex>'
SEED=$1
node - "$SEED" <<'JS' || exit 2
const seed=process.argv[2]||'', m=/^g1\.(uhCAk[A-Za-z0-9_-]{48})\.([a-f0-9]{32})$/.exec(seed);
if(!m||Buffer.from(m[1].slice(1),'base64url').length!==39){console.error('invalid host-bound seed');process.exit(2)}
JS
if ! command -v hc >/dev/null 2>&1; then
  command -v nix >/dev/null 2>&1 || fail 'hc and nix unavailable; use pinned Nix shell'
  exec sh "$ROOT/scripts/in-nix.sh" bash "$ROOT/scripts/browser-poc-build.sh" "$SEED"
fi
for cmd in git npm node sha256sum od; do command -v "$cmd" >/dev/null 2>&1 || fail "missing $cmd"; done
git -C "$ROOT" cat-file -e "$PIN^{commit}" || fail 'pinned commit missing'
git -C "$ROOT" merge-base --is-ancestor "$PIN" HEAD || fail 'not based on pinned commit'
FILES=(Cargo.toml Cargo.lock flake.nix flake.lock dnas/game scripts/in-nix.sh)
git -C "$ROOT" diff --quiet "$PIN" HEAD -- "${FILES[@]}" || fail 'pinned DNA or build dependencies differ; review and document first'
git -C "$ROOT" diff --quiet HEAD -- "${FILES[@]}" || fail 'uncommitted DNA/build changes'
REV=$(git -C "$ROOT" rev-parse HEAD)
TAG=$(printf %s "$SEED" | sha256sum | cut -c1-16)
OUT="$ROOT/target/browser-poc/$TAG"
[[ ! -e "$OUT" ]] || fail "existing artifact: $OUT; reuse after verifying or remove deliberately"
mkdir -p "$(dirname "$OUT")"
STAGE=$(mktemp -d "$(dirname "$OUT")/.staging.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/dna" "$STAGE/app"
(cd "$ROOT" && npm run build:zomes)
for z in game_integrity game; do
  WASM="$ROOT/target/wasm32-unknown-unknown/release/$z.wasm"
  [[ -s "$WASM" ]] || fail "missing $WASM"
  [[ $(od -An -tx1 -N4 "$WASM" | tr -d ' \n') == 0061736d ]] || fail "$WASM is not WASM"
  cp "$WASM" "$STAGE/dna/$z.wasm"
done
SRC="$ROOT/dnas/game/workdir/dna.yaml"
grep -q 'network_seed: null' "$SRC" || fail 'review changed DNA manifest'
grep -q '../../../target/wasm32-unknown-unknown/release/game.wasm' "$SRC" || fail 'review coordinator path'
grep -q '../../../target/wasm32-unknown-unknown/release/game_integrity.wasm' "$SRC" || fail 'review integrity path'
sed -e "s|network_seed: null|network_seed: $SEED|" \
    -e 's|../../../target/wasm32-unknown-unknown/release/|./|g' "$SRC" > "$STAGE/dna/dna.yaml"
hc dna pack "$STAGE/dna"
[[ -s "$STAGE/dna/game.dna" ]] || fail 'hc dna pack did not produce game.dna'
HASH_OUTPUT=$(hc dna hash "$STAGE/dna/game.dna") || fail 'hc dna hash failed'
HASH=$(printf '%s\n' "$HASH_OUTPUT" | grep -Eo 'uhC0k[A-Za-z0-9_-]{48}' | head -n1 || true)
[[ $HASH =~ ^uhC0k[A-Za-z0-9_-]{48}$ ]] || fail "unrecognized hc DNA hash: $HASH_OUTPUT"
TEMPLATE="$ROOT/workdir/browser-poc.happ.yaml"
grep -q '__BROWSER_POC_SEED__' "$TEMPLATE" || fail 'missing template seed'
grep -q '__BROWSER_POC_DNA_HASH__' "$TEMPLATE" || fail 'missing template hash'
sed -e "s|__BROWSER_POC_SEED__|$SEED|g" -e "s|__BROWSER_POC_DNA_HASH__|$HASH|g" "$TEMPLATE" > "$STAGE/app/happ.yaml"
cp "$STAGE/dna/game.dna" "$STAGE/app/game.dna"
hc app pack "$STAGE/app"
[[ -s "$STAGE/app/imposter-browser-poc.happ" ]] || fail 'hc app pack produced no hApp'
node --input-type=module - "$STAGE" "$SEED" "$HASH" "$REV" "$PIN" "$HWC" "$LINKER" <<'JS'
import fs from 'node:fs'; import crypto from 'node:crypto'; import path from 'node:path';
const [dir,seed,dnaHash,sourceHead,imposter,hwc,h2hc]=process.argv.slice(2);
const sha=(name)=>crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex');
const m={schema_version:1,purpose:'P0 lobby ONLY; not full gameplay',runtime_validation:'NOT_RUN',signature_status:'UNSIGNED',
 host_agent_pub_key:seed.split('.')[1],network_seed:seed,dna_hash:dnaHash,source_head:sourceHead,
 pin:{imposter,hwc,h2hc},wasm_sha256:{game:sha('dna/game.wasm'),game_integrity:sha('dna/game_integrity.wasm')},
 dna_bundle_sha256:sha('dna/game.dna'),happ_bundle_sha256:sha('app/imposter-browser-poc.happ')};
fs.writeFileSync(path.join(dir,'deployment.json'),JSON.stringify(m,null,2)+'\n',{flag:'wx'});
JS
(cd "$STAGE" && sha256sum dna/dna.yaml dna/game.wasm dna/game_integrity.wasm dna/game.dna app/happ.yaml app/game.dna app/imposter-browser-poc.happ deployment.json > SHA256SUMS)
mv "$STAGE" "$OUT"
trap - EXIT
printf 'P0 packaging only; runtime UNTESTED\nArtifact: %s\nSeed: %s\nDNA hash: %s\n' "$OUT" "$SEED" "$HASH"
