#!/bin/sh
# Mint a seed *only after* the real host browser has established its HWC key.
# The key is public; this helper never creates or exports a private agent key.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'usage: scripts/browser-poc-seed.sh <HWC-host-AgentPubKeyB64>' >&2
  exit 2
fi
node --input-type=module - "$1" <<'JS'
import { randomBytes } from 'node:crypto';
const key = process.argv[2] ?? '';
if (!/^uhCAk[A-Za-z0-9_-]{48}$/.test(key) || Buffer.from(key.slice(1), 'base64url').length !== 39) {
  console.error('invalid AgentPubKeyB64 syntax; get the actual 39-byte key from the host HWC extension');
  process.exit(2);
}
console.log(`g1.${key}.${randomBytes(16).toString('hex')}`);
JS
