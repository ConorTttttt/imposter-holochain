#!/usr/bin/env bash
# Disposable native Cargo overlay; keep game's existing Cargo workspace intact.
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$APP_ROOT/.h2hc-source"
OUT="$APP_ROOT/.h2hc-build/src-tauri"
[ -f "$SOURCE/vendor/holochain-0.7.1/Cargo.toml" ] || {
  echo "Run bash scripts/prepare-h2hc.sh first" >&2; exit 1;
}
[ -f "$SOURCE/vendor/wasmer-7.1.0/Cargo.toml" ] || {
  echo "Patched wasmer source missing" >&2; exit 1;
}
mkdir -p "$APP_ROOT/.h2hc-build"
rm -rf "$OUT"
cp -a "$APP_ROOT/src-tauri" "$OUT"
cat >> "$OUT/Cargo.toml" <<'TOML'

[dependencies.h2hc-conductor]
path = "../../.h2hc-source/prototypes/h2hc-conductor"
default-features = false
features = ["wasmi"]

[dependencies.h2hc-p2p]
path = "../../.h2hc-source/prototypes/h2hc-p2p"

[dependencies.h2hc-protocol]
path = "../../.h2hc-source/prototypes/h2hc-protocol"

[dependencies.holochain]
version = "=0.7.1"
default-features = false
features = ["encryption", "wasmer-wasmi"]

[dependencies.holochain_conductor_api]
version = "=0.7.1"

[dependencies.lair_keystore_api]
version = "=0.7.1"

[dependencies.base64]
version = "0.22"

[dependencies.sodoken]
version = "0.1"

[patch.crates-io]
holochain = { path = "../../.h2hc-source/vendor/holochain-0.7.1" }
wasmer = { path = "../../.h2hc-source/vendor/wasmer-7.1.0" }
TOML
python3 - "$OUT/tauri.conf.json" <<'PY'
from pathlib import Path
import json, sys
path = Path(sys.argv[1])
conf = json.loads(path.read_text())
conf["build"]["frontendDist"] = "../../../../ui/dist"
conf["build"]["beforeBuildCommand"] = "npm --prefix ../../../ui run build"
conf["build"]["beforeDevCommand"] = "npm --prefix ../../../ui run dev -- --host 0.0.0.0"
path.write_text(json.dumps(conf, indent=2) + "\n")
PY
echo "Prepared: $OUT/Cargo.toml"
echo "From app root run: cargo check --manifest-path .h2hc-build/src-tauri/Cargo.toml --features h2hc-runtime"
