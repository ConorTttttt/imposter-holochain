#!/usr/bin/env bash
# Fetch exactly the source snapshot used for mobile benchmark evidence, then
# reproduce its patched 0.7.1 conductor and wasmi backend. No moving branches.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$APP_ROOT/.h2hc-source"
EXPECTED="1d77076debc0cdf3d870cf2f5e794b057c54f666"
ORIGIN="https://github.com/ConorTttttt/Holochain-mobile.git"
if [ ! -d "$SOURCE/.git" ]; then
  git clone --no-checkout --filter=blob:none "$ORIGIN" "$SOURCE"
fi
if [ "$(git -C "$SOURCE" remote get-url origin)" != "$ORIGIN" ]; then
  echo "Incorrect H2HC remote; refusing to use untrusted sources" >&2
  exit 1
fi
git -C "$SOURCE" fetch --depth 1 origin "$EXPECTED"
git -C "$SOURCE" checkout --detach "$EXPECTED"
if [ "$(git -C "$SOURCE" rev-parse HEAD)" != "$EXPECTED" ]; then
  echo "H2HC checkout does not match the pinned revision" >&2
  exit 1
fi
"$SOURCE/scripts/vendor-holochain.sh"
printf 'Pinned H2HC checkout prepared: %s\n' "$EXPECTED"
printf 'Sources: %s\n' "$SOURCE"
printf 'No mobile conductor has been started; secrets and linker identity are still required.\n'
