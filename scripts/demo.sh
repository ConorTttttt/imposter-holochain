#!/bin/sh
# The local demo in one command: the PeerKit relay, the Vite dev server, and
# hc-spin with N windows (default 4). A relay or dev server that's already
# running is reused. Closing spin (or Ctrl-C) stops whatever this started.
#
#   npm run demo            4 windows
#   npm run demo -- 6       6 windows
cd "$(dirname "$0")/.." || exit 1
N=${1:-4}
started=""
trap 'for p in $started; do kill "$p" 2>/dev/null; done' EXIT
trap 'exit 130' INT TERM

if pgrep -f "[t]sx src/relay.ts" >/dev/null; then
  echo "demo: using the relay that's already running"
else
  (cd ui && exec node_modules/.bin/tsx src/relay.ts) &
  started="$started $!"
fi

if curl -s -o /dev/null http://localhost:5173/; then
  echo "demo: using the dev server already on :5173"
else
  (cd ui && exec node_modules/.bin/vite --strictPort) &
  started="$started $!"
  until curl -s -o /dev/null http://localhost:5173/; do sleep 1; done
fi

sh scripts/in-nix.sh env -u WAYLAND_DISPLAY -u ELECTRON_RUN_AS_NODE XDG_SESSION_TYPE=x11 \
  hc-spin -n "$N" --ui-port 5173 workdir/imposter.happ
