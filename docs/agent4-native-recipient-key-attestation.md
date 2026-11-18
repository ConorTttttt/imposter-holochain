# Agent 4 — native public recipient-key attestation (revision-2 candidate)

**Status:** A DHT discovery/attestation implementation, not an HWC receiver
freeze, an encrypted-role delivery acceptance, or a proof of global latest-key
freshness. PR #4 stays **Draft**. No private role, task, bearer or X25519 secret
is ever an entry or link.

## Exact cryptographic contract (unchanged)

The only public entry is `RecipientKeyAttestation`: `dna: DnaHash`,
`agent: AgentPubKey`, `key_id: [u8;16]`,
`x25519_public_key: [u8;32]`, `epoch: u64`,
`not_before_ms: u64`, `not_after_ms: u64`, and the **original**
`signature: Signature` from cell-agent Lair Ed25519.

`game_integrity::recipient_key_transcript` signs **literal bytes**, NOT
MsgPack, JSON or a newly defined transcript:

```text
ASCII("IMPOSTER-H2HC-ROLE-KEY") || 0x00 || 0x01
|| installed_dna_raw39 || attested_agent_raw39
|| key_id_raw16 || x25519_public_key_raw32
|| epoch_u64_be || not_before_ms_u64_be || not_after_ms_u64_be
```

Attestation bytes are **174 bytes**. Both 39-byte hash types MUST be the
actual installed cell IDs, never strings, an original un-cloned DNA or
an assumed hApp default. The cryptographic candidate is the one approved
by Agents 2 and 3 in `ci/agent3-h2hc-kit/RESTRICTED_ROLE_RELAY_V1.md`
at Agent 3 `ef5dc9c8bc13dc049ef9a113a0919b1da818e2d2`;
normative bytes have NOT been expanded or reinterpreted.

The integrity validator independently rejects foreign action authors,
another installed DNA, malformed ID/epoch/key/validity and an invalid
Ed25519 signature over the raw transcript. Every author-key index is a
separate empty-tag, append-only `RecipientKeyByAgent` link with
**base = agent hash, target = native Valid Create action hash, author =
the same agent**. An unrelated agent cannot index or publish another
agent's attestation as a native-validated operation.

The validity window is at most 30 days; the end must be later than the
start, current at Create time, and the start cannot exceed the Create
timestamp by more than 30 seconds. Lookup checks the actual current
clock again; expired entries are never returned as usable candidates.
The integrity entry type and link type are appended only; `Lobby`,
`PlayerJoin`, `RoleCommit` and existing validators remain byte-exact
apart from their new dispatch arms. The browser packaging guard confirms
that preservation against its pinned native baseline.

## API for Agent 2 / HWC

1. **Inside the actual installed Imposter cell**, HWC generates and durably
   protects an independent X25519 secret, fresh CSPRNG key ID (16 bytes),
   persisted per-cell monotonic epoch, and validity timestamps. Only the
   public half and metadata go into the coordinator call
   `game::enroll_recipient_key({key_id, x25519_public_key, epoch,
   not_before_ms, not_after_ms})`. The coordinator fills `agent` from
   `agent_info` and `dna` from `dna_info`, calls Lair `sign_raw` over
   the exact transcript, independently validates it and creates the public
   entry/action and agent-based index link. Return:
   `{action, attestation}`. HWC may alternatively produce the **same**
   Lair signature externally and call
   `game::publish_signed_recipient_key_attestation(attestation)`, which
   still enforces the actual author, cell DNA and original signature.
2. Host calls the read-only
   `game::lookup_recipient_key({recipient, min_epoch, min_key_id})`.
   Host MUST run this from a genuinely authenticated installed cell.
   These optional fields are a **durable trusted floor**: set BOTH from the
   last authenticated enrollment or neither for initial unpinned discovery.
   Every lookup requires a native-valid typed record, proper original author,
   exact installed DNA, raw Ed25519 signature, unexpired validity and
   nonconflicting observed epoch history. `observed` includes
   `{current_unproven:true, view:{action,attestation}}`. This is **not**
   permission to encrypt before current-key confirmation.
3. HWC independently re-verifies these fields and the Lair signature,
   pins the action/epoch/key ID in protected per-cell durable storage and
   refuses any key below its persisted floor. On each restart, reload the
   durable floor **before** DHT lookup; never reset it because DHT appears
   empty. Missing records, gaps, conflicts, matching epoch with a different
   key, expired keys or unverifiable links/entries fail closed.
4. The next epoch is exactly `old+1`, with a new X25519 key and key ID,
   after protected secret persistence. The same encryption key can be
   **renewed** with the same epoch and key ID, a nondecreasing start, and
   strictly later expiry; signed validity fields change, old signatures
   remain as historical records. Duplicate identical enrollment can recover
   its missing index link. The source-chain enrollment API refuses local
   lower epochs and same-epoch key substitution.

## Security blocker: DHT completeness/freshness

A DHT can prove **authorship, integrity and existence of an observed
entry**, but cannot prove that no higher-epoch valid entry exists elsewhere,
or that a remote party has not delayed its propagation. Native integrity
validation cannot safely compare against a globally current epoch during
distributed validation. A malicious author might also bypass coordinator
local sequencing and sign another historical epoch. Therefore neither
`get_links` nor `must_get_valid_record` establishes the **current**
enrollment, even when all returned rows validate. An unpinned host can see
a valid old key and must not encrypt to it. Our lookup deliberately reports
`current_unproven:true` and never claims global freshness.

**Required authenticated alternative, without any new signature format:**
after DHT discovery, require a *fresh authenticated recipient
`role_request_v1` over Agent 3's restricted, signed, expiry/nonce-bound,
revocation-sensitive H2HC route*. Its protected body carries the
recipient's **same** Lair-signed public attestation, correlated to the
live request, and must be checked against HWC's durable local enrollment
floor and own installed cell. Host independently checks the protocol
request signature, session/recipient/DNA/commitment binding, recipient
attestation signature and key ID/epoch against its durable floor. No
unsigned gateway directory, generic remote zome invocation or extra
attestation transcript is allowed. Agent 2 must implement and demonstrate
this HWC runtime handshake before the host is permitted to treat any
discovered candidate as current. On a disconnected or offline recipient,
or a cold host with no verified handshake, **fail closed**.

## Native acceptance evidence

`.github/workflows/agent4-recipient-key-native.yml` builds genuine 0.7
WASM/DNA and runs `recipient_key_native_two_conductors_attest_discover_and_rotate`
using two independent native SweetConductors on one installed cloned DNA.
The test attempts genuine Lair signing/publication, native DHT consistency,
read-only host lookup of the exact action, cross-agent publication denial,
local epoch-2 rotation, old-epoch publication denial and trusted-floor
rejection. Its log prints the ephemeral public entry's exact action hashes
and only public attestations. Successful execution, artifact IDs and
exact hashes must be verified from a completed CI run; do not infer
acceptance from this written test alone.

The existing three-browser lobby/restart job is separate and must be
green on the **new source SHA**. Neither job alone proves the HWC
protected X25519 key store, authenticated fresh-key handshake, private
role delivery or browser↔desktop gameplay.
