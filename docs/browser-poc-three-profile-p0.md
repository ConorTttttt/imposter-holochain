# Imposter P0 — three independent production-browser profiles

**Scope:** Host, Guest B and Guest C execute the original Holochain 0.7 Imposter coordinator under independently owned HWC/Lair keys, using **one host-bound DNA** and **one secure H2HC gateway**. No role dealing, kills, votes, remote calls or remote signals. This is an integration investigation, **not** an operator-deployable hApp release.

## Exact source and immutable evidence

| Component | Source/version | Acceptance scope |
| --- | --- | --- |
| Imposter game build | Repository pinned Rust+DNA inputs, base `111e6a44795e6572ed01191a98245ed723788c12` | Actual `game` + `game_integrity` WASM |
| HWC upstream | `Holo-Host/holo-web-conductor@0c391226e78769d44ccb4661881ed8998b15f903` | Unchanged upstream checkout, locally patched on CI |
| Agent 2 kit | `76ffda33b8c5796a298ce09f3bdbbb668ebd43bb` | Approved HWC hardening; **issue #7 is still open** |
| H2HC upstream | `Holo-Host/h2hc-linker@cab242d32c988fe5e4e9fd06ebc82ed043541aa2` | Verified security-patched binary from run `44165793922` |
| Prior first-cell pass | [Browser run 44175803829](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44175803829) | Real Lair, host-bound install, coordinator, grant, lobby, unauthorized guest, host restart **on older HWC patch** |
| Verified independent auth wire | [Agent 3 run 44176199123](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44176199123) | One actual HWC host accepted into secure H2HC queue; 11 ops, `published=0` |
| Native investigation | [Agent 3 run 44178431806](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44178431806) | `hc-spin` Electron SUID failure; no native authority |
| Native follow-up | [Agent 3 native sandbox workflow](https://github.com/ConorTttttt/imposter-holochain/actions/workflows/agent3-h2hc-native-conductor.yml) | `hc sandbox generate/run` experiment; requires independently verified native integration |

**Identity invariant:** `g1.<host HWC Lair AgentPubKey>.<32 lowercase hexadecimal characters (16 random bytes)>` is minted **after** the host's Lair key exists. All three contexts install identical `.happ` bytes, DNA hash and seed. Three different OS-level browser user-data directories prevent extensions, local storage, OPFS and signing material from being shared. H2HC `auth_ok`/registration logs must each name exactly the corresponding individual public agent and one DNA. A transport queue is *not* native validation.

## Reproducible CI topology

`.github/workflows/browser-poc-hwc-runtime.yml` triggers on this runner and relevant script changes. The preflight job validates the exact helper and existing smoke JavaScript syntax and the existing immutable package tests. The headed job checks out the strict Agent 2 revision, patches a separate pinned HWC tree, instruments only the **ephemeral CI worker** with a read-only chain metadata collector, downloads and verifies the already-built signed-operation H2HC binary, builds the Chrome extension and actual WASMs, starts loopback H2HC, then invokes `scripts/browser-poc-hwc-smoke.mjs`.

The smoke script now invokes `scripts/browser-poc-hwc-three-profiles.mjs` **in the same running process**. It (1) recovers a genuine host identity and packages its DNA, (2) installs the original hApp on the host, (3) allowlists each of the three **public** Lair keys from the privileged Node runner, (4) separately authenticates the host and two freshly initialized guest profiles over the HWC WebSocket client, (5) verifies server-side signed challenge and exact DNA registration, (6) confirms each local source chain has a single hidden-on-the-wire private CapGrant and correctly ordered genesis, (7) rejects Guest B's unauthorized `create_lobby` at the **Rust validator**, (8) creates the real host lobby, (9) restarts **all** Chrome profiles and verifies stable public keys, cell DNA and signed local chain continuity, and (10) inspects only actual H2HC publish counts and independent guest `get_game_state` results. It *does not* inject DHT fixtures or force seats to join while the native authority is missing.

The gateway starts with `H2HC_LINKER_ALLOW_INSECURE_DEV=false`, `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false`, on `127.0.0.1:8090` and official dev bootstrap+relay. The runner creates one random server-side admin credential per run, masks it in GitHub logs and never supplies it to browser page JavaScript. No WS signing secret or H2HC bearer token is logged or copied between profiles. The HWC CI worker probe only reports public action hashes and private-entry **booleans** to the loopback collector. This instrumented extension artifact is **NOT DEPLOYABLE**.

**Artifacts** under `runtime-evidence/`: `runtime-evidence.json` for exact gate classifications/identities, `ci-source-chain-metadata.json` for nonsecret per-cell genesis/action hashes and hidden-private-entry flags, `h2hc-server.log` for server challenge/registration and publication counters, `hwc-runtime-smoke.log` for ordered gate execution, `patched-hwc-diff-stat.txt` for in-run patch provenance, `patched-chrome-sha256.txt` for the ephemeral CI worker build, `h2hc-runtime-binary-sha256.txt` for exact server binary, `ephemeral-deployment.json` for host-bound DNA and hApp digests and build logs. These must be checked **from the same workflow run**, not stitched across destroyed CI identities. The public CI metadata must not include signing keys, private CapGrant bodies or bearer tokens.

## Full acceptance matrix

Statuses below distinguish **historical proven** results from this new three-profile revision. Three-profile browser run [44189760201](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44189760201) **PASSED** the independent Lair/H2HC identity, real coordinator, unauthorized Rust denial, and all three profile restart checks. It did **not** deliver signed ops to a validating native authority: 25 queued / 0 failed / 0 published. Guest B and C each saw no lobby and 0 players. Separate native sandbox run [44188965376](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44188965376) reached only CANDIDATE_RUNNING. Issue #7 remains open.

| Gate | Historic observation | Three-profile revision / completion bar |
| --- | --- | --- |
| Genuine host Lair identity | **PASS** in 44175803829 | Revalidate on Agent 2 `76ffda3` |
| Actual host-bound DNA/hApp and one installed cell | **PASS** | Same SHA-256 and DNA across host, B and C |
| Real `get_game_state` coordinator and private CapGrant | **PASS** in first-cell browser | Per-profile real-wasm read-only worker inspection required |
| Host creates three-seat lobby | **PASS** in first-cell browser | Record native Lobby action hash, fixed seed and DNA |
| Unauthorized Guest B host creation rejected | **PASS** in first-cell browser | Repeat on hardened HWC, before host creates |
| Three independent browser Lair keys | **PASS (44189760201)** | Distinct host/B/C genuine keys and profile paths |
| Three independently signed H2HC WebSocket sessions | **PASS (44189760201)** | 3 separate gateway `Auth OK` + exact own-key/DNA `registered`, twice across restart |
| Signed HWC operation accepted by H2HC queue | **PASS (44189760201)** for 3 real agents, 25 queued / 0 failed / 0 published | Counter separately reports `queued`, `failed`, `published` |
| H2HC operation actually delivered to authority | **BLOCKED** | `published>0`, receiving native peer/ack logged; transport only |
| Native 0.7 validation | **BLOCKED** | Same DNA, nonempty arc, `ValidationStatus::Valid`, exact action hashes |
| B independently retrieves host lobby | **BLOCKED** | Authenticated HWC B nonnull same record, proven DHT authority source |
| B join, C join | **NOT RUN** | Two separate real zome writes, network-received action hashes |
| All three observe same three-seat lobby | **NOT RUN** | Identical lobby action ID, seed, players and join hashes independently |
| Host + B + C Chromium restart | **PASS (44189760201)** | Stable Lair keys, source-chain continuity and same cell; strict post-restart source-chain probes rerun in next revision |
| Reconnecting guests recover existing seats | **NOT RUN** | No new join action, same seat/agent after restart |
| Private grant is hidden from outgoing record conversion | First-cell worker **PASS** | Per-cell production worker read-only checks |
| Same-entry-hash multi-cell SQLite/IndexedDB migration | **BLOCKED: issue #7** | Agent 2 approved transactional migration, identical private grant bytes in headed Chrome+Firefox |
| Private bytes absent from retry queues/network and logs | **NOT PROVEN END-TO-END** | Strict nonsecret scan and actual gateway/worker trace |
| Remote calls/signals | **DISABLED (required)** | Must remain disabled |
| Genuine operator-held signing identity/hApp | **NOT RUN** | Complete procedure below using *persistent* operator profile |


### Actual three-browser evidence / known status discrepancy

In [successful integration run 44189760201](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44189760201), all three HWC/Lair identities were distinct public keys: host `uhCAk2reni2CRsWpr4rjIZZJOWq_pfrHvTGmcs_9sfT0DAT4G-13L`, Guest B `uhCAkabjLuICy-LI2aWvBYNpIcNghHwKSP04vtmChgN3lnU6JnWPQ`, Guest C `uhCAkQWDCpvRsDDl9IgelOffvSpj6zvpnwZeYspoaCcMKo5Euxw1U`. They shared the actual installed DNA `uhC0kmmnz38exDaBpV3RKgvQ4Y7EKV-iZqZQfEm-947N_64Qva1Cu` and hApp SHA256 `f1dacc8937b8c259d2c18aeb09b70a0bba60ae5a814e95e13a75e75e89b9f9f8`. The native host's public Lobby Create action from real WASM was `uhCkkTn0mLEUKe0Csn_gSOho7t09CxUffLqIkHWyZiP8OQ_tjsgNS`, source-chain sequence 5. No guest was able to retrieve this action or join; do **not** present it as converged lobby state. The CI identities and host-bound bundle are destroyed/undeployable.

All three browsers showed `getConnectionStatus().authenticated=true` and their own H2HC signed challenge/registration, but HWC's `getNetworkStatus().hasSession=false` for **all three**: this is an independently reported background-status defect candidate for Agent 2, *not* server-side authentication failure. The downloaded gateway log contained no instances of the explicit private-grant strings `remote-signals`, `recv_remote_signal`, `CapGrant`, or an HTTP `Bearer ` value; this is a bounded log inspection, **not a proof about all network bytes or retry queues**. Source-chain probes show each private CapGrant hidden in the DHT record conversion, but same-hash worker collision tests remain BLOCKED on #7.

## Operator-held deployment procedure (separate from CI)

1. On an operator-controlled, fully patched workstation create a dedicated Chromium **persistent profile** with full-disk encryption, OS account isolation and locked-down filesystem access. Install only an owner-reviewed, **un-instrumented**, production-reviewed HWC extension. The CI-only worker probe and its extension ZIP must never be used for deployment.
2. Pick and permanently record the exact trusted HTTPS page origin. From that origin call `window.holochain.connect()` and record **only the public 39-byte HWC/Lair AgentPubKey**. Quit and fully restart Chromium, return to the exact origin and verify the public key has not changed. Securely back up the encrypted *complete* profile/Lair keystore by an operator-approved procedure; test a restoration **offline**, do not extract/export keys into CI, git, public artifacts or chat.
3. On an authenticated, pinned Holochain 0.7 build machine run `sh scripts/browser-poc-seed.sh "$HOST_HWC_KEY"` using that retained key, then `bash scripts/browser-poc-build.sh "$SEED"`, followed by `bash scripts/browser-poc-verify.sh "target/browser-poc/<tag>"`. Check `deployment.json`, `dna/dna.yaml` and `app/happ.yaml`: same `g1` seed, host public key, role-installed DNA hash, actual native `hc dna hash`, and hApp SHA256. A newly minted host/profile requires a **new** host-bound build.
4. Independently review and sign release metadata with an operator release-signing key. Treat build output `signature_status: UNSIGNED`, `deployment_ready: false` and CI-produced archives as **not approved for deployment**. Store final release metadata and bundle behind a trusted HTTPS origin with access controls, and log its immutable checksum. Never reuse an ephemeral CI bundle: its host's keystore is gone.
5. Deploy the independently security-reviewed Agent 3 H2HC executable behind TLS/WSS. Keep insecure development auth and local-authority fallback false. Provision the host and two other genuine public agent keys through the protected admin/joining process; server secrets remain server-only. Configure native Holochain 0.7 conductor(s) using the same DNA, bootstrap and relay and nonempty storage arcs. Obtain a native validation verdict and independent read receipt **before** allowing guests to join.
6. Give Guest B and C their own OS/Chrome profiles and Lair identities, each retrieving the **same verified bundle**. Confirm installed DNA and individual signed H2HC connection, execute B's negative host-authorization test, then host creates, B joins, C joins, each reads the lobby. Compare the authoritative Lobby and PlayerJoin action hashes across all profiles and server/native logs, not just UI labels. Restart each profile and prove seats reappear with the same keys and **no duplicate join actions**.
7. Do **not** treat the process as production-multicell secure until Agent 2 resolves [issue #7](https://github.com/ConorTttttt/imposter-holochain/issues/7) and the exact migrated production worker has headed Chrome/Firefox collision, redaction, replay/retry and persistence checks. Remote calls and remote signals remain off. PR #4 stays **Draft** pending validated DHT convergence.

**Stop-on-failure:** no fabricated DHT returns, no synthetic authority records, no shared browser storage, no bypass of signing/origin/authorization, no private-key export, and no PASS for skipped DHT-dependent gates.
