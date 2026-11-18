# Native Holochain 0.7 authority: pinned launcher and acceptance gates

Status: **native DHT convergence NOT PROVEN**. PR #6 remains Draft.

## Recorded failure (GitHub Actions run 44178431806)
- Exact command: `nix develop --no-write-lock-file --command <repo>/node_modules/.bin/hc-spin --help`
- npm package: `@holochain/hc-spin@0.700.0` (`npm ci` PASS).
- Captured stderr: `FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166`; `chrome-sandbox` needs root ownership/mode 4755; Electron terminated with signal `SIGTRAP`.
- Numeric process exit code: **NOT CAPTURED** by the original probe. Do not fabricate one. The new probe records both code and signal.
- This was **Electron startup**, not a native Holochain 0.7 execution failure.
- Same runner's Nix build evidence confirmed `holochain_cli 0.7.0`, `hc 0.7.0`, `holochain 0.7.0`, `kitsune2-bootstrap-srv 0.5.0`, `lair-keystore 0.7.1`, and `cargo 1.95.0`.

## Replacement: real native binaries, no Electron or version upgrade

The isolated browser CI installs the **byte-identical** HWC Lair-host-bound `target/browser-poc/<hash>/app/imposter-browser-poc.happ` on a second native identity after the browser computes its live DNA/network seed.

With the pinned `flake.lock` and Nix cache:

```bash
# Run in the same pinned Imposter Nix shell as the real HWC run.
nix develop --no-write-lock-file --command bash -c '
  set -eu
  hc --version
  holochain --version
  hc sandbox generate --help >/dev/null
  hc sandbox run --help >/dev/null
'

# Run from a private, empty temporary sandbox directory. Example:
# export NATIVE_ROOT="$(mktemp -d)"
# export EXACT_HAPP="$(realpath target/browser-poc/.../app/imposter-browser-poc.happ)"
# export BOOTSTRAP="https://dev-test-bootstrap2.holochain.org/"
# export RELAY="$BOOTSTRAP"
# Test only: ephemeral separate Lair passphrase read on stdin, not in arguments or logs.
cd "$NATIVE_ROOT"
hc sandbox --piped generate \
  --app-id imposter-native-authority \
  --root "$NATIVE_ROOT" \
  --directories conductor-a \
  --in-process-lair \
  "$EXACT_HAPP" \
  network --bootstrap "$BOOTSTRAP" --target-arc-factor 1 quic "$RELAY"
hc sandbox --piped --force-admin-ports 33555 run --ports 33556
```

The checked-in experiment now invokes those sandbox commands through `nix develop --command` with a **different ephemeral passphrase and identity**, and captures non-secret output under `runtime-evidence/native-*.log`. Its `conductor-config.yaml` must contain the same bootstrap and relay settings as H2HC and `target_arc_factor: 1`. TCP/WebSocket readiness is labelled `CANDIDATE_RUNNING`, never `native-valid`.

**This is a reproducible attempt, not yet a verified working startup procedure.** Use the new CI evidence to confirm the commands work on the GitHub runner before treating it as a validated runtime recipe.

## Exact version and security contracts

- Imposter code from the pinned Agent 4 first-cell commit `8b167bf7f5bda0b213cd0a1679b35e9d252a4a36`; no game validator change.
- Real upstream HWC `0c391226e78769d44ccb4661881ed8998b15f903`, temporarily patched by Agent 2 `f888dc21110acff3e093ebe20b8ca16f60f1877d`.
- H2HC upstream `cab242d32c988fe5e4e9fd06ebc82ed043541aa2`, patched real Linux executable reused from verified run `44165793922`.
- `H2HC_LINKER_ALLOW_INSECURE_DEV=false`, `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false`; keep remote signal/call routes disabled.
- Real native authority agent must not share HWC's Lair key; identical hApp must preserve DNA hash. Neither a bootstrap service nor another zero-arc proxy counts as an authority.

## Evidence acceptance matrix

1. **Author:** genuine HWC public `create_lobby` action and signed DhtOp, capture `action_hash`, `author`, `dna_hash`.
2. **Queue:** H2HC authenticates agent and accepts signed operation; `queued>0`, `failed=0` only.
3. **Delivery:** discover a *nonzero-arc* native agent covering the DHT basis, identify peer and transport receipt, `published>0`. H2HC publication acknowledgement is not validation.
4. **Validation:** native Holochain 0.7 authority reports `ValidationStatus::Valid` for the exact action/entry, not merely TCP startup or local visibility.
5. **Retrieval:** second, independent, H2HC-authenticated agent receives non-null matching record + `Valid` from DHT, not local fallback or null JSON.
6. **Negative test:** sign and transport a native-format operation that fails the unchanged Rust `game_integrity` validator, and demonstrate native rejection independent of bearer transport authentication.

Until steps 3-6 have matching hashes, stop reporting DHT convergence as complete. Keep this as Draft.
