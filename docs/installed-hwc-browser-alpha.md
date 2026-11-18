# Imposter installed-HWC browser alpha

## Verified milestone

Actions run [44345067844](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44345067844) executed commit `94a71b15b345e482b9f96953b419bc2c95432a23` in three independent installed Chromium profiles with distinct Lair identities, two native Holochain 0.7.0 authorities and the pinned authenticated H2HC executable. The host started the round from the browser. All three read the same exact native RoleCommit, and both guests' extensions independently verified and decrypted their own roles. The job recorded gateway enqueue separately from each receipt. Guest C's extension refused B's captured ciphertext. All three displayed their own verified role, and a crewmate clicked **Align Engine Output**. Each browser then observed the existing native crew-win result. The profiles and their keys were ephemeral.

The first passing run isolated the initial B receipt and C's lack of a receipt without granting C the role-request capability. [44340415458](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44340415458)

The role evidence artifact contains public action identities and receipt metadata. Role plaintext, opening proofs, credentials, raw WebSocket traffic and browser profiles stay off the artifact allowlist. [Sanitized evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44345067844/artifacts/14444899021)

## Reproduce the integration test

A relevant push to the dedicated branch starts **Integration - installed HWC encrypted role receipt**. An existing run can also be rerun from Actions. The job checks the accepted gateway's artifact provenance and digest, applies the HWC receiver to the pinned source, builds the exact host-bound native bundle, and runs the three-profile browser demo against two native authorities. The extension has a CI-only observer accessible to its own worker debugger. Build the operator extension without `ci/installed-role/prepare.sh` or `instrument.py`. [Workflow](../.github/workflows/integration-installed-hwc-role.yml)

## Operator-controlled setup

Use a single trusted HTTPS origin for the frontend, manifest and hApp. Each HWC profile creates a site-bound Lair identity. Choose the final origin before generating the host identity. The Actions build uses a loopback test site and dev bootstrap and relay. This operator configuration still needs acceptance on the intended network.

### Build the extension

In a clean Linux workspace with Git, Python 3.11+, Node.js 22 and Nix with flakes enabled, check out the integration branch in `integration/` and HWC in `hwc/`. Use the exact integration commit under review. From their parent directory run:

```bash
git -C hwc switch --detach 0c391226e78769d44ccb4661881ed8998b15f903
kit=integration/compatibility/hwc-imposter-compatibility
python3 "$kit/verify_pinned_sources.py" hwc
git -C hwc switch -c fix/imposter-hwc-compatibility
python3 "$kit/apply.py" hwc --write
python3 "$kit/private-role/apply_restricted_hwc_handler.py" hwc --write
python3 "$kit/private-role/apply_installed_hwc_receiver.py" hwc --write
npm ci --prefix hwc
(
  cd hwc
  npx tsc -p packages/shared/tsconfig.json
  npx tsc -p packages/lair/tsconfig.json
  npx tsc -p packages/core/tsconfig.json
  npx tsc --noEmit -p packages/extension/tsconfig.json
  npm run build:chrome --workspace @hwc/extension
)
```

Use Chromium's **Load unpacked** to install `hwc/packages/extension/dist-chrome` in three separate persistent profiles. Open the intended site origin, approve the origin in HWC and run `await window.holochain.connect()`. The host and guests should each obtain a distinct public agent key. Encode only the public key for operator input:

```javascript
const hc = window.holochain;
await hc.connect();
const publicKey = new Uint8Array(hc.myPubKey);
if (publicKey.length !== 39) throw Error('Expected the installed HWC public agent key');
'u' + btoa(String.fromCharCode(...publicKey)).replace(/\+/g, '-').replace(/\//g, '_');
```

Preserve the same profiles for reconnect and restart.

### Build and serve one real host-bound hApp

Check out the game tree in `game/` at `0f7b17592e682a7b7d77e9346528cba69a096cdc`. From the parent directory run:

```bash
git -C game apply --unidiff-zero ../integration/ci/installed-role/browser-demo.patch
cd game
read -r -p 'Public HWC host key: ' IMPOSTER_HOST_PUBKEY
imposter_seed="$(sh scripts/browser-poc-seed.sh "$IMPOSTER_HOST_PUBKEY")"
nix develop --no-write-lock-file --command bash scripts/browser-poc-build.sh "$imposter_seed"
```

Use the output directory printed by the build. Run `nix develop --no-write-lock-file --command bash scripts/browser-poc-verify.sh <output-dir>`. Record the exact hApp SHA-256, source commit and DNA hash independently. Serve `ui/browser-demo.html`, `<output-dir>/deployment.json`, and `<output-dir>/app/imposter-browser-poc.happ` at the site root. Provision every profile with that same hApp and verify its digest against the operator copy before install. GitHub Pages can serve the static files from a dedicated origin with those root paths. Gateway, admission and native authorities require separate services.

### Start authenticated H2HC and native authorities

- Obtain the Linux gateway from artifact `14428255589` of run `44304976936`. Verify the executable SHA-256 is `8f3f8e0b6a6fc02b27776182458cf0d970bc02f76db9f6f6b6842c04f138746f` and the applied source commit is `9f5eb04b5be12e3e9e7fcc304bd905da1449ade9`. The build recipe is pinned to Imposter source `293563649f7fd18a6bc2e0d1426c31132bf2b8c7`. [Gateway artifact](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44304976936/artifacts/14428255589)
- Use an operator-managed bootstrap and relay, a persistent gateway identity, and server-side admission credentials. Keep `H2HC_LINKER_ALLOW_INSECURE_DEV=false` and `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false`. Expose HTTPS and WebSocket upgrade through the TLS proxy. Keep the admin route on the operator network.
- Run two separate Holochain 0.7.0 conductor instances with the exact same host-bound hApp and the same bootstrap and relay as H2HC. Keep their admin sockets private. The pinned CI topology uses `hc sandbox` with `--target-arc-factor 1` and waits for both conductors to advertise full storage arcs before admitting browsers. [Native topology](https://github.com/ConorTttttt/imposter-holochain/blob/f49b0dfcc9f8b86a3e2abcd48e6c13375c347ed5/ci/agent3-h2hc-kit/instrument_native_authority.py)
- In an operator process, authorize each public agent through `POST /admin/agents` with `dht_read`, `dht_write`, and `k2`. Grant `game_role_deliver` to the host and `game_role_request` to the guests. Browser JavaScript configures the public HTTPS linker base URL via `await hc.configureNetwork({linkerUrl})`. HWC completes the signed challenge and the server confirms the installed DNA registration.
- In each profile, install the verified bytes via `await hc.installApp({bundle, installedAppId:'imposter-browser-poc'})` with `bundle` a `Uint8Array`. Check `appInfo('imposter-browser-poc')` for one enabled cell with the expected DNA and local agent. Check `getConnectionStatus()` for `authenticated` and `wsHealthy`, and `getNetworkStatus()` for `hasSession`. Use the extension's reconnect and the page's **Retry connection** on endpoint or admission errors.

For the gateway process, supply the admin secret via its service secret manager and set the following in the service configuration:

```bash
H2HC_LINKER_ADDRESS=127.0.0.1
H2HC_LINKER_PORT=8090
H2HC_LINKER_KEY_FILE=/var/lib/h2hc/imposter-linker.key
H2HC_LINKER_BOOTSTRAP_URL=https://bootstrap.operator.example/
H2HC_LINKER_RELAY_URL=https://relay.operator.example/
H2HC_LINKER_ALLOW_INSECURE_DEV=false
H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false
```

Replace the example domains with the two endpoints shared by the gateway and native authorities. Configure browser clients with the proxy's public HTTPS base URL. Keep the backend identity and native data directories on protected persistent storage. Recheck authentication, registration, native-valid readback and revocation on the actual deployment before admitting players.

### Play the narrow demo

Open `/browser-demo.html` in each pre-provisioned profile. Have the host create the lobby and the guests join with the same room code. Once all three seats appear, use **Start round**. Each browser waits for its verified local role. A crewmate can use **Align Engine Output**. The host's existing coordinator evaluates the task win and publishes the result for all profiles to read. Full-map play, secret multi-console task assignments and desktop transport need separate integration.

An existing browser profile that joined before the installed receiver was applied needs to perform its normal create or join recovery to establish the protected Lobby pin. Keep the original site origin and profile for persistence. A new host-bound round uses a newly generated seed and bundle. The CI profiles and their host-bound hApp cannot be used as a release.

## Verification and release readiness

| Feature | Current implementation | Verification evidence | Remaining blocker | Priority |
| --- | --- | --- | --- | --- |
| Native lobby, three seats and recovery | Agent 4 host-bound DNA, separate Lair identities and protected exact Lobby pins | Native accepted both exact PlayerJoin operations. All three profiles converged. Host and B recovered their seats after full Chromium restarts. [44340415458](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44340415458) | Repeat against operator bootstrap and relay with durable profiles. | P0 |
| Encrypted role delivery | Native exact RoleCommit, observed key enrollment, fresh signed request, restricted H2HC ciphertext and independent extension decryption/Merkle verification | Native action observed by all three profiles. Gateway enqueue and distinct B and C receipts proved independently. C rejected B’s actual ciphertext. [44345067844](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44345067844) | Operator admission and release packaging. | P0 |
| Receiver and replay boundaries | Worker-only opener, origin-bound own-role read, per-lease correlation, and persistent key epoch/action/replay records | Genuine Chromium popup denial, native Lobby/RoleCommit/seat substitution denial, foreign DNA and wrong commitment frame denial, forged host rejection, replay before and after restart, durable replay reservation, gateway revocation with pending delivery and stale-message denial on reauthorization followed by a fresh verified receipt. The Node suite separately covers bad Merkle proofs, expired attestations and epoch rollback. [44345067844](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44345067844) | Exercise bad Merkle proofs, signed attestation expiry and epoch rollback on installed HWC traffic. | P0 |
| One-task round | Existing native role commit, task list, completion and finish calls with a small browser UI overlay | All three displayed their own verified role. One task completion produced the shared native crew win in every profile. [44345067844](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44345067844) | Repeat on the operator network with retained profiles. | P0 |
| Operator deployment | Pinned builds, manually provisioned HWC browsers, authenticated gateway and native authorities | CI rebuilds the host-bound hApp and verifies the gateway digest. | Run the release candidate on the operator’s HTTPS/WSS domains, test recovery and preserve repeatable artifacts. | P0 |
| Full gameplay and desktop | Existing coordinator and native desktop rules | Current browser harness exercises installed HWC clients only. | Guest `my_tasks` depends on authenticated remote `provide_tasks`; kill and sabotage use other private calls/signals. A genuine cross-client test is outstanding. | P1 |

The separate local checks passed 41 role and storage regressions, 10 patched HWC session and storage regressions, 15 browser packaging checks and three native schema contract fixtures at their original Agent 2 contract pin. The IndexedDB unit cases use a simulator. The compiled-extension popup checks and the three-profile Actions runs use actual Chromium.

## Next implementation steps

1. Expand installed receiver security acceptance in `ci/installed-role/acceptance.mjs`, `ci/installed-role/instrument.py` and `compatibility/hwc-imposter-compatibility/private-role/trusted-receiver.test.mjs`. Accept only a real signed, routed frame for the authoritative seat, DNA and epoch. Exercise a bad Merkle opening, an expired signed key and an older epoch in an installed profile. Assert denial at the relevant check and retain a separate positive receipt on the same topology.
2. Exercise the operator release in `docs/installed-hwc-browser-alpha.md`, `.github/workflows/integration-installed-hwc-role.yml` and the pinned game tree’s `scripts/browser-poc-build.sh` and `scripts/browser-poc-verify.sh`. Produce verifiable extension and hApp build provenance, provision three persistent browser profiles, and repeat the round against operator HTTPS/WSS after a restart. Verify that a revoked identity cannot recover its old access.
3. Add private multi-console task assignment using the pinned game tree’s `dnas/game/zomes/coordinator/game/src/lib.rs`, `compatibility/hwc-imposter-compatibility/private-role/hwc-installed-runtime.mjs` and `ci/installed-role/browser-demo.patch`. Scope the transport to native `my_tasks`/`provide_tasks` semantics and bind the list to its authenticated recipient and exact RoleCommit. Verify independent assignments and a replicated native win with unchanged coordinator rules and revision-2 role bytes.
