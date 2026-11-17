# Imposter browser POC — Agent 4 runbook

**Purpose:** Reproducible, single-DNA HWC/H2HC **P0 lobby experiment** using Imposter's real `game` and `game_integrity` WASMs. **Not** a playable hidden-role browser game. Last updated: 17 November 2026.

Read the architect-supplied `docs/h2hc-browser-architecture.md` before any implementation. The architecture file may not yet be committed; use the supplied 17 November 2026 document. Agent 4 owns only `workdir/browser-poc.happ.yaml`, `scripts/browser-poc-*.sh`, this runbook and isolated fixtures. Do not touch the native `workdir/happ.yaml`, Rust validation, room registry, main UI, or Agent 6's test directories.

## Source pins and limitations

| Repository | Pinned commit |
| --- | --- |
| `ConorTttttt/imposter-holochain` | `111e6a44795e6572ed01191a98245ed723788c12` |
| `Holo-Host/holo-web-conductor` | `0c391226e78769d44ccb4661881ed8998b15f903` |
| `Holo-Host/h2hc-linker` | `cab242d32c988fe5e4e9fd06ebc82ed043541aa2` |

Imposter uses Holochain 0.7.0, HDK 0.7.0, HDI 0.8.0, Node 22 and pinned Cargo/Nix/npm lockfiles. The builder refuses any changes to committed Rust DNA/build/lockfile inputs relative to the pinned investigation commit. Confirm HWC and H2HC runtime SHAs separately; a manifest's pins are **expectations**, not proof those versions are running. No dependency upgrades are part of this change.

Architecture blockers on these pins: **B-02** HWC role seed may not reach `dna_info_v2`; **B-03** cap-grant creation/`init` may be incompatible; **B-06/B-09** DHT interoperability and linker auth unproven. **B-01** private `SealedRoles` visibility, **B-04** unsupported `call_remote` and **B-05** remote-signal authentication are strict P1 blockers. No secret-role mechanics, vote/kill, sabotage, Play Again, cloned cells, fabricated host identity or bypass of Rust lobby ownership is permitted.

## A. Baseline — record actual outcomes

Run in a true checkout on `feature/browser-compatibility-harness`, not `main`. A Nix shell supplies the pinned Holochain toolchain. Keep full stdout/stderr, exact exit code, date, source SHA, and machine environment per command:

```bash
git rev-parse HEAD && git status --short
node --version; npm --version; cargo --version; nix --version; hc --version
npm run test:core
npm run test:round
npm run test:ui
(cd ui && npm run typecheck)
(cd ui && npm run build)
```

For the native end-to-end tests, run `npm run build:happ` as their documented prerequisite; it compiles the original WASMs and packs only the native hApp. The round runner isolates each sweettest in its own process. Never change tests or ignore an exit code just to obtain green results. Missing tools/checkout mean **NOT RUN**, never PASS. Note: the pinned `ui/package.json` has no `typecheck` script; record the actual missing-script error if reproduced, and ask the UI owner to coordinate any change.

## B. Establish actual host HWC identity first

The P0 is an *operator-prepared* one-room experiment: HWC's host identity must exist before making a host-bound seed. In the **intended host browser profile**, on the **exact website origin** where HWC will later run, explicitly authorize the pinned HWC extension. In that trusted origin's developer console:

```javascript
await window.holochain.connect();
const bytes = new Uint8Array(window.holochain.myPubKey);
if (bytes.length !== 39) throw Error('HWC did not supply a Holochain AgentPubKey');
const hostKeyB64 = 'u' + btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
if (!/^uhCAk[A-Za-z0-9_-]{48}$/.test(hostKeyB64)) throw Error('invalid HWC key encoding');
console.log(hostKeyB64); // public key only; never extract private keys
```

Record the exact origin and profile and reconnect to verify the **same** host public key. If this HWC build cannot provision a key before an application is installed, use an independently reviewed non-game fixture with the same domain identity; **do not** fake a host key, switch to a legacy `room1.*` seed, or disable native host checks.

## C. Generate ONE seed; build an immutable test bundle

```bash
# Paste the real key obtained from the HWC host profile above:
HOST_HWC_KEY='uhCAk...REPLACE_WITH_REAL_HOST_KEY...'
SEED=$(sh scripts/browser-poc-seed.sh "$HOST_HWC_KEY")
printf '%s\n' "$SEED"     # Save and reuse this exact seed for the experiment.
bash scripts/browser-poc-build.sh "$SEED"
# Use the target/browser-poc/<tag> path printed by the command:
bash scripts/browser-poc-verify.sh target/browser-poc/<tag>
```

The seed generator uses a CSPRNG for 16 bytes = 32 lowercase hexadecimal characters; the result has exactly the existing `g1.<HWC-AgentPubKeyB64>.<32-hex>` shape. This is a **format check**, not proof of host key ownership: the real HWC host profile is the authority for the identity.

The builder:
1. Refuses unexpected source drift and preexisting output (no silent replacements).
2. Builds **actual** release `game.wasm` and `game_integrity.wasm` via `npm run build:zomes` using the pinned Nix environment.
3. Copies the canonical DNA manifest to a **staging** directory, changes only WASM paths to staged copies, and bakes the seed into `integrity.network_seed`.
4. Packs staged `game.dna`; obtains its real `hc dna hash` and renders `workdir/browser-poc.happ.yaml` as staged `app/happ.yaml` with a provisioned `game` role, `clone_limit: 0`, **identical role seed** and actual `installed_hash`.
5. Packs `imposter-browser-poc.happ`, records checksums and source SHAs, and moves the immutable result under `target/browser-poc/<tag>/`.

This dual embedding mitigates the HWC role-modifier mismatch suspected in the architecture audit **but cannot prove correct runtime `dna_info` semantics**. In case of any mismatch, stop and coordinate with Agent 2 (HWC owner), not by changing Imposter's Rust validation.

Output tree:

```text
target/browser-poc/<tag>/
  dna/{dna.yaml,game_integrity.wasm,game.wasm,game.dna}
  app/{happ.yaml,game.dna,imposter-browser-poc.happ}
  deployment.json       # pinned SHAs, host key, seed, real DNA hash, SHA-256
  SHA256SUMS             # file-level corruption checks
```

**Release authenticity:** `deployment.json` is marked `runtime_validation: NOT_RUN` and `signature_status: UNSIGNED`. SHA-256 hashes check consistency, **not authenticity**. Authenticate and sign final deployment metadata with a separate trusted operator release key before hosting a bundle; serve identical hApp bytes to all browsers via HTTPS. Keep source and artifacts pinned.

## D. HWC/H2HC nine-check experiment (actual observations required)

Use a pinned HWC extension, H2HC linker with authenticated WebSocket registration, one H2HC network, a trusted HTTPS web origin and an independent HWC call harness. This script set **does not** add a browser UI or secretly invoke native `AppWebsocket`. Use three **separate browser profiles/extension stores**, not shared tabs: one bound host, two guests. All profiles install the **same hApp bytes/DNA hash**, but hold **distinct** Holochain agent public keys.

| # | Runtime probe | Required evidence | Initial result |
| --- | --- | --- | --- |
| 1 | HWC installation | Three installation records; identical .happ SHA256 and DNA hash | NOT RUN |
| 2 | Genesis | Complete authored genesis on each profile, with no skipped callback | NOT RUN |
| 3 | Coordinator init | Actual valid persisted cap grant, no silently skipped `init` | NOT RUN |
| 4 | Seed/hash | Real WASM `dna_info()?.modifiers.network_seed` equals built seed, equals hashed role seed; not synthetic `appInfo` | NOT RUN |
| 5 | Host identity | Host AgentPubKey equals `g1` host; distinct guest keys | NOT RUN |
| 6 | Valid lobby | Host coordinator `create_lobby` returns a valid record | NOT RUN |
| 7 | Unauthorized host | A guest `create_lobby` is **rejected by Rust validation**, not the UI | NOT RUN |
| 8 | DHT publication/read | Both guests see host lobby through H2HC; their joins converge to 3 seats on all profiles | NOT RUN |
| 9 | Reconnection | Refresh/restart each browser; same key/seed and persistent source-chain records, one lobby, recovered seats | NOT RUN |

Minimal P0 coordinator inputs for an approved HWC `WebConductorAppClient` harness:

```typescript
const options = { role_name: 'game', zome_name: 'game' };
await host.callZome({ ...options, fn_name: 'create_lobby',
  payload: { code: SEED, player_count: 3, impostor_count: 1, task_target: 1, display_name: 'Host' } });
await guest1.callZome({ ...options, fn_name: 'join_lobby', payload: { display_name: 'Guest 1' } });
await guest2.callZome({ ...options, fn_name: 'join_lobby', payload: { display_name: 'Guest 2' } });
await guest1.callZome({ ...options, fn_name: 'get_game_state', payload: null });
```

**Ordering:** Test guest-created lobby **before** allowing the bound host to create one; a guest cannot validly own the `g1` seed. If coordinator `init` or DNA seed is wrong, do not continue. For DHT convergence collect timestamps, errors, app IDs, real agent/cell/DNA IDs, source-chain and H2HC logs on each profile. A host's local read is not DHT proof. Retry boundedly on eventual-consistency delays but never create a second lobby on a read miss.

The current published coordinator does not expose a read-only browser `dna_info` preflight extern. Until an upstream instrumented test proves that exact actual WASM modifier, mark check 4 **BLOCKED**. Coordinate any additive zome changes with the architect and owning agent; this packaging branch must not modify protected Rust files.

**P0 demo threshold:** All 9 probes, distinct identities, identical provisioned DNA and three-party persistent lobby must actually pass. No secret-role gameplay. **P1 remains blocked** until private entry visibility, authenticated remote signals and `call_remote` capabilities pass real security-negative tests; do not treat successful packaging as runtime readiness.

## E. Escalation and recorded environment

If tests fail, send Agent 2 (HWC), H2HC owner and Agent 6 the exact HWC/H2HC SHAs, deployment JSON, actual failing zome call/genesis stage, error output, profile identities and timestamp. Never weaken the Rust integrity zome, fake peer provenance, or substitute the Linker's HTTP API for `NetworkAgent` remote calls.

**17 Nov 2026 sandbox baseline:** GitHub API read the now-public Imposter repository; `main` matched pinned `111e6a...`. The local sandbox could **not** resolve github.com for Git clone/ls-remote; Node 22/npm were available but Cargo, Nix and `hc` were absent. Consequently the five baseline test commands, real WASM packaging, HWC installation/genesis, DHT and three-browser sessions are **NOT RUN** in that sandbox. Script syntax/invalid-input checks are separately reportable, but cannot count as HWC runtime evidence.
