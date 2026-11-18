# Agent 3 — encrypted host-to-guest role integration handoff

**18 November 2026. Gateway readiness PASS; end-to-end browser role delivery BLOCKED.** Draft PR #6 remains Draft. No formal revision-2 protocol freeze or runtime activation is authorized. The accepted signed transcripts, key-epoch binding and HPKE bytes have not been modified.

## Exact source/artifact pins

| Component | Immutable reference |
| --- | --- |
| Agent 3 original integration HEAD | ef5dc9c8bc13dc049ef9a113a0919b1da818e2d2 |
| Agent 3 cross-branch workflow commit | abd69efb380c213969ac52ab901e31d093dea36d |
| H2HC upstream checkout | cab242d32c988fe5e4e9fd06ebc82ed043541aa2 |
| H2HC generated/verified source | 9f5eb04b5be12e3e9e7fcc304bd905da1449ade9 |
| Imposter source responsible for gateway build | 293563649f7fd18a6bc2e0d1426c31132bf2b8c7 |
| Gateway CI run, artifact ID, artifact name | 44304976936; 14428255589; agent3-h2hc-p0-security-44304976936 |
| Executable SHA-256 (NOT ZIP hash) | 8f3f8e0b6a6fc02b27776182458cf0d970bc02f76db9f6f6b6842c04f138746f |
| Original native revision-2 public fixture SHA-256 | 065435eee01a44b2111627636136efa21a777954de8cd86786d0d8d044fbd6e4 |
| Agent 2 isolated private role crypto and replay source | fbbe543fea22e6a6052a0cce7b527314ccd18940 |
| Agent 2 pinned HWC compatibility patch | bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39 |
| Holo-Host/holo-web-conductor upstream | 0c391226e78769d44ccb4661881ed8998b15f903 |
| Agent 4 coordinator+three browser source | 43943a45833f9d9262ad08427da29e5abdbfdf99 |
| Agent 4 previous native 3-browser acceptance | successful run 44295857738 (different job, no encrypted role) |

## Committed integration workflow

Workflow: .github/workflows/agent3-role-e2e-integration.yml.
Its normal push/manual job performs pinned checkout of both external branches and real HWC, verifies that native revision-2 fixture bytes are identical between Agent 2 and Agent 3, explicitly verifies run 44304976936 and artifact 14428255589, checks SHA256SUMS plus the hard-coded executable digest, checks applied H2HC and originating Imposter source SHAs, runs Agent 2 pure WebCrypto/IndexedDB tests and genuine upstream Lair fixture-signing test. It also verifies that the inbound HWC remote-signal rejection remains present.

These prove independently reproducible *component* results, not an integrated receiver. The workflow writes and archives only acceptance-evidence/preflight.json with receiver_accepted=false and role_e2e=BLOCKED. It never archives a gateway raw message, bearer, native proof, private key or plaintext. The binary remains the accepted tested binary rather than a rebuilt or format-modified replacement. The exact gateway artifact is temporary and will expire; an expired artifact must cause a failure rather than a silently selected substitute.

The workflow has an explicit workflow_dispatch input require_encrypted_delivery. If true it invokes a separate strict job which deliberately fails with E2E_BLOCKED until reviewed native enrollment and installed HWC receiver components actually exist. Do not replace this failure with assertions constructed by CI, a fixture role, or a gateway queue acknowledgement. A true combined run must actually start three distinct installed HWC/Lair Chromium identities, native 0.7 conductors, the same pinned gateway, and prove the receiver results using privileged, reviewed code.

## Security acceptance matrix

| Assertion | Evidence and status |
| --- | --- |
| Signed H2HC identity, strict separate role request/delivery grants, same-DNA live routing, sender/recipient check, expiry/caps, no plaintext or offline mailbox | PASS at **gateway boundary** — run 44304976936 |
| Native Rust Holochain 0.7 signing vectors, AES-256-GCM RFC9180 HPKE, revision-2 signed key epoch and request/reply bytes | PASS at **crypto boundary** — run 44304976936 |
| Three independent Chromium/HWC/Lair identities, real host lobby and B/C joins, native acceptance, host+guest restart continuity, coordinator seat authorization | PASS **separate non-role test** — Agent 4 run 44295857738 |
| Browser WebCrypto, native vector match, genuine Lair fixture signing, key persistence | PASS **isolated** — Agent 2 tested modules; does not mean an installed game-cell signer or receiver |
| Guest B's installed-cell Lair-signed X25519 attestation published as public native entry, native accepted and independently discovered by host | **BLOCKED — Agent 4 native key enrollment** |
| Exact native DHT and H2HC DNA/host/B/C identity match, attestation signer/validity/current epoch and B seat checked together | **BLOCKED integrated cross-boundary authority** |
| Host encrypts a genuine committed seat role and signs delivery with actual installed game's Lair author identity | **BLOCKED privileged host integration** |
| H2HC queues role_delivery_v1 AND Guest B independently validates host, recipient, seat, current RoleCommit, Merkle proof, signature and HPKE decrypt in HWC | **BLOCKED — trusted HWC receiver** |
| Guest C cannot retrieve or decrypt B's role; replay, wrong DNA/seat/host and stale key epoch rejected at recipient | **BLOCKED browser acceptance**; gateway/isolated crypto negative probes are not substitutes |
| Guest B signs role_request_v1, host returns new ciphertext with original signed request ID, unmatched/duplicate replies rejected | PASS **gateway correlation only**; **BLOCKED browser recovery** |
| B Chromium restart retains replay state and refuses old role | PASS **isolated store**; **BLOCKED real role traffic** |
| Revoke B while a delivery is pending; gateway discards it and never replays after reauthorization; C remains connected | PASS **previous gateway isolation only**; **BLOCKED pending live encrypted delivery** |
| Only sanitized DNA/agent/action hashes, attestation epoch, message IDs or safe digests, verifier status, receiver acceptance booleans archived | PASS for **preflight allowlist**; live role evidence not yet collected |
| Formal protocol freeze, production activation, PR merge | **WITHHELD** |

## Exact missing trusted integration boundary

Agent 2's private-role/wire.mjs and store.mjs are isolated. The current receiveRoleDelivery helper still expects trusted inputs such as nativeValidated, caller provenance, current installed cell, current accepted RoleCommit and verified Merkle opening. Those must come from a privileged, independently verified HWC/native authority rather than unsigned page callbacks or an H2HC queue response. Agent 2 must implement the installed-cell Lair sender and extension-only protected receiver, durable epoch/replay check, and genuine accepted-role report.

Agent 4 must implement public attestation entry publishing and host-side native action lookup/validation, current per-cell key-epoch watermarks, and exact DNA/agent/host and seat registration. **The gateway must not become an unauthenticated key directory.** No generic remote zome calls, send_remote_signal, local ChainAuthor provenance fallback or plaintext storage may be activated to shortcut this boundary.

Once those changes are independently available, the next acceptance must prove a real role, not the synthetic native fixture: host creates lobby, B/C join, native conductors independently accept lobby/joins/RoleCommit, B signs and publishes recipient-key attestation and host independently verifies it, host actually Lair-signs HPKE ciphertext, H2HC forwards, B independently decrypts and validates, C is denied, negatives are rejected, signed recovery correlation survives B process restart, revocation drops pending B data without affecting C. Record the gateway queued boolean and B receiver accepted boolean independently. No decrypted roles, private Lair/HPKE keys, bearer credentials or decrypted proofs are legitimate artifacts.

**No E2E success claim is permitted until this full sequence actually runs.**
