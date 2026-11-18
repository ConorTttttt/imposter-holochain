# Agent 2 — restricted confidential role cryptography / HWC preflight

**18 November 2026. Status: REVISION-2 CRYPTOGRAPHIC INTEROPERABILITY ONLY.
NO REMOTE GAME ROLE TRANSPORT OR COORDINATOR EXECUTION IS ENABLED.**
PR #5 remains Draft. The current **normative candidate**, not yet jointly
frozen, is Agent 3's `ci/agent3-h2hc-kit/RESTRICTED_ROLE_RELAY_V1.md`
revision 2, reviewed at commit
`8500270ecb3285ff6435bba568d1ef46c0c3ac8e`. Agent 3's
native Holochain 0.7 Rust/HPKE vectors passed CI
[44304051978](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44304051978).
**Signed recipient key epoch (`recipient_key_epoch`) is mandatory in
revision 2.** Earlier pre-epoch vectors from run 44299128149 are
superseded and MUST NOT be used as approval for revision 2.

See [AGENT2_AGENT3_REV2_HANDOFF.md](./AGENT2_AGENT3_REV2_HANDOFF.md)
for exact domains/field ordering, epoch rules, threat model,
receiver blockers, and two-party freeze requirements.

## Implemented and testable (isolated extension-side modules)

- `wire.mjs`: only `role_request_v1` (operation 01) and
  `role_delivery_v1` (operation 02), canonical 39-byte typed
  HoloHash text/raw39 mapping, signature transcript, 32-byte HPKE
  encapsulation, ciphertext length u32BE, current key epoch u64BE,
  version and domain, optional reply correlation, and strict
  expiration/frame/encoding checks. Key attestation signs the
  specified native prefix, DNA, agent, X25519 public key,
  key ID, epoch and validity in the required field order.
- `hpke.mjs`: WebCrypto RFC 9180 base mode
  DHKEM(X25519,HKDF-SHA256), HKDF-SHA256, AES-256-GCM,
  fixed info and AAD, one-shot sequence 0. Recipient private
  `CryptoKey` is non-extractable; deterministic ephemeral key
  injection is test-only. The WebCrypto composition has
  **not been independently security-audited**.
- `agent3-role-public-vectors-v1-candidate.json.gz.base64`:
  byte-identical published Agent 3 revision-2 source fixture
  pinned from `ci/agent3-h2hc-kit/fixtures/` at Agent 3 commit
  `8c1bedbb2bec78ac0d404ce54c67ce54691ffc8d`.
  `native-fixture.mjs` decodes it. Cross-language tests assert
  exact native Holochain 0.7 byte transcripts, Ed25519 signatures,
  fixed-ephemeral HPKE ciphertext/AAD, attestation signatures,
  and Agent 3's nine declarative malicious mutations. These
  have no real role leaf, signing secret or bearer.
- `lair-signing-acceptance.mjs` and
  `agent2-role-lair-signing.yml`: **genuine pinned HWC
  `@holo-host/lair`** signs original key-attestation and role
  transcripts with CI-created keys, with negative signer identity
  checks. This is the REAL Lair implementation but **not an
  installed Imposter DNA browser signing acceptance**.
- `store.mjs`: extension-origin IndexedDB per-(DNA,agent) key
  generation, protected non-extractable private keys, monotonic
  epoch rotation, strict durable replay reservations and atomic
  installation of signed attestation matching the **current
  held key**. Source-only `fake-indexeddb` tests and separate
  genuine two-process Chromium restart probe establish isolated
  key persistence and replay denial, not live recipient enrollment.
- `receiveRoleDelivery` pure preflight requires installed local
  DNA/agent, expected host and seat, latest role commitment and
  recipient key epoch, verified signed sender, AAD, expiration,
  replay ledger, and separately supplied proof and remote-caller
  context. However **trust is not established** by external
  `nativeValidated` or `authenticated` flags: the
  native-authority and verified H2HC transport sources are
  NOT wired. It performs no remote WASM execution.

## Run isolated checks

```bash
node --test compatibility/hwc-imposter-compatibility/private-role/{native-role-vectors,canonical-vectors,private-role}.test.mjs
# In GitHub Actions, fake-indexeddb/auto is imported for store.test.mjs,
# and the dedicated Chromium and pinned genuine HWC Lair jobs run separately.
```

## Security acceptance still blocked

- **Recipient enrollment/discovery:** host has no trusted native entry
  or direct authenticated exchange to obtain and pin the signed current
  recipient key; no unauthenticated H2HC key-lookup fallback.
- **Installed cell:** no genuine installed-game-DNA recipient
  attestation through the actual extension's Lair routing.
- **Trusted receiver:** no native validated lobby/round/RoleCommit
  host/seat/Merkle proof or segregated verified remote-caller
  HWC context. No arbitrary remote zome call or generic signal is
  authorized. Gateway queue ACK is not receipt.
- **Multiplayer:** no three independent extensions, actual role
  delivery, revocation recovery/replay, or browser-to-desktop acceptance.
  Per-cell host latest-epoch watermark and proof binding remain to
  be independently implemented in a privileged boundary.
- **Final freeze:** both Agent 2 and Agent 3 must explicitly approve
  the same contract and matching vector artifact; green unit tests
  alone are not a joint approval.

**The accepted HWC source patch remains
`bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39`** on pinned
HWC upstream `0c391226e78769d44ccb4661881ed8998b15f903`.
This branch updates isolated integration candidate modules and tests
but **does not install them into the upstream HWC extension source**.
Legacy remote signals, generic remote zome execution, local ChainAuthor
remote-caller fallback, plaintext server mailbox and private DHT
publication remain disabled. Keep PR #5 **Draft**.
