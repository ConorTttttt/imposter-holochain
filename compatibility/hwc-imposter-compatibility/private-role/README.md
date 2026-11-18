# Agent 2 — restricted private role transport preflight (18 November 2026)

**Status: PARTIAL CRYPTOGRAPHIC PROTOTYPE ONLY. NOT INSTALLED OR WIRED INTO HWC.
NOT DEPLOYABLE; NOT A LIVE ROLE-TRANSPORT ACCEPTANCE.**

Branch: `validation/agent2-hwc-integration`; PR #5 remains Draft.
Accepted patch `bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39` and the
pinned upstream HWC `0c391226e78769d44ccb4661881ed8998b15f903`
are unchanged. No bypass of the existing rejected remote-signal path.

## Isolated module contents

- `hpke.mjs`: RFC 9180 base mode candidate:
  DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001,
  AES-256-GCM 0x0002, with one-shot seq=0.
  Raw 32-byte recipient public keys and non-extractable X25519 private keys;
  no Ed25519-to-X25519 key conversion and no Lair signing-key export.
  Browser WebCrypto implementation is **not externally audited**.
- `wire.mjs`: deterministic fixed-order, domain-separated signed
  `key-attestation/v1` and **role_delivery_v1 only**.
  Sender Ed25519 signature covers DNA, both full agents, commitment action,
  exact recipient/seat/key ID/epoch, message ID, timestamps, encapsulated key
  and all ciphertext. HPKE AAD covers the fixed role header. Key attestation
  is signed via an injected *existing Lair* `signByPubKey(agent core, bytes)`
  callback, never an in-page signer. The role receiver requires the actual
  installed DNA and Lair local agent, an independently native-validated
  current commitment with exact host and seats, a matching persisted cell
  encryption key, a durable replay reservation, and a trusted proof-verifier
  callback **before any coordinator execution**. It neither executes WASM
  nor dispatches a browser signal.
- `store.mjs`: extension-origin IndexedDB database, full 39-byte
  `(DNA,agent)` cell key, non-extractable CryptoKey structured clone,
  monotonically increasing epoch, and a strict read-write transaction
  inserting `(DNA,recipient,sender,message_id)` before decrypt/application.
  The replay ledger is not cleared on revocation or reauthorization. The
  role commitment is authenticated separately; omitting it from replay-key
  identity denies reuse of the same message ID across rounds.
- `*.test.mjs`: Node 22 WebCrypto cryptographic tests and synthetic
  `fake-indexeddb` persistence, concurrency and replay tests.
  Source-level CI only checks the original remote handler is still rejected.

## Fixed canonical transcript fixtures (synthetic, NOT Holochain native vectors)

The fixture shapes are defined in `canonical-vectors.test.mjs`.
These hashes are SHA-256 **fingerprints for comparing original transcript
bytes**, not the signing primitive, HPKE KDF or a substitute for signatures.

| Transcript | Length | SHA-256 |
| --- | ---: | --- |
| `key-attestation/v1` | 182 bytes | `809ac8a578be2731201d8940b82ba6d367eefd1b27f3fb943e171f8d28561573` |
| `role-delivery/v1` | 302 bytes | `fca5e715a6e0b54c0718fb58e92d69f4c23df413d8df2188f903a914cb6ee375` |

Fields are signed as **raw Ed25519 over the canonical transcript bytes**
as exercised by the local test harness. This must be checked byte-for-byte
against the *real existing Holochain 0.7 / Lair signer* on the installed cell
before it is accepted as a cross-implementation contract. In particular
legacy native remote-signal signing of SHA2-512(serialized ZomeCallParams)
is a separate primitive; these role-only transcripts must not be substituted
for that legacy message or its remote caller provenance.

## Critical outstanding conditions (fail closed)

1. **Agent 3 must finalize the exact HPKE suite/wire bytes, origin binding,
   routing capabilities and real H2HC restricted relay.** The two handoff
   proposals give example suites, not a published independently verified
   native sign/verify vector. The present candidate is not an agreement.
2. **HWC integration is not implemented**: no installed-cell key enrollment
   exposed to a verified extension handler, no authenticated gateway frame
   dispatch, no secure verified remote-caller executor/CapGrant bridge.
   The existing handler continues rejecting arbitrary remote signals, and
   the local chain author is never used as a remote-caller substitute.
3. The native-validated `Lobby` / `RoleCommit` lookup, host/seat/round
   authority, role proof and typed coordinator entry point must be wired
   as privileged extension-side dependencies. An arbitrary caller-provided
   `nativeValidated:true` flag or untrusted proof callback is **NOT** a
   security boundary. The current tests supply fixture callbacks ONLY.
4. A `role_request_v1` recovery operation is not yet implemented.
   No secret `provide_role` HTTP GET/POST, generic remote calls,
   server-side plaintext/mailbox, private DHT writes, or task recovery.
5. **Isolated real Chromium key-storage test PASS:** [run 44296271475](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44296271475) launches two genuine Chromium processes with one persisted profile. Non-extractable X25519 CryptoKey clone, post-restart decryption, replay denial and epoch rotation passed, but only for the isolated test origin, **not** the installed HWC extension. Firefox extension build, actual HWC Lair signer vectors, three-browser role disclosure/isolation, native app-validation, stale/revoked delivery, and replay after real gateway session revocation **remain unaccepted**. `fake-indexeddb` tests are separately emulated only.
6. Review and test RFC 9180 against independent IETF vectors, audit the
   HPKE glue, check full HoloHash type+location hashes using the installed
   HWC functions and cap the wire payload before exposure. A malformed
   ciphertext currently consumes the replay reservation as intended.
7. The accepted `apply.py` storage migration, foreign-DNA restrictions
   and session lifecycle remain unchanged; do not modify the accepted
   source patch or mark PR #5 ready while these gates are open.

## Suggested acceptance sequence

Freeze byte-for-byte signed/native vectors with Agent 3; implement only
authenticated recipient key registration and role-only gateway dispatch;
inject an authenticated remote caller distinct from `ChainAuthor` or stop;
verify native-validated `RoleCommit` / seat / proof independently; prove
the enrolled recipient-only role path in **three independent HWC/Lair
Chromium processes**, then restart the recipient and repeat, with negative
wrong-recipient/other-DNA/forgery/replay/revocation tests. Keep private tasks
and general gameplay out of this gate.

Run the local protocol tests with
`node --test compatibility/hwc-imposter-compatibility/private-role/private-role.test.mjs compatibility/hwc-imposter-compatibility/private-role/canonical-vectors.test.mjs`.
The separate CI job also injects `fake-indexeddb` to run the storage test.
