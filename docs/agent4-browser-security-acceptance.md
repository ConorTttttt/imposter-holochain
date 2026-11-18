# Agent 4 — revocation-secure browser lobby acceptance

> Current snapshot: 18 November 2026. Do not infer that a checked-in CI harness
> is a deployable release. HWC/Lair test keys are ephemeral and discarded.

## Provenance (independently checked)

- Corrected H2HC artifact: `agent3-h2hc-authenticated-runtime-44274859411`,
  GitHub Actions run [44274859411](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44274859411),
  artifact ID `14413159313`.
- ZIP digest: `sha256:c9af3f19ba5b7abbae5cbb0c9a8c6ac4b5f7046d8585bbbbbdb293f4bcf7d7a5`.
  Independently recomputed from the downloaded artifact archive.
- **Executable** digest: `sha256:6c1266de8e22c854068dcdeaeb351cae6de8c70fb20d910bf79cc1fb4af4bb88`.
  Independently recomputed by streaming `h2hc-linker-linux-x86_64` from the artifact;
  the embedded `SHA256SUMS` agrees. The multiplayer workflow hard-codes this
  expected digest, not merely an in-archive self-check.
- Embedded `SOURCE_H2HC=09df766ee2a596a6f36c46ffa9c4d07588bedb82`
  equals `h2hc-applied-source-commit.txt`.
- Embedded `SOURCE_IMPOSTER=03e116ea6f59d88248096ac7dee2f653ded26e60`.
  The source workflow builds the security-patched executable from pinned upstream
  `Holo-Host/h2hc-linker@cab242d32c988fe5e4e9fd06ebc82ed043541aa2`.
- Accepted Agent 2 HWC patch unchanged:
  `bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39`.
  HWC upstream unchanged:
  `0c391226e78769d44ccb4661881ed8998b15f903`.
- New multiplayer run: [44287572823](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44287572823).
  **Status at writing: in progress**. No result is accepted until the
  final multiplayer/Chromium evidence actually exists.

## Acceptance matrix — provenance must be kept separate

| Gate | Result and authority |
| --- | --- |
| Three independent Lair/HWC browser agents | **PASS historic** in [44279989174](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44279989174) with **older gateway**. Await corrected-gateway rerun. |
| Signed authenticated H2HC sessions and matching DNA registrations | **PASS historic** in 44279989174 with **older gateway**. Await corrected-gateway rerun. |
| Native validated host Lobby (exact action / three DhtOps) | **PASS historic** in 44279989174; rerun pending with corrected gateway. |
| Genuine B and C `join_lobby`, native acceptance of both | **PASS historic** in 44279989174; rerun pending with corrected gateway. |
| Identical three-player state and stable seat order | **PASS historic** in 44279989174; rerun pending. |
| B full Chromium process restart / original seat and join action | **PASS historic** in 44279989174; rerun pending. |
| Host full Chromium process restart / original shared lobby | **PASS historic** in 44279989174; rerun pending. |
| Gateway revocation/forced websocket disconnect and reauthentication | **PASS independent Agent 2** in [44276837211](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44276837211), artifact `lifecycle-gates.json`. **Not executed by the multiplayer workflow.** |
| Original native game integrity rejects forged invalid-host lobby on a separate native authority | **PASS independent Agent 3** in [44277830577](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44277830577), gate `NATIVE_INTEGRITY_INVALID_LOBBY_REJECTION`. **Not executed by the multiplayer workflow.** |
| True bearer token expiration | **NOT RUN** in Agent 2 lifecycle evidence; disconnect/revoke is not expiry. |
| Player-facing `ui/browser-demo.html` host create, B/C joins, names/seats and recovery | **New CI test pending**; must succeed on independent real persistent Chromium profiles; do not equate code presence to acceptance. |
| Existing desktop `ui/src/main.ts` and `ui/src/holochain.ts` browser HWC route | **NOT INTEGRATED**: uses desktop `AppWebsocket`, dynamic clone cells and public room registry, not the existing pre-provisioned one-DNA HWC harness. |
| Operator-retained signing identity, TLS/WSS and trustworthy release | **NOT RUN**: CI-created identities and bundles are destroyed, `deployment_ready=false`. |
| Full round, role privacy, host presence and movement | **BLOCKED** on disabled remote signals/calls and untested PeerKit/browser gameplay. |

### Current operator-provisioned browser page

`ui/browser-demo.html` is a deliberately minimal **lobby-only** UI. The CI
harness serves it at `/browser-demo.html` from the same origin as the
hash-verified host-bound `deployment.json` and provisioned hApp. It uses only
`window.holochain.connect`, `appInfo`, `getConnectionStatus`,
`getNetworkStatus`, and the original `game::{get_game_state,create_lobby,join_lobby}`.
Host creates via a button, guests type the exact code and join through a button;
it renders three named seats. The test script reads the *public signed action*
returned by the click, derives native operation hashes, and preserves the
existing independent validation checks. There is no player secret in a
public DHT document, and no console invocation is required to play the
pre-provisioned lobby scenario.

**Provisioning is not self-service.** Before opening the page, an operator
must authorize each distinct Lair agent in H2HC and install the same
verified host-bound hApp in each profile. Exact `g1.<host key>.<nonce>`
network seed is used as the code in this laboratory page. The current
4–32-character friendly room-code registry / clone-cell desktop UI is **not**
equivalent to this host-bound deployment. Bridging production code-based
discovery to immutable DNA deployment requires separate design and acceptance.

## Full-round transport handoff — Agents 2 and 3

Existing coordinator calls that depend on disabled or unsupported remote
transport (consult `dnas/game/zomes/coordinator/game/src/lib.rs`):

- `deal_roles` and `resend_role` send *private* `RoleDealt` signals;
  `request_role` performs `call_remote(provide_role)`. The host's private
  `SealedRoles` entry must stay private, and recipients must only obtain their
  own role leaf plus public commitment proof.
- `my_tasks` performs `call_remote(provide_tasks)` for private per-player tasks.
- `cut_lights`, `cut_comms`, `close_doors`, `start_crisis`
  depend on targeted host remote calls and native authorization.
- `host_online` depends on `call_remote(ping)`.
- `recv_remote_signal` processes `RoleDealt` and `Killed`, with a role proof,
  but secure delivery and correct sender/recipient binding must be tested.
- Other in-game public consensus writes must remain under original native
  validators, and movement/voice via PeerKit requires separate browser testing.

**Agent 2 acceptance request:** design a narrow HWC API for authenticated,
revocation-sensitive, DNA-scoped *recipient-specific* remote requests/signals.
Bind caller key, target key, DNA, function name, session/revocation epoch,
message nonce and expiration to every request. Require exact function allowlist
and caller-permission checks. Reject cross-DNA, wrong target, replay, changed
sender, and revoked sessions, and test *real* two-/three-browser lifecycle.
No blanket remote `callZome` forwarding or broad capability proxy.

**Agent 3 acceptance request:** supply server-side H2HC routing of only
allowlisted authenticated remote functions/signals without exposing an
arbitrary execution endpoint. For role/task delivery, implement recipient-only
confidentiality even against an untrusted relay (end-to-end encrypt the
per-recipient payload), authenticate the host and bind the ciphertext to the
specific recipient and RoleCommit. Enforce timeouts, rate limits and
revocation cancellation. Test private-leaf recovery after missed signals,
wrong-recipient rejection and native integrity outcomes. Security-critical
host actions must still run in the native coordinator and remain validated.

The current `init()` grants unrestricted *listed* remote functions:
before enabling remote transport, review the capability model and the exact
`call_info().provenance` enforcement. Do not ship full-round remote delivery
until both reviews and independent Chromium/native negatives pass.

**Do not** copy any private `SealedRoles` to the public DHT, log bearer
tokens/role leaves, permit arbitrary remote execution, use simulated DHT
records, or weaken native integrity.
