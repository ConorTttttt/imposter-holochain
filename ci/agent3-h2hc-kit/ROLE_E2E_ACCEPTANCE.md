# Agent 3 — encrypted host-to-guest role integration handoff

**18 November 2026. Gateway-only and new integration components are being independently exercised; end-to-end browser role delivery BLOCKED.** Draft PR #6 remains Draft. No formal revision-2 protocol freeze or runtime activation is authorized. The accepted signed transcripts, key-epoch binding and HPKE bytes have not been modified.

## Exact source/artifact pins

| Component | Immutable reference |
| --- | --- |
| Agent 3 original integration HEAD | ef5dc9c8bc13dc049ef9a113a0919b1da818e2d2 |
| Agent 3 expanded component workflow | 9930c375111af341d82421e23b56a64c2cf0db23 — run 44318787413 (running when recorded) |
| H2HC upstream checkout | cab242d32c988fe5e4e9fd06ebc82ed043541aa2 |
| H2HC generated/verified source | 9f5eb04b5be12e3e9e7fcc304bd905da1449ade9 |
| Imposter source responsible for gateway build | 293563649f7fd18a6bc2e0d1426c31132bf2b8c7 |
| Gateway CI run, artifact ID, artifact name | 44304976936; 14428255589; agent3-h2hc-p0-security-44304976936 |
| Executable SHA-256 (NOT ZIP hash) | 8f3f8e0b6a6fc02b27776182458cf0d970bc02f76db9f6f6b6842c04f138746f |
| Original native revision-2 public fixture SHA-256 | 065435eee01a44b2111627636136efa21a777954de8cd86786d0d8d044fbd6e4 |
| Agent 2 isolated + installed-staging receiver source | d9abab04559cb059e0de6c3499ed1915943fe74b |
| Agent 2 pinned HWC compatibility patch | bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39 |
| Holo-Host/holo-web-conductor upstream | 0c391226e78769d44ccb4661881ed8998b15f903 |
| Agent 4 native recipient key + three-browser source | 64983e13f849b342aff391add08911970de0c32a |
| Agent 4 previous native 3-browser acceptance | successful run 44295857738 (different job, no encrypted role) |
| Agent 3 three-browser gateway re-pin workflow | 4aa1d46234324f4d89ce910dd4131ecbaca1bbbf — run 44319408353 (running when recorded) |

## Committed integration workflows and strict result semantics

**Pinned cross-branch component integration:** `.github/workflows/agent3-role-e2e-integration.yml`, source 9930c375111af341d82421e23b56a64c2cf0db23, [CI 44318787413](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44318787413). Exact Agent 2/Agent 4/HWC pins are asserted, gateway artifact 14428255589 is checked against the source run, applied H2HC and originating Imposter SHAs, SHA256SUMS and hardcoded executable SHA-256. The unchanged revision-2 public fixture is compared byte-for-byte, and Agent 2's **isolated** native vector, HPKE, epoch, replay, trusted-receiver and true upstream Lair *fixture* tests run. The new native job builds actual Imposter WASM/DNA and executes Agent 4's two independent Holochain 0.7 conductor recipient-key tests. The new installed-HWC staging job applies the original accepted HWC compatibility patch plus Agent 2's separate **DENY-ONLY** role-frame patch, typechecks and builds the Chrome extension. The always-executed strict job exits nonzero until actual independently accepted Guest B role verification can replace this missing trust boundary; a user input cannot bypass it. A native or isolated component PASS does not satisfy the strict job. The run was still in progress when this document update was written.

**Pinned three-browser topology replay:** `.github/workflows/agent3-role-e2e-three-browser.yml`, source 4aa1d46234324f4d89ce910dd4131ecbaca1bbbf, [CI 44319408353](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44319408353). It uses exactly Agent 4 64983e13f849b342aff391add08911970de0c32a, Agent 2 d9abab04559cb059e0de6c3499ed1915943fe74b, original HWC 0c391226e78769d44ccb4661881ed8998b15f903, and the *same* attested gateway executable artifact 14428255589. The restricted HWC handler is staged with no generic remote signals and no ChainAuthor fallback. Existing Agent 4 topology exercises three independent Chromium/Lair identities, public native-valid lobby and joins, native DHT/seat inspection and restart recovery. It does **not** yet create a fresh verified RoleCommit and deliver/decrypt a private role. The final role receipt step *always fails* with an explicit BLOCKED verdict. The first attempt 44319327545 failed at the artifact API token step; source 4aa1d462 adds exact GitHub token scope and triggers the corrected run. These CI runs are NOT proof of role acceptance.

**Artifact hygiene:** integration uploads only explicit allowlisted JSON (component PASS/BLOCKED and provenance) or text (public source/executable SHA pins). It does **not** upload raw browser traces, gateway or native logs, decrypted roles, key material, bearer credentials, plaintext proofs or private grants. Public DNA/agent/action hashes and authenticated key epoch are to be captured only after actual native/installed receiver evidence is available. Gateway `role_queued_v1` and an extension-local decrypted result are separate gate outputs, and only the latter can satisfy recipient verification after native authority and replay checks. The accepted gateway artifact may expire; expiration must fail, never substitute a new artifact or recalculate a different accepted digest.

## Security acceptance matrix

| Assertion | Evidence and status |
| --- | --- |
| Signed H2HC identity, strict separate role request/delivery grants, same-DNA live routing, sender/recipient check, expiry/caps, no plaintext or offline mailbox | PASS at **gateway boundary** — run 44304976936 |
| Native Rust Holochain 0.7 signing vectors, AES-256-GCM RFC9180 HPKE, revision-2 signed key epoch and request/reply bytes | PASS at **crypto boundary** — run 44304976936 |
| Three independent Chromium/HWC/Lair identities, real host lobby and B/C joins, native acceptance, host+guest restart continuity, coordinator seat authorization | PASS **separate non-role test** — Agent 4 run 44295857738 |
| Browser WebCrypto, native vector match, genuine Lair fixture signing, key persistence | PASS **isolated** — Agent 2 tested modules; does not mean an installed game-cell signer or receiver |
| Native 0.7 recipient-key attestation/public entry, real Lair signing, host DHT lookup, foreign-agent denial, durable floor tests | **PASS in Agent 4 separate run 44309180176; independent new replay 44318787413 RUNNING**. Installed Guest B publication and live confirmation remain BLOCKED. |
| Exact native DHT and H2HC DNA/host/B/C identity match, attestation signer/validity/current epoch and B seat checked together | **BLOCKED integrated cross-boundary authority** — `Observed {current_unproven:true}` does not establish global freshest epoch; require signed live recipient request and durable floor. |
| Host encrypts a genuine committed seat role and signs delivery with actual installed game's Lair author identity | **BLOCKED privileged host integration** |
| H2HC queues role_delivery_v1 AND Guest B independently validates host, recipient, seat, current RoleCommit, Merkle proof, signature and HPKE decrypt in HWC | **BLOCKED — trusted HWC receiver** |
| Guest C cannot retrieve or decrypt B's role; replay, wrong DNA/seat/host and stale key epoch rejected at recipient | **BLOCKED browser acceptance**; gateway/isolated crypto negative probes are not substitutes |
| Guest B signs role_request_v1, host returns new ciphertext with original signed request ID, unmatched/duplicate replies rejected | PASS **gateway correlation only**; **BLOCKED browser recovery** |
| B Chromium restart retains replay state and refuses old role | PASS **isolated store**; **BLOCKED real role traffic** |
| Revoke B while a delivery is pending; gateway discards it and never replays after reauthorization; C remains connected | PASS **previous gateway isolation only**; **BLOCKED pending live encrypted delivery** |
| Only sanitized DNA/agent/action hashes, attestation epoch, message IDs or safe digests, verifier status, receiver acceptance booleans archived | PASS for **preflight allowlist**; live role evidence not yet collected |
| Formal protocol freeze, production activation, PR merge | **WITHHELD** |

## Exact missing trusted integration boundary

Agent 2's private-role/wire.mjs, store.mjs and trusted-receiver.mjs implement isolated strict checks, but the actual HWC role-handler patch remains **deny-only**. The current receiveRoleDelivery helper still expects trusted inputs such as nativeValidated, caller provenance, current installed cell, current accepted RoleCommit and verified Merkle opening. Those must come from a privileged, independently verified HWC/native authority rather than unsigned page callbacks or an H2HC queue response. Agent 2 must implement the installed-cell Lair sender and extension-only protected receiver, durable epoch/replay check, and genuine accepted-role report.

Agent 4 **has implemented** the append-only public attestation entry, true native author/DNA/signature validation, read-only host DHT observation and native stale-floor tests. The missing bridge is a privileged installed-cell read of current native-valid Lobby/RoleCommit/seat/round/root plus authenticated request/confirmation to establish the latest key epoch. **The gateway must not become an unauthenticated key directory.** No generic remote zome calls, send_remote_signal, local ChainAuthor provenance fallback or plaintext storage may be activated to shortcut this boundary.

Once those changes are independently available, the next acceptance must prove a real role, not the synthetic native fixture: host creates lobby, B/C join, native conductors independently accept lobby/joins/RoleCommit, B signs and publishes recipient-key attestation and host independently verifies it, host actually Lair-signs HPKE ciphertext, H2HC forwards, B independently decrypts and validates, C is denied, negatives are rejected, signed recovery correlation survives B process restart, revocation drops pending B data without affecting C. Record the gateway queued boolean and B receiver accepted boolean independently. No decrypted roles, private Lair/HPKE keys, bearer credentials or decrypted proofs are legitimate artifacts.

**No E2E success claim is permitted until this full sequence actually runs.**
