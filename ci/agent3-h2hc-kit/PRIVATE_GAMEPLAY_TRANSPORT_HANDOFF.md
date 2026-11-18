# Agent 3 — corrected H2HC executable and private gameplay transport handoff

**Status (18 Nov 2026):** completed native-DHT and revocation investigations remain accepted. **Private role transport is DESIGN ONLY / NOT ACCEPTED**; the inbound HWC handler and H2HC arbitrary remote calls/signals intentionally remain disabled. PR #6 stays Draft.

## A. Executable source-of-truth and Agent 4 handoff

| Field | Provenance / required invariant |
| --- | --- |
| Upstream H2HC | `Holo-Host/h2hc-linker@cab242d32c988fe5e4e9fd06ebc82ed043541aa2` |
| Imposter test kit | `ci/agent3-h2hc-kit/{part00,part01,part02}.b64` joined/decoded; tar.xz SHA-256 `afcf5c406b6b6040ac00060d31052a9eaa121c5b8540ca6a7354898b6752be62` |
| Transformations | `agent3-h2hc-patches/run_security_checks.sh --apply-only` from decoded kit; compiler fixes in `.github/workflows/agent3-h2hc-runtime.yml`; `apply_rust_regression_fixes.py`; `apply_revocation_patch.py`. All against pinned checkout, without changing upstream. |
| Fully patched runner-local H2HC git commit | `09df766ee2a596a6f36c46ffa9c4d07588bedb82` (generated in CI, **not** an upstream branch commit) |
| Successful compiled/revocation-verified run | [44274859411](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44274859411), artifact **14413159313**, `agent3-h2hc-authenticated-runtime-44274859411` |
| Executable path **inside the unpacked artifact** | `h2hc-linker-linux-x86_64` (Linux x86_64, not a distributable production identity) |
| Executable SHA-256 | `6c1266de8e22c854068dcdeaeb351cae6de8c70fb20d910bf79cc1fb4af4bb88` |
| Native Holochain positive/negative validation | [44277830577](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44277830577), success, unchanged game validator |
| Agent 4 historical 3-seat run | [44279989174](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44279989174) **SUCCESS for multiplayer** but `44165793922` was its H2HC artifact; **this does not prove corrected gateway compatibility**. |

**Download and verify (restricted CI/service account):**

```bash
gh run download 44274859411 -R ConorTttttt/imposter-holochain \
  -n agent3-h2hc-authenticated-runtime-44274859411 -D ./verified-h2hc
cd ./verified-h2hc
sha256sum --check SHA256SUMS
printf '%s  %s\n' \
  6c1266de8e22c854068dcdeaeb351cae6de8c70fb20d910bf79cc1fb4af4bb88 \
  h2hc-linker-linux-x86_64 | sha256sum --check
test "$(sed -n 's/^SOURCE_H2HC=//p' build-provenance.txt)" = 09df766ee2a596a6f36c46ffa9c4d07588bedb82
test "$(cat h2hc-applied-source-commit.txt)" = 09df766ee2a596a6f36c46ffa9c4d07588bedb82
chmod 0755 h2hc-linker-linux-x86_64
```

`SHA256SUMS` verifies **the binary**; the GitHub Actions artifact digest refers to the **ZIP**, not the executable. Also validate expected artifact ID/name, original run and H2HC patch source, not just a self-provided checksum. Do not replace this executable with `44165793922`.

A separate replay workflow `.github/workflows/agent3-h2hc-secure-multiplayer-replay.yml` pins Agent 4's accepted **source** `a9bfedd5b76edf5d3103c9fcf7a39de117b652c8` and Agent 2 HWC kit `bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39`, but downloads **corrected** run `44274859411` and checks BOTH the literal executable SHA and applied H2HC source SHA. Its result is a separate CI gate; changing the YAML alone is **not a pass**. Agent 4 should independently repin their own workflow and capture a passing new run before marking their branch accepted on the corrected gateway.

**Production-style configuration:** `H2HC_LINKER_ADDRESS=127.0.0.1`, `H2HC_LINKER_PORT=8090`, `H2HC_LINKER_ALLOW_INSECURE_DEV=false`, `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false`, persistent chmod-0600 `H2HC_LINKER_KEY_FILE`, operator-generated 32-byte-random `H2HC_LINKER_ADMIN_SECRET` outside the repository, reachable compatible `H2HC_LINKER_BOOTSTRAP_URL` and `H2HC_LINKER_RELAY_URL`. Use HTTPS/WSS at a trusted TLS terminator for remote browsers, protect admin endpoints separately (no public admin access), do not ship CI ephemeral Lair/identity files, tokens, keys or bootstrap test infrastructure as a production service. See `secure.env.example` and `RUNTIME_RUNBOOK.md`. Gate startup on a bound loopback address, signed challenge/agent allowlist, registered **exact DNA**, and test that `/api/{dna}/{zome}/{fn}` and `/test/signal` return 404.

## B. Current architecture: explicit blockers, not workarounds

- Holochain coordinator `game::deal_roles` saves **private** `SealedRoles`, publishes **public** `RoleCommit`, then calls `send_remote_signal(GameSignal::RoleDealt)`; `game::request_role` calls `call_remote(host, game, provide_role, ...)`; `provide_role` reads `call_info()?.provenance` to select a caller's seat. **Neither remote mechanism is supported securely today** by the HWC/H2HC bridge.
- Agent 2's accepted HWC security patch deliberately **rejects all linker-delivered remote signals**: old code trusted unverified `from_agent` / inner `provenance` and fell back to local author on parse failure. This rejection is **essential** until authenticated caller provenance can be injected and enforced in the HWC WASM executor. See `compatibility/hwc-imposter-compatibility/AGENT3_SECURITY_HANDOFF.md` on Agent 2's branch.
- `recv_remote_signal(RoleDealt)` currently checks a Merkle opening but **does not bind the delivered seat to `me()`, the sender to the lobby host, or the commitment's seats before emitting `YourRole`**. This is a required coordinator hardening change before accepting even signed inbound roles. Merkle validity alone does not authorize recipient disclosure.
- `init` creates an unrestricted (`CapAccess::Unrestricted`) *listed-function* grant including `recv_remote_signal` and `provide_role`. This is not a recipient-scoped or transport capability. Explicit, independently enforced local grants and provenance checks are required. Native integrity validation cannot by itself validate the privacy of a transient message.
- The host-side `DealResult.roles` intentionally contains all roles; never send it over a public getter, generalized remote result, DHT or logs. `RoleCommit` (root/seat order) is public, `SealedRoles` stays private and its role leaves must remain non-DHT.
- Role delivery can fail **after** the commitment is written because the existing `deal_roles` emits signals at the end. Re-delivery must be idempotent, targeted and recoverable without generating a new RoleCommit or revealing the host secret.

## C. Proposed minimal permitted transport (not enabled)

**Only two message classes initially:** `role_request_v1` (seated player → host; no secret, for recovery) and `role_delivery_v1` (host → **one** committed-seat recipient; encrypted role, proof). No generic remote zome execution, no raw signals, no `/api/{dna}/{zome}/{fn}`, no unvalidated local-authority DHT shortcuts. Tasks, sabotage, kills and other gameplay types remain disabled until separately reviewed.

1. **Identity + installed cell:** both sides authenticate through the existing H2HC signed challenge. Every frame explicitly includes canonical `dna_hash` (exact Holochain 39-byte DNA hash) and `sender_cell=(dna_hash,sender_agent)`, `recipient_cell=(dna_hash,recipient_agent)`; H2HC checks the authenticated socket, allowlist, active session, both registered DNA memberships, and exact sender match. HWC independently checks installed app/cell and **local** Lair-held recipient, never outer `from_agent` alone. No wildcard DNA, other-cell remapping or substitution of a ChainAuthor grant.
2. **Function permissions:** extend server capabilities with **distinct** operator-granted `game_role_request` and `game_role_deliver` (not a generic `remote_call` or `signal`). Both H2HC and HWC allowlist exactly `game` / `role_request_v1` and `game` / `role_delivery_v1`, and the HWC executor checks actual local Holochain zome grants/provenance. The host is taken from the accepted public Lobby author, recipients from the accepted `RoleCommit.seats`, and remote `provide_role` must run **as the authenticated caller**, never as host/ChainAuthor.
3. **Cryptographic envelope:** version 1 contains domain, message type, 39-byte DNA, both 39-byte agents/cells, **RoleCommit action hash**, `seat`, `key_id`, 128-bit random nonce, issued/expiry time, operation ID, and encrypted payload (role + existing `RoleProof`). Canonical serialized fixed-field byte vector and distinct domain separator must be signed using pinned Holochain 0.7/Lair Ed25519 agent signing; validate signature over **all** immutable metadata + ciphertext with the agent key core and verified HoloHash. Agree exact vectors with Agent 2 before implementation; never sign ambiguous JSON or trust a sender string.
4. **Confidentiality:** recipient enrolls a **cell-scoped** X25519/HPKE public encryption key; its binding to `(DNA,agent,key_id)` is signed by that Lair identity and verified by host. Host encrypts for **exactly one** recipient using an audited HPKE profile (e.g. RFC 9180 X25519/HKDF-SHA256/ChaCha20-Poly1305); bind header/recipient/commit into authenticated associated data. Private key stays in local HWC protected storage, not H2HC, HTTP payload, logs or public DHT. Never infer an encryption key from a Holochain Ed25519 public key without a reviewed, supported conversion. A malicious gateway/operator must see only ciphertext and routing metadata. Key enrollment/substitution, cross-cell keys, restart persistence and rotation need dedicated tests.
5. **Delivery/recovery:** before delivering, HWC verifies host=actual committed lobby author, recipient=`me()`, `RoleCommit.seats[seat]==me()`, root Merkle proof, role commitment action hash, current game round, exact DNA, signature and freshness. Recipient **persistently** records `(sender,DNA,recipient,commit,nonce)` in a transaction **before** local one-time application; duplicates rejected across reconnect/restart. Recovery requires an authenticated `role_request_v1`; host independently resolves requester's seat and makes **new ciphertext with a new nonce** only to that requester. No public reusable role GET or server replay mailbox.
6. **Revocation:** H2HC checks authorization and registered active recipient/sender **again at dispatch**; revoke closes all sessions and drops/invalidates pending deliveries, denies stale tokens and sender replay, preserves unrelated agent sessions. HWC disconnect clears session-affiliated send state; future fresh auth does not resurrect old epochs, ciphertext or cached delivery. Persisted idempotency survives restart and reauthorization; changed encryption key requires fresh binding and re-delivery from the host. An offline host makes recovery unavailable, not insecurely available.
7. **Native integrity:** keep DHT publishing as source-signed native Holochain 0.7 ops and retain the unchanged `game_integrity` validator. Confidential messages are **not** DHT ops, not substitutes for validated RoleCommit/Lobby, and not authority to forge native entries. An accepted HTTP 200 for any future message must never be described as native app-validation acceptance.

**HWC interface to agree with Agent 2:** a restricted internal extension API `sendPrivateRole({cell_id,recipient,role_commit,seat,proof,role})` from a trusted coordinator execution path, and `onVerifiedPrivateRole({cell_id,from,role_commit,seat,role,proof})` only after cryptographic/session/cell checks. A parallel `requestPrivateRole({cell_id,role_commit})` is a **restricted** recovery operation. None is exposed as a generic public webpage method or an arbitrary zome function caller. The necessary native signal/call hooks and provenance integration are **not yet implemented**. Exact typed wire vectors and event lifecycle require Agent 2 review.

## D. Threat model and required acceptance

| Threat | Required proof (must be negative when unauthorized) |
| --- | --- |
| Guest B steals Guest C's role | authenticated B cannot read C's ciphertext/key, cannot address B's envelope to C, cannot decrypt C's HPKE ciphertext, and cannot invoke `provide_role` as C. |
| Spoofed host or forged `from_agent` | valid Ed25519 signature checked against the exact host agent, host verified as Lobby author, and HWC local `call_info().provenance` genuinely matches authenticated sender. |
| Replay/rollback across restart | duplicate `nonce + commit + sender + recipient` fails, including after persistent storage restart; stale round/time/key/version fails. |
| Cross-DNA/cross-cell confusion | any different installed DNA, recipient agent or cloned cell, even with the same seed or public commitment, fails before decryption/execution. |
| Capability misuse | non-role zome/function, wrong operator capability, wrong caller grant, generic signals/calls all denied by default. |
| Admin revocation races | queued-but-undelivered message dropped on revoke; two sockets closed, both old bearer tokens 401, other player unaffected, no replay on reallowlist. |
| Gateway/operator network observer | TLS/WSS **and** end-to-end encryption; gateway sees no role/proof plaintext. Host, recipient, compromised browser/host or corrupted UI are outside this confidentiality guarantee. |
| Malicious commitment/role proof | only public native-validated RoleCommit accepted; role proof verified for the **recipient's** exact seat, no reliance on transport ACK to prove game validity. |

### Test status and stop conditions

- **PASS, independent existing suites:** signed HWC/H2HC auth, source-signed DHT ops and native positive+negative validation, server two-socket revocation, old bearer rejection and unrelated-agent isolation (runs above). Agent 2's real Chromium revocation acceptance is separately reported.
- **Targeted interim integration regression:** `ci/agent3-h2hc-kit/network-probe.mjs` now tests that **both authenticated A and B** receive 404 for GET/POST of the legacy `game/provide_role` route and both receive an error on `send_remote_signal`. It proves the legacy private-role surface stays **closed**, **not** that roles can be delivered.
- **Corrected-binary real multiplayer replay:** `.github/workflows/agent3-h2hc-secure-multiplayer-replay.yml` requires a completed successful CI execution before claiming accepted. Do not infer from source checks alone.
- **BLOCKED, positive private-role E2E:** no approved HWC verified remote caller/provenance path, no encrypted recipient-key enrollment or ciphertext transport, no durable HWC replay cache, and coordinator `recv_remote_signal` missing recipient/host checks. **Do not enable even a test-only plaintext production route** to manufacture a PASS.

**First future positive test** (new, independently reviewed HWC/H2HC code): create host A, genuine guest B and C on the same native-validated DNA and committed three-seat lobby; host deals a single `RoleLeafResp` to B encrypted to B's enrolled cell key; B verifies signature/commit/own seat/Merkle proof and sees its own role, C never receives or decrypts B's payload. Attempt B→C impersonation, C request for B, another DNA, replay twice (including browser restart), revoke B with a pending message, reauthorize with fresh session, and confirm no old ciphertext delivery. Pass only if all positive AND negative checks pass; sanitize all evidence to booleans/hashes, never role values/proofs/keys.

**Final decision:** do not ship or enable remote gameplay until HWC receiver and caller-provenance bridge, cryptographic key binding, coordinator authorization hardening and combined Chromium+native negative tests are independently accepted. Keep PR #6 Draft.
