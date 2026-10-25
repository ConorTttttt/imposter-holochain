#!/bin/sh
# Build tests/forge/game.dna: the game DNA with a tampered coordinator (the
# `forge` feature), so a sweettest agent can try to write links an honest
# client never would. The integrity zome is the normal build's, so the DNA
# hash — and the network — is the same as the real game's.
set -e
cd "$(dirname "$0")/.."
# exactly the hApp's build: building the integrity zome on its own resolves
# features differently and gives different wasm, so a different DNA hash
cargo build --release --target wasm32-unknown-unknown -p game_integrity -p game
# Keep the normal test DNA in sync when integrity code changed.
hc dna pack dnas/game/workdir
cargo build --release --target wasm32-unknown-unknown -p game --features forge --target-dir target/forge
hc dna pack tests/forge
