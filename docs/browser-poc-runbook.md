# Imposter browser POC — Agent 4 runbook

**Purpose:** Reproducible, single-DNA HWC/H2HC **P0 lobby experiment** using Imposter's real `game` and `game_integrity` WASMs. **Not** a playable hidden-role browser game. Last updated: 17 November 2026.

Read the architect-supplied `docs/h2hc-browser-architecture.md` before any implementation. The architecture file may not yet be committed; use the supplied 17 November 2026 document. Agent 4 owns only `workdir/browser-poc.happ.yaml`, `scripts/browser-poc-*` (including the Node packaging helper and its tests), this runbook and isolated fixtures. Do not touch the native `workdir/happ.yaml`, Rust validation, room registry, main UI, or Agent 6's test directories.

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

For the native end-to-end tests, run `npm run build:happ` as their documented prerequisite; it compiles the original WASMs and packs only the native hApp. The round runner isolates each sweettest in its own process. Never change tests or ignore an exit code just to obtain green results. Missing tools/checkout mean **NOT RUN**, never PASS. Note: the pinned `ui/package.json` DOES define `typecheck` as `tsc --noEmit`; execute it after installing its pinned dependencies. Do not edit the UI package manifest.

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



## G. Automated packaging regression suite — executed

From this feature branch (Node 22; no Holochain/Nix required):

```bash
bash -n scripts/browser-poc-build.sh
bash -n scripts/browser-poc-seed.sh
bash -n scripts/browser-poc-verify.sh
node --check scripts/browser-poc-lib.mjs
node --test scripts/browser-poc.test.mjs
```

**Actual local test result (17 Nov 2026):** Node 22.16.0; **15/15 PASS, 0 FAIL** in about 0.6 seconds. The tests exercise valid host-bound 128-bit seed generation, malformed public-key/seed rejection, missing toolchain, missing/truncated WASM, altered canonical DNA manifest, two-zome/one-seed manifest rendering, hApp placeholder and hash replacement, ambiguous/malformed DNA hash parsing, checksum and app-DNA-copy tampering, existing-artifact refusal, and repeated verification. The fixture uses **synthetic HoloHash strings and synthetic WASM headers/bundles**; it does NOT simulate successful WASM compilation, `hc dna pack`, genesis, HWC installation or a security pass.

The builder invokes the production helper for both manifest rendering and checksum validation. It requires a real `hc` implementation and executes `npm run build:zomes` (not a mocked compile) before packaging. `browser-poc-verify.sh` recomputes the DNA hash with `hc dna hash` when `hc` is available; without it, only offline checksum/manifest checks can pass. The exact `hc dna hash` output and installed-hash semantics still require a real pinned CLI run.

## H. Reproducible runtime smoke commands (operator only, not yet executed)

### 1. Pin and provision the toolchain

In a network-enabled Linux development host with Git, Nix flakes and enough build RAM, obtain the exact source and do not update any lockfiles:

```bash
git clone https://github.com/ConorTttttt/imposter-holochain.git
cd imposter-holochain
git switch feature/browser-compatibility-harness
git merge-base --is-ancestor 111e6a44795e6572ed01191a98245ed723788c12 HEAD
nix develop --command bash -c 'node --version; cargo --version; hc --version'
nix develop --command bash -c 'npm run test:core && npm run test:ui'
nix develop --command bash -c '(cd ui && npm run typecheck && npm run build)'
# Build the normal native DNA as a separate baseline, not the browser bundle:
nix develop --command bash -c 'npm run build:happ && npm run test:round'
node --test scripts/browser-poc.test.mjs
```

`npm run build:zomes` from the pinned root `package.json` calls `scripts/in-nix.sh cargo build --release --target wasm32-unknown-unknown -p game_integrity -p game`. The WASMs should appear at `target/wasm32-unknown-unknown/release/{game,game_integrity}.wasm`. Do not claim the build, the `hc dna hash` command or installed_hash semantics work until this completes successfully.

### 2. Pin the HWC extension and configure authenticated H2HC

Check out HWC at `0c391226e78769d44ccb4661881ed8998b15f903` and H2HC at `cab242d32c988fe5e4e9fd06ebc82ed043541aa2`. Build/install the extension using those repositories' own pinned instructions and verify its enabled origin permissions. For H2HC, the pinned README documents `cargo build --release`, `H2HC_LINKER_BOOTSTRAP_URL`, `H2HC_LINKER_ADDRESS`, and `H2HC_LINKER_PORT`. In the H2HC checkout:

```bash
git rev-parse HEAD                 # must equal cab242d32c988fe5e4e9fd06ebc82ed043541aa2
cargo build --release
# Provide the real same-network Kitsune bootstrap address; do NOT put an admin secret in browser JS.
export H2HC_LINKER_BOOTSTRAP_URL='<verified-bootstrap-url>'
export H2HC_LINKER_ADMIN_SECRET='<server-side-secret-from-secure-store>'
export H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false
./target/release/h2hc-linker   # localhost:8090 by default
```

**Important:** At the pinned linker revision, `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK` defaults **true**. With fallback enabled, buffered data lacking authority validation can be reported as valid by the DHT route. This experiment requires `false` until validation provenance is independently reviewed. An admin secret enables linker authentication, but is **not itself** proof that browser identities are registered or that cross-peer data is trustworthy. For cross-machine profiles, publish the service through a trusted TLS/WSS reverse proxy with origin restrictions, agent registration and challenge-response; confirm `getConnectionStatus().authenticated === true` and a healthy WebSocket in every profile. Coordinate these settings, auth negotiation, and any joining-service provision with Agent 3/H2HC; never place the admin secret in a public bundle.

### 3. Establish real host identity, build once, then serve identical bytes

Follow Section B in the intended host extension profile at the intended **website origin** before running `scripts/browser-poc-seed.sh`. Install no game bundle until the identity has been recorded and recovered on reconnect. If the HWC version requires an onboarding fixture to create a key, coordinate a separately reviewed non-game fixture instead of fabricating an identity.

```bash
HOST_HWC_KEY='<actual-HWC-host-public-key>'
SEED="$(sh scripts/browser-poc-seed.sh "$HOST_HWC_KEY")"
bash scripts/browser-poc-build.sh "$SEED"
# Use the actual printed target/browser-poc/<tag> directory, never a guessed name:
bash scripts/browser-poc-verify.sh target/browser-poc/<tag>
sha256sum target/browser-poc/<tag>/app/imposter-browser-poc.happ
cat target/browser-poc/<tag>/deployment.json
```

Host the exact `imposter-browser-poc.happ` and `deployment.json` at a trusted HTTPS origin as `/imposter-browser-poc.happ` and `/deployment.json`. Verify the SHA-256 against the independently recorded operator value; `deployment.json` is initially **UNSIGNED** and not a trust anchor. A real HWC installation and actual `dna_info` result still have to confirm modifier propagation.

### 4. Install and call the provisioned game in three independent profiles

Create three browser **profiles**, not three tabs: the prepared host profile and independently provisioned Guest 1 and Guest 2 profiles. Install the pinned HWC extension in each. With only the P0 harness page open on the identical HTTPS origin, run this **operator smoke console script** once per profile after editing the local variables (the `window.holochain` methods and `cell_id` request shape are from the pinned HWC client types):

```javascript
const linkerUrl = 'wss://YOUR-TRUSTED-LINKER';  // TLS endpoint, never the admin secret
const hc = window.holochain;
if (!hc?.isWebConductor) throw Error('HWC extension missing');
await hc.connect();
await hc.configureNetwork({ linkerUrl });
const network = await hc.getConnectionStatus();
if (!network.authenticated || !network.wsHealthy)
  throw Error('H2HC authenticated WebSocket not ready');
const deployment = await (await fetch('/deployment.json', { cache: 'no-store' })).json();
const response = await fetch('/imposter-browser-poc.happ', { cache: 'no-store' });
if (!response.ok) throw Error('hApp download failed');
const bundle = new Uint8Array(await response.arrayBuffer());
if (bundle[0] !== 0x1f || bundle[1] !== 0x8b) throw Error('not a gzip hApp bundle');
const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bundle)),
  b => b.toString(16).padStart(2, '0')).join('');
if (digest !== deployment.happ_bundle_sha256)
  throw Error('hApp bytes mismatch operator metadata');
await hc.installApp({ bundle, installedAppId: 'imposter-browser-poc' });
const info = await hc.appInfo('imposter-browser-poc');
if (!info || info.cells.length !== 1) throw Error('expected exactly one provisioned cell');
const cellId = info.cells[0].map(v => new Uint8Array(v));
const toHoloHash = bytes => 'u' + btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const actualDnaHash = toHoloHash(cellId[0]);
if (actualDnaHash !== deployment.dna_hash) throw Error('installed DNA hash mismatch');
const myKey = 'u' + btoa(String.fromCharCode(...new Uint8Array(info.agentPubKey)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const call = (fn_name, payload = null) =>
  hc.callZome({ cell_id: cellId, zome_name: 'game', fn_name, payload });
console.log({ myKey, expectedDna: deployment.dna_hash, status: info.status, network });
```

For profile reloads, reconnect and call `appInfo`; **do not reinstall** a previously installed application without an explicit reset policy. Verify all three `myKey` values differ and match each profile after reload; verify the actual installed DNA hash in `cellId[0]` against the expected hash using the HoloHash base64url encoding above (hash prefix will be `uhC0k`). `appInfo` and role modifiers alone **do not prove** the real WASM's `dna_info` network seed. The required seed probe must come from an upstream instrumented HWC/WASM test or architect-approved additive read-only zome extern. Until then, mark check #4 BLOCKED.

**Run negative creation before positive creation.** On Guest 1, with the correct fixed DNA installed and no valid lobby yet:

```javascript
await call('create_lobby', {
  code: deployment.network_seed, player_count: 3, impostor_count: 1,
  task_target: 1, display_name: 'Unauthorised Guest'
}); // MUST FAIL at Rust integrity validation, not merely a page-side check
```

If this unexpectedly succeeds, STOP, preserve chain/extension/linker logs and escalate B-02/B-03: **do not create a host lobby, and do not enable gameplay.** Once the guest's failed write is confirmed rolled back (no invalid authored chain), in the **bound host** profile run:

```javascript
await call('create_lobby', {
  code: deployment.network_seed, player_count: 3, impostor_count: 1,
  task_target: 1, display_name: 'Host'
}); // MUST SUCCEED with a valid record
```

In each **guest** profile in sequence (not simultaneously on the last seat), run:

```javascript
await call('get_game_state'); // must discover host lobby from network; do not create an extra lobby
await call('join_lobby', { display_name: 'Guest 1' }); // use Guest 2 in second profile
await call('get_game_state'); // verify all three seats converge after bounded retry
```

Repeat `get_game_state` from all three profiles after a reload, then after a complete browser restart. Record raw results and H2HC WS/gossip/dht logs with timestamps, profile/cell IDs and correlation IDs; do not log secrets. Distinguish local source-chain reads from validated remote DHT reads. Retain evidence of failed unauthorized creation, genesis init-cap-grant, and real seed propagation separately. **No Start/Deal/Roles/Tasks/Kill/Sabotage/Vote/Play Again** under P0.

### 5. Common blocker diagnoses

| Symptom | Likely gate | Required next evidence |
| --- | --- | --- |
| `hc` or `nix` unavailable | Environment | Pin Nix toolchain; no fake compile |
| `hc dna pack` or `hc dna hash` fails | Packaging/CLI | Exact CLI version, exit status, stdout/stderr; correct builder, not manifest guess |
| Installed DNA hash differs | B-02 | Verify embedded seed, real Holochain hash, modifier propagation |
| `init` or cap grant fails | B-03 | Capture actual WASM imports/cap grant entry failure, coordinate Agent 2 |
| Guest creates valid lobby | B-02 / integrity boundary | Stop; preserve complete op validation trace and DNA seed |
| WS unauthenticated | B-09 | Confirm server-side secret, joining registration, TLS and challenge flow |
| Host writes but guest sees no DHT lobby | B-06 / B-09 | Collect authority verdict, kitsune2 peer routing and linker logs; no local buffer fallback |
| Guest reload loses identity or seats | Persistence gate | Inspect extension IndexedDB/OPFS and domain context; do not overwrite |
| Private entry or remote-signal trust issue | B-01 / B-05 | P1 blocked; do not run hidden-role tests |
| HWC `call_remote` fails | B-04 | Expected P0 limitation; never fake remote call via PeerKit/HTTP |

**No actual HWC install, genesis, capability, three-browser DHT, or reconnection results were obtained in this execution environment.** This procedure specifies the acceptance checks for a qualified host, not evidence of their completion.


## I. First real HWC browser acceptance — patched extension handoff (17 Nov 2026)

### Verified upstream builds, separate from real-WASM execution

Agent 2's CI patch-application + typecheck, Vitest and Chrome/Firefox extension builds **PASSED** at [Actions 44159079831](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44159079831) (source-kit revision `a892a3c0b3141f0ffe9daf868cce4e8e29af2efc`). It ran against exact upstream HWC `0c391226e78769d44ccb4661881ed8998b15f903`. Its original evidence ZIP is **patches/logs only**, **not an installable extension**. Agent 3 H2HC Rust security `cargo test --locked` (**194 lib + 10 integration tests passed**), formatting, and strict Clippy passed at [Actions 44161044000](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44161044000), using pinned upstream `cab242d32c988fe5e4e9fd06ebc82ed043541aa2` and an in-run patch kit. Neither CI result is evidence of real Imposter execution or browser authenticated networking.

Agent 4's isolated [real-browser CI smoke workflow](../.github/workflows/browser-poc-hwc-runtime.yml) checks out that **exact** validated Agent 2 kit, applies it on a clean temporary HWC checkout, builds `dist-chrome/`, starts a **real persistent headed Chromium browser with the extension loaded** via Xvfb, calls `window.holochain.connect()` to obtain a genuine ephemeral Lair-hosted key, rebuilds the real Imposter zomes with that host-bound seed, attempts HWC hApp installation, then calls the actual `game::get_game_state` and `game::create_lobby` externs. It stops at the **first meaningful failed gate** and uploads `runtime-evidence/runtime-evidence.json` and stage logs. This is not a mock: failing WASM execution is a FAIL, not a PASS. Its GitHub profile is deleted at job exit; **even a successfully built host-bound CI package cannot be deployed on another machine**, because the corresponding keystore was not exported.

### Exact supported pre-install identity creation

Pinned HWC `packages/extension/src/background/index.ts` `handleConnect` delegates to `happContextManager.getOrCreateAgentKey(origin)` on authorized sites, including localhost auto-approval; `packages/extension/src/lib/happ-context-manager.ts` uses the origin-scoped Lair tag `<origin>:agent` and generates a Lair Ed25519 key on first connect, reusing it subsequently. The injected `connect()` caches `result.agentPubKey` as `window.holochain.myPubKey`. **No hApp installation is needed to acquire an HWC public host key.**

Manual procedure with **one isolated persistent host browser profile**:

1. Install the CI-built and owner-reviewed **patched** HWC `dist-chrome/` unpacked extension using `chrome://extensions` → Developer mode → Load unpacked. Verify that its generated `manifest.json` and `background/index.js` came from Agent 2's pinned kit. Do not install the pristine upstream extension and assume it contains the B-02/B-03 patches. The operator must review the Chrome extension build artifact before installation.
2. Pick one origin for the experiment, e.g. **`http://localhost:8765`**, and keep *exactly that* scheme, hostname and port throughout key generation, build, install and reconnect. `http://127.0.0.1:8765` is a **different origin** and will produce a different HWC agent key.
3. Serve a minimal trusted index page from a directory outside `ui/`: `mkdir -p /tmp/imposter-p0-site && printf '<!DOCTYPE html><title>Imposter P0</title>\n' > /tmp/imposter-p0-site/index.html && python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/imposter-p0-site`. Keep it running. Navigate the **host** profile to `http://localhost:8765`.
4. In DevTools at that page, run the existing Section B `window.holochain.connect()` code. The extension itself creates the secret key in its own Lair keystore. Save **only** the resulting public `uhCAk...` key. Reload; call `connect()` again and verify the **same** 39-byte public key. If absent, capture the extension background/offscreen errors and mark **B-07 FAIL**; **do not fabricate a key**.
5. With the public host key on the operator machine, execute the existing Section C `browser-poc-seed.sh`, `browser-poc-build.sh` and `browser-poc-verify.sh`. Record the **new** seed, native `hc dna hash`, real hApp SHA and host identity. The old artifact from synthetic CI cannot be reused. Check both `dna/dna.yaml` and `app/happ.yaml` seed values and role `installed_hash`.
6. Place **only** the verified `app/imposter-browser-poc.happ` and `deployment.json` in `/tmp/imposter-p0-site/`. Continue with Section H's browser fetch/check/install code on that *same origin*. The browser profile's public key **must equal** `deployment.json.host_agent_pub_key` before installing. The `happ` URL is `http://localhost:8765/imposter-browser-poc.happ`.
7. Install HWC using `window.holochain.installApp({bundle: new Uint8Array(await (await fetch('/imposter-browser-poc.happ')).arrayBuffer()), installedAppId: 'imposter-browser-poc'})`, then `window.holochain.appInfo()`. Verify exactly one cell, that its DNA hash equals the pinned `deployment.json.dna_hash`, and that its agent equals the pre-install host key. An API response alone is **not** confirmation of genesis.
8. Call `window.holochain.callZome({zome_name:'game',fn_name:'get_game_state',payload:null})` to force the first actual WASM execution and the Agent 2 initializer path. A successful return proves a callable coordinator WASM, **not** that `CapGrant` persisted. Separately verify genesis source-chain actions and `InitZomesComplete` order in the HWC offscreen/background logs or authorized read-only chain inspector; no public inspector is yet established.
9. Only after successful real WASM execution, call the host `create_lobby` with `{code: <exact-seed>,player_count:3,impostor_count:1,task_target:1,display_name:'HWC Host'}`. Preserve the result and action hash. The corresponding unauthorized negative test requires a **separate guest profile and the same DNA**, and a rejection **from the Rust integrity validation**, not a JavaScript-side guard.
10. Stop immediately at the first failed gate, preserving timestamp, page console error, HWC offscreen/ribosome log, installed cell hash, and error text. Remove any private signing material, bearer tokens or join-service credentials from logs. Do not reinstall over an incompletely initialized context: use a new test profile after preserving evidence.

**Known public API limitation:** `window.holochain` exposes `connect`, `installApp`, `appInfo`, `callZome` and networking methods, **but no documented read-only source-chain list or CapGrant inspector**. Thus successful call and matching installed cell hash cannot independently close B-03 persistence or B-02 WASM `dna_info_v2` without controlled extension instrumentation / Agent 2 review. The existing integrity zome does not expose a public read-only `dna_info_v2` extern.

### Agent 3 authenticated H2HC: configuration gate, not operational readiness

The security-patched linker must be built from the *in-run Agent 3 source kit*, not plain upstream `cab242d`. Require Agent 3's exact patched commit/diff, reproducible binary and **live registration/WS/auth test** before the first 3-profile network experiment. The source kit is in `ci/agent3-h2hc-security-validation` at `3ef04b8865ad174696226e8df71040ee244dd012`; CI reconstructs the kit from `ci/agent3-h2hc-kit/part*.b64` and applies guarded Rust patches to an isolated pinned checkout. The green Rust check did **not** prove a running authenticated linker.

For controlled operator deployment, configure server-side only: `H2HC_LINKER_BOOTSTRAP_URL=<same-network-bootstrap>`, `H2HC_LINKER_ADMIN_SECRET=<server-only-secret>`, `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false`, persistent key file and durable session-store settings approved by Agent 3. Expose a trustworthy `wss://` endpoint with TLS and origin restrictions. Provision individual browser agents through Agent 3's verified authenticated joining/registration mechanism, **never by placing server secrets, bearer tokens, or HWC signing keys in browser JavaScript**. Independently verify `window.holochain.getConnectionStatus()` reports `authenticated === true` and `wsHealthy === true` in **each** profile. A green `cargo test` is not proof of deployed WSS authentication, native-validation parity or three-agent DHT convergence.

**P0 outcome (real HWC browser CI 44165999414):** HWC Lair host identity and reload stability **PASS**; real host-bound WASM/hApp rebuilt and hash-verified **PASS**; HWC install API acceptance **PASS**; installed cell agent and DNA hash consistency **PASS**; first `game::get_game_state` real WASM call **FAIL** with `holochain_wasmer_guest` deserialization of byte `192` (`0xC0`, MessagePack nil). Coordinator `init`/CapGrant persistence and actual WASM `dna_info_v2` **NOT PROVEN**, authorized lobby creation **NOT RUN**, independent guest authorization/DHT/reconnect **NOT RUN**. CI HWC identity is ephemeral and therefore **NON-DEPLOYABLE**; operator-held persistent host key remains **NOT CREATED**. Keep PR #4 **Draft**.


### Server-only authenticated H2HC configuration example (not yet exercised against browsers)

Run **only** the reviewed Agent 3 *patched* linker binary after establishing its source provenance. The pinned upstream `cab242d` binary alone does not include the CI-green Agent 3 security transformations. Preserve the installed executable's SHA-256 and full patched Git diff under operator control.

```bash
# Execute only in the private operator server shell; never in page JS or CI logs.
export H2HC_LINKER_ADDRESS='127.0.0.1'
export H2HC_LINKER_PORT='8090'
export H2HC_LINKER_BOOTSTRAP_URL='https://REPLACE-WITH-PINNED-BOOTSTRAP'
export H2HC_LINKER_KEY_FILE='/var/lib/h2hc/imposter-linker.key'
export H2HC_LINKER_SESSION_STORE='sqlite:///var/lib/h2hc/imposter-sessions.db'
export H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK='false'
export H2HC_LINKER_JOINING_SERVICE_URL='https://REPLACE-WITH-JOINING-SERVICE'
export H2HC_LINKER_PUBLIC_URL='wss://REPLACE-WITH-TRUSTED-LINKER-DOMAIN'
# Input secret interactively or inject from a secret manager; no secret in shell history.
read -r -s -p 'H2HC server ADMIN secret: ' H2HC_LINKER_ADMIN_SECRET
printf '\n'
export H2HC_LINKER_ADMIN_SECRET
# Use the actual pinned+patched binary path from the reviewed build (not upstream).
sha256sum /opt/h2hc-patched/bin/h2hc-linker
/opt/h2hc-patched/bin/h2hc-linker
```

`H2HC_LINKER_JOINING_SERVICE_URL` and `H2HC_LINKER_PUBLIC_URL` **must be set together** at the pinned revision; for the operator-ready path above we require both. The `wss://` public address must terminate TLS at a trusted proxy, while `127.0.0.1:8090` binds the linker only on loopback. Use a protected writable directory for the linker identity and SQLite sessions, and do not commit a private-key file, bearer token, joining invite token, or server secret. Confirm network bootstrap and joining-service authorization under the *patched* binary before enabling guest connections. A real linker `authenticated` indication without cross-agent DHT validation is still **NOT** evidence that P0 multiplayer passed.


### First actual Imposter WASM failure — reproducible HWC handoff (17 Nov 2026)

**Exact executed workflow:** [Agent 4 real Chromium HWC run 44165999414](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44165999414), commit `bb49566f19fb9a5a2d1fce52b4e950fcb23b9210`. Failed job `134332086677`; the job log, `runtime-evidence.json`, `hwc-runtime-smoke.log`, original pinned HWC diff, extension build log, real WASM build log, and `ephemeral-deployment.json` are included in [evidence artifact 14366785171](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44165999414/artifacts/14366785171). The runner uses the original unmodified Imposter Rust zomes and Agent 2's exact CI-green patched HWC kit `a892a3c0b3141f0ffe9daf868cce4e8e29af2efc`.

| First-cell gate | Actual outcome |
| --- | --- |
| Headed Chromium loads real patched HWC extension | **PASS** |
| `connect()` mints/returns an HWC-owned Lair key and reconnect keeps it | **PASS** |
| `browser-poc-build.sh` compiles **both real WASMs**, packs host-bound DNA and hApp | **PASS** |
| `browser-poc-verify.sh` and real `hc dna hash` | **PASS** |
| `installApp()` returns, `appInfo()` provides provisioned cell | **PASS (API acceptance only)** |
| Installed cell's 39-byte agent key equals original HWC host key | **PASS** |
| Installed cell DNA hash equals native computed hash | **PASS** |
| `game::get_game_state` executes successfully | **FAIL** |
| Source-chain `InitZomesComplete`, private `CapGrant` persistence | **BLOCKED: no independent trace / inspector** |
| Actual WASM `dna_info_v2` effective seed | **BLOCKED: no read-only probe** |
| Host `create_lobby` with genuine seed | **NOT RUN (stop on first WASM failure)** |
| Unauthorized guest lobby attempt | **NOT RUN** |
| Authenticated three-profile DHT convergence / reconnect | **NOT RUN** |

Exact stop error from the **real** `window.holochain.callZome({zome_name:'game',fn_name:'get_game_state',payload:null})` call:

```text
game::get_game_state: Zome error: {"module_path":"holochain_wasmer_guest","line":246,"error":{"Deserialize":{"0":192}}}
```

Byte `192` is `0xc0`, MessagePack nil. This indicates deserialization failure at the guest boundary; **it does NOT, by itself, identify which host function/callback, initialization stage or type rejected the nil byte**. Do not change the Rust zome to mask it. Agent 2 should trace the first guest invocation and its host/guest MessagePack input/return bytes, `init()` ordering and `CapGrant` storage using the pinned HWC patched checkout and real WASMs. Preserve the already-passing identity, install metadata and exact DNA hash. Stop at the earliest failing function; fail closed.

**Ephemeral, real HWC-generated host key for this exact run (public only):**
`uhCAkCTrM1BlKW19juwch6qXBdiYYkPcZM52Pzz5nejAqnGzlwY6D`.
Host-bound seed:
`g1.uhCAkCTrM1BlKW19juwch6qXBdiYYkPcZM52Pzz5nejAqnGzlwY6D.8cec78124387a2d1463d797a1273c5b3`.
Native DNA hash:
`uhC0kcbNWJurCTpYKnU5pQj0dgAu6a9pf11wMw6VH8qyGvgetmmqW`.
hApp SHA-256:
`e86af83bd8b73981d8facaa95bc018da55b7081a1583096869a523052dceb991`.
Both real WASMs have the already-known unchanged package hashes (`game` `a17a75cdf1c3dcfd6788885f34505dd96cfcba78f46e8b9acbd1e9dd12858c4a`, `game_integrity` `42f633a760cf252fa835474105070d5fb5071865c8c6e52ce2de39e71f07676f`). `deployment_ready:false` and `host_identity_source:EPHEMERAL_HWC_BROWSER_PROFILE`. **No hApp from this ephemeral CI keystore may be presented as a deployable operator-host bundle.**


### Latest three-browser migration and native handoff (17 November 2026)

Agent 4's separate three-profile CI now pins browser-tested issue-#7 HWC kit `e72340c018b1353c6d403de83f1f89e9ca8829f6` against unchanged upstream `0c391226e78769d44ccb4661881ed8998b15f903`; the workflow fails if SQLite `(cell_id,entry_hash)` migration, `DirectSQLiteStorage` conflict handling, or IndexedDB composite entry key are missing. Each runner rebuilds its own **CI-only** Chrome extension, never using prior distribution artifacts. Agent 2's [headed production browser acceptance 44191974895](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44191974895) independently proves two authentic Lair-signed same-hash CapGrants in one OPFS survive restart and stay isolated. Issue #7 is complete.

Agent 3's [two-native run 44192859072](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44192859072) reported current native storage arcs FULL and H2HC `queued=2,published=2,failed=0`. These are transport observations, **not** a native validation verdict or separate guest retrieval. Keep all genuine B/C discovery, join, convergence and seat recovery gates BLOCKED until Agent 3 supplies same-DNA `ValidationStatus::Valid` plus independent authenticated non-null GET of exact Lobby action. Preserve operator-controlled origin/profile and never upload Lair or H2HC secrets. CI bundles remain `deployment_ready=false`.
