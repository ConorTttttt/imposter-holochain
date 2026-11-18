# Agent 2 ↔ Agent 3 — confidential role relay candidate revision 2

**18 November 2026 — NOT FROZEN / NOT DEPLOYABLE.** Agent 2 adopts the
normative candidate described by Agent 3 at
`ci/agent3-h2hc-kit/RESTRICTED_ROLE_RELAY_V1.md` as of
`8500270ecb3285ff6435bba568d1ef46c0c3ac8e`, **pending the required
two written approvals**. Earlier green native artifact
`14424762920` from run `44299128149` is a **revision 1** fixture
without the key epoch and cannot attest revision-2 compatibility.

## Candidate bytes

- JSON frame: only `role_request_v1` and `role_delivery_v1`.
  Strict `version=1`, `domain=imposter.h2hc.private-role.v1`;
  full canonical typed DNA/agent/action HoloHash, padded standard
  base64 ciphertext and encapsulation, lowercase 16-byte hex IDs.
- `HEADER`: operation (01/02), DNA raw39, sender raw39,
  recipient raw39, action raw39, seat u16BE, recipient key ID raw16,
  **recipient key epoch u64BE**, message ID raw16, created/expires
  u64BE, one-byte reply presence and optional reply ID raw16.
- `AAD` = `IMPOSTER-H2HC-ROLE-AAD\0\x01` + header.
  `SIGNED_BYTES` = `IMPOSTER-H2HC-ROLE-SIGNED\0\x01` +
  header + enc raw32 + ciphertext length u32BE + ciphertext.
- `HPKE info` = `imposter.h2hc.private-role/hpke-v1`.
  RFC9180 base: X25519/HKDF-SHA256, HKDF-SHA256, AES-256-GCM, seq 0.
- `KEY_ATTEST_BYTES` =
  `IMPOSTER-H2HC-ROLE-KEY\0\x01` + DNA raw39 + agent raw39
  + key ID raw16 + X25519 pubkey raw32 + epoch u64BE
  + notBefore u64BE + notAfter u64BE.
  Agent's Lair Ed25519 signs **original bytes**.
- Frame max 8192 UTF-8 bytes; HPKE enc 32, ciphertext 16–4096;
  signed envelope expires after at most 60s and creation may be
  at most 30s ahead of receiving clock. A request cannot contain
  an `in_reply_to`. Only a correlated current-key delivery may
  satisfy a recovery request.

## Evidence and boundaries

`wire.mjs` implements both operation discriminators, canonical
JSON mapping and signed epoch. `native-role-vectors.json`
contains synthetic revision-2 outputs independently reproduced from
Agent 3's Python generator using native Holochain 0.7 typed-hash
inputs. `native-role-vectors.test.mjs` checks exact signatures,
signed preimages, AAD and HPKE bytes with fixed ephemeral
keys, as well as malformed signatures, recipient/DNA substitution,
AAD, expiry and key epochs. **A new successful Agent 3
revision-2 native Rust run and its archived artifact must replace
or independently confirm this provisional fixture before freezing.**

`lair-signing-acceptance.mjs` exercises the actual pinned HWC
`@holo-host/lair` implementation and genuine Ed25519 signing
of key attestations and role deliveries, using isolated CI identities
and a *fixture* DNA. That test does **not** prove an installed
game DNA / browser extension signer identity until directly exercised
inside the installed HWC extension with the live cell.

`store.mjs` keeps non-extractable recipient X25519 private
CryptoKeys in extension-owned IndexedDB and rotates monotonically
per exact (DNA, agent); a readwrite replay reservation persists
across browser restart. `receiveRoleDelivery` enforces exact
installed cell, host, seat, commitment, key ID, epoch,
signature, authenticated remote-caller context and proof callback
but remains an **isolated pure helper**. It does NOT confer trusted
provenance on caller-supplied `nativeValidated` or
`authenticated` flags and is NOT connected to a remote handler.

**Critical blockers (fail closed):**

1. Obtain recipient public key attestations from a truly
   authenticated source: a native-validated published entry or
   explicit independent trusted exchange. H2HC gateway lookup
   is not authenticated enrollment. Enforce persisted current-epoch
   watermarks per cell at sending and receiving boundaries.
2. Prove real Lair-signed attestation on the actual installed
   DNA/agent, without exposing private signing keys or promoting
   untrusted page callbacks.
3. Provide native-validated round, lobby host, current RoleCommit,
   seat assignment and Merkle verifier from a trusted HWC service,
   not caller-asserted Boolean fields.
4. Produce verified remote sender/recipient context from the signed
   H2HC WebSocket session that remains distinct from local ChainAuthor.
   Current HWC remote-signal handler correctly rejects all traffic.
5. Implement an extension-only restricted receiver and demonstrate
   actual role disclosure to B, denial to C, restart/replay,
   stale-reply/rotation denial, and three distinct Lair identities.
   A gateway `role_queued_v1` ACK cannot satisfy any game acceptance.
6. Native HoloHash type/prefix is enforced by these pure modules,
   but full HoloHash location/checksum checking must occur using
   the installed Holochain parser at the privileged boundary.
   Do not use prefix checking as proof of installed cell identity.

The accepted pinned HWC **source patch SHA remains
`bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39`**, over
`0c391226e78769d44ccb4661881ed8998b15f903`.
This branch's isolated modules do not change that HWC patch
and must not be falsely reported as a new accepted HWC source kit.

No arbitrary remote signals, generic remote zome/HTTP calls,
ChainAuthor fallback, plaintext server mailbox, private DHT
publication, or H2HC role decryption are enabled. Keep PR #5 Draft
until Agent 2 and Agent 3 explicitly approve the *same*
signed-epoch vector artifact and independently accept the receiver.
