#!/bin/sh
# Use the PUBLIC key from the intended host HWC profile; never generate an agent key here.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'usage: scripts/browser-poc-seed.sh <real-HWC-host-AgentPubKeyB64>' >&2
  exit 2
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec node "$ROOT/scripts/browser-poc-lib.mjs" seed "$1"
