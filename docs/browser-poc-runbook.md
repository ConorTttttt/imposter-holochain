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
