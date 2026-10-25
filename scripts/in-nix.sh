#!/bin/sh
# Run a command inside the project's Nix dev shell — Holochain 0.7 binaries,
# kitsune2-bootstrap-srv, the Rust wasm toolchain, Node 22 — entering it first
# when the caller isn't already in one. Lets `npm run spin` and the builds work
# from a plain terminal, where they otherwise fail with a bare
# "[hc run-local-services] ERROR:" or a missing-binary error.
if [ -n "$IN_NIX_SHELL" ]; then
  exec "$@"
fi
cd "$(dirname "$0")/.." || exit 1
exec nix develop --command "$@"
