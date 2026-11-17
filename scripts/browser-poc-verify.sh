#!/usr/bin/env bash
# Check immutable packaging artifacts. Not a browser/runtime attestation.
set -euo pipefail
[[ $# == 1 ]] || { echo 'usage: browser-poc-verify.sh target/browser-poc/<tag>' >&2; exit 2; }
DIR=$(cd "$1" && pwd)
[[ -s "$DIR/deployment.json" && -s "$DIR/SHA256SUMS" ]] || { echo 'missing metadata/checksums' >&2; exit 1; }
(cd "$DIR" && sha256sum -c SHA256SUMS)
node --input-type=module - "$DIR" <<'JS'
import fs from 'node:fs'; import crypto from 'node:crypto'; import path from 'node:path';
const dir=process.argv[2],m=JSON.parse(fs.readFileSync(path.join(dir,'deployment.json')));
const sha=name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex');
const seed=m.network_seed||'';
if(m.schema_version!==1||!/^g1\.uhCAk[A-Za-z0-9_-]{48}\.[0-9a-f]{32}$/.test(seed))throw Error('invalid seed');
if(m.host_agent_pub_key!==seed.split('.')[1])throw Error('host key mismatch');
if(!/^uhC0k[A-Za-z0-9_-]{48}$/.test(m.dna_hash||''))throw Error('invalid DNA hash');
if(m.dna_bundle_sha256!==sha('dna/game.dna')||m.happ_bundle_sha256!==sha('app/imposter-browser-poc.happ'))throw Error('bundle SHA mismatch');
if(m.wasm_sha256?.game!==sha('dna/game.wasm')||m.wasm_sha256?.game_integrity!==sha('dna/game_integrity.wasm'))throw Error('WASM SHA mismatch');
const dna=fs.readFileSync(path.join(dir,'dna/dna.yaml'),'utf8'),happ=fs.readFileSync(path.join(dir,'app/happ.yaml'),'utf8');
if(!dna.includes('network_seed: '+seed)||!happ.includes('network_seed: '+seed)||!happ.includes('installed_hash: '+m.dna_hash))throw Error('manifest seed/hash mismatch');
if(m.runtime_validation!=='NOT_RUN'||m.signature_status!=='UNSIGNED')throw Error('packaging must not claim runtime/signature checks');
console.log('Packaging metadata consistent; HWC runtime still NOT TESTED.');
JS
if command -v hc >/dev/null 2>&1; then
  OUTPUT=$(hc dna hash "$DIR/dna/game.dna")
  GOT=$(printf '%s\n' "$OUTPUT" | grep -Eo 'uhC0k[A-Za-z0-9_-]{48}' | head -n 1 || true)
  WANT=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1])).dna_hash)" "$DIR/deployment.json")
  [[ $GOT == "$WANT" ]] || { echo "hc DNA hash mismatch: $GOT != $WANT" >&2; exit 1; }
  echo 'hc DNA hash recomputation: PASS'
else
  echo 'hc unavailable: DNA hash recomputation NOT RUN' >&2
fi
