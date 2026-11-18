# Agent 3 / Agent 2 — restricted confidential role protocol v1

**18 November 2026.** Gateway-side **v1 candidate revision 2**, pending explicit Agent 2 byte-for-byte approval. **NOT FROZEN**.
**Not a claim of Agent 2 approval, browser receiver acceptance, or a completed round.**
Review references: Agent 3 `PRIVATE_GAMEPLAY_TRANSPORT_HANDOFF.md`;
Agent 2 `docs/hwc-confidential-full-round-transport-proposal.md` on
`validation/agent2-hwc-integration`.

Only two gameplay operations exist in v1: `role_request_v1` and
`role_delivery_v1`. No tasks, kill, sabotage, arbitrary signals, generic remote
calls, generic HTTP zome calls, DHT fallback, offline mailbox or server decryption.

## Authenticated WebSocket schema

Each browser first completes the **existing signed Ed25519 H2HC challenge** on
`/ws`, obtains its own session token and registers its exact 39-byte
Holochain 0.7 DNA and agent pair. The operator grants separate
`game_role_request` (seated player to host) or `game_role_deliver` (host to
one committed recipient) capabilities. Ordinary `dht_read`, `dht_write`,
`k2` and legacy generic signal privileges confer neither role capability.

Client-to-gateway messages are JSON containing only:

```json
{
  "type": "role_delivery_v1",
  "envelope": {
    "version": 1,
    "domain": "imposter.h2hc.private-role.v1",
    "dna_hash": "u<canonical-39-byte-DnaHash>",
    "sender_agent": "u<canonical-39-byte-AgentPubKey>",
    "recipient_agent": "u<canonical-39-byte-AgentPubKey>",
    "role_commit": "u<canonical-39-byte-ActionHash>",
    "seat": 1,
    "recipient_key_id": "<32 lowercase hex characters>",
    "recipient_key_epoch": 9,
    "message_id": "<32 lowercase hex characters>",
    "created_at_ms": 1700000000000,
    "expires_at_ms": 1700000030000,
    "in_reply_to": "<32 lowercase hex characters, or null>",
    "hpke_enc": "<RFC 4648 standard padded base64 of 32-byte HPKE enc>",
    "ciphertext": "<RFC 4648 standard padded base64 of HPKE ciphertext+tag>"
  },
  "signature": "<RFC 4648 standard padded base64 of 64-byte Ed25519 signature>"
}
```

For `role_request_v1`, change only the outer `type` and create an independently
signed envelope for the **request** operation. Both operations use the same
header schema but different operation bytes. `role_request_v1` has
`in_reply_to=null` (the gateway rejects any other value); `role_delivery_v1`
uses null ONLY for an unsolicited host push that the recipient independently
validates, or the original request message ID for recovery. An HWC recovery
receiver MUST reject any unmatched reply ID, stale request, duplicate reply,
wrong requester/host/DNA/role commitment/seat, or any reply issued for an old
recipient key epoch. Gateway does NOT store requests or check correlation. Envelopes specify the target's
actual current cell; `sender_agent` must exactly equal the **signed socket
identity**, never an untrusted claimed name. DNA, sender, recipient and
commitment must be canonical Holochain 0.7 hashes with correct types.
`seat` is unsigned 16-bit big-endian. `recipient_key_epoch` is a positive, JavaScript-safe integer (1–9007199254740991), serialized u64 big-endian and cryptographically bound to the recipient's Lair-signed key attestation. A key rotation MUST change key ID and increment the epoch; gateway does not know which epoch is current. Message/key IDs each contain 16 bytes
and are encoded as 32 lowercase hex characters.

**Gateway response:** `{"type":"role_queued_v1","message_id":"<id>"}`
only confirms enqueue to a live registered recipient channel. It is **not**
recipient receipt, signature verification by HWC, role decryption, native
validation, or application success. Denials return
`{"type":"error","message":"<static error code>"}`; no input ciphertext,
secret, session token or stack trace is returned. Forwarded recipient frame
uses the same `role_request_v1` / `role_delivery_v1` type with
`envelope` and `signature` only; internal origin token is excluded from
serialization. A real HWC receipt is application-local after full validation;
no unsigned gateway success signal may advance gameplay.

## Canonical signature bytes and AAD — exact normative layout

All signatures use the Ed25519 **32-byte core** of the sender's
`AgentPubKey`, mapped only after validating the full 39-byte HoloHash.
Do not sign stringified JSON, UTF-8 hash strings, a pre-hashed transcript,
or sender-provided `provenance`.

```text
HEADER =
    operation                              1 byte   (0x01 request, 0x02 delivery)
    dna_hash                               39 bytes (canonical HoloHash raw39)
    sender_agent                           39 bytes
    recipient_agent                        39 bytes
    role_commit                            39 bytes (ActionHash)
    seat                                   u16 BE
    recipient_key_id                       16 bytes
    recipient_key_epoch                    u64 BE (>=1, <= 2^53-1)
    message_id                             16 bytes
    created_at_ms                          u64 BE
    expires_at_ms                          u64 BE
    in_reply_to presence                   1 byte (0 absent; 1 present)
    in_reply_to ID                          16 bytes iff presence = 1

AAD = ASCII("IMPOSTER-H2HC-ROLE-AAD") || 0x00 || 0x01 || HEADER

SIGNED_BYTES =
    ASCII("IMPOSTER-H2HC-ROLE-SIGNED") || 0x00 || 0x01 || HEADER
    || hpke_enc                             32 bytes
    || ciphertext_length                    u32 BE
    || ciphertext                           ciphertext_length bytes (includes 16-byte AEAD tag)

signature = Ed25519.sign(sender_Lair_key, SIGNED_BYTES)
```

The fixed v1 prefix/operation imply the literal `version` and `domain`.
All other envelope fields are cryptographically included in `HEADER`.
A verifier must require exact v1 domain and version before constructing
bytes. There is no canonical-JSON ambiguity or optional field reordering.

**Limits:** inbound WS UTF-8 frame <= 8,192 bytes; HPKE `enc` exactly
32 bytes; decoded ciphertext **16–4,096** bytes; base64 must be canonical.
Creation may be at most 30 seconds in the future; `expires_at_ms` must be
strictly after creation, not older than receiver current time, and at most
60,000 milliseconds after creation. These are gateway limits; HWC may impose
stricter windows and rejects outdated rounds/commitments. `message_id`
must come from a CSPRNG (>=128 random bits). `recipient_key_epoch`
must be a safe integer; absent/zero/unsafe values are rejected, not defaulted.
A different delivery/rotation
uses a fresh message ID, fresh HPKE encapsulation and ciphertext.

## RFC 9180 HPKE and signed key enrollment

**Exact v1 cipher suite:**
DHKEM(X25519, HKDF-SHA256) `0x0020`,
HKDF-SHA256 `0x0001`,
AES-256-GCM `0x0002`;
HPKE base mode `0x00`, 32-byte X25519 encapsulated key, 16-byte tag,
sequence number zero. AES-256-GCM is supported directly by browser WebCrypto; Agent 2 must use an audited RFC9180 HPKE implementation with identical KEM and key schedule. The fixed HPKE `info` bytes are
`ASCII("imposter.h2hc.private-role/hpke-v1")`; HPKE `aad` is the
byte-for-byte `AAD` specified above. Never reinterpret an Holochain
Ed25519 key as X25519; no private key material is hosted at H2HC.

**Key custody/registration is HWC-owned, not a gateway role operation.**
Before a sender can encrypt, it MUST have a genuine Lair-signed, locally
verified per-cell recipient X25519 key attestation. A v1 attestation is the
following domain-separated canonical bytes:

```text
ASCII("IMPOSTER-H2HC-ROLE-KEY") || 0x00 || 0x01
|| dna_hash raw39 || agent_hash raw39
|| key_id bytes16 || x25519_public_key bytes32
|| epoch u64 BE || not_before_ms u64 BE || not_after_ms u64 BE
```

Sign directly with the **cell author's** Lair Ed25519 key.
The public vector JSON includes **two reproducible signed key attestations** with native-Holochain 0.7 verification, wrong-agent denial, monotonic epoch and validity fields; the fixture uses expired test dates and must never be accepted as a live key.
Recipient and host independently verify the full signed binding, exact
installed DNA/agent, key ID, epoch, validity and protocol version. HWC
MUST provide a separately authenticated source for these public
attestations (for example a natively validated public entry, or an
explicit trusted exchange). **This gateway does not register, distribute,
cache or authorize encryption keys**, and `recipient_key_id` alone is
NOT an attestation. Until Agent 2 implements that enrollment/lookup and
protected extension key persistence, sending is **blocked**. An initial
recovery request can include the requester's signed public attestation
INSIDE the encrypted host-bound payload, provided the host's own valid
key is already authenticated; this is not an unsigned key-discovery API.

Rotate by creating a new X25519 key, incrementing the per-cell monotonic
epoch, generating a fresh CSPRNG `key_id`, signing a new attestation,
and persisting protected key state before advertising it. New messages
use only the current verified key/epoch; HWC MUST compare the signed
`recipient_key_epoch` and key ID with its durable, latest authenticated
key attestation, not just a sender-supplied number. Once rotated, any
message to the old key/epoch fails closed, including matched replies.
Old pending messages cannot
resurface after reauth or key rotation. Lost keys require new keys and
fresh host-signed encrypted delivery. No server-owned plaintext, key
escrow, cache, or offline replay.

## Security decisions and obligations

The **gateway** checks signed socket identity, valid original bearer,
strict source-cell DNA registration, operator capability for the exact
operation, live allowlisted registered recipient on the same DNA,
canonical signature and time/size limits. It rechecks both session
bearers and the current recipient socket mapping immediately before
dispatch, under the same bounded lock as agent/session revocation. No
server-side private-role persistence, decryption, source-chain or WASM
execution is added. The client WebSocket handler never prints raw inbound
envelopes at debug level.

The **HWC receiver** independently checks: installed exact cell/DNA,
recipient equals locally Lair-held `me()`, signer equals the actual
natively validated lobby host for `role_delivery_v1`, requester's
committed seat for `role_request_v1`, current round and accepted
RoleCommit hash, `RoleCommit.seats[seat]`, Merkle opening, X25519 key
attestation/current epoch, signature/AAD/ciphertext, expiry and
`in_reply_to` correlation. It atomically records
`(DNA, recipient, sender, message_id, role_commit)` in durable local
replay state before any application side effect. It must not invoke
a zome as ChainAuthor or trust a spoofable `from_agent`/outer `provenance`.
Agent 2 must review and test native coordinator role-seat and host checks.
A gateway transport ACK does not satisfy any of these checks.

## Test vector and verification commands

The two public, reproducible encrypted role vector cases **and two separately signed recipient-key attestation cases** are generated as follows:
native Holochain 0.7 `AgentPubKey::from_raw_32`,
`DnaHash::from_raw_32` and `ActionHash::from_raw_32` produce canonical
39-byte typed hashes; deterministic **test-only** Ed25519 signers
use byte-27 (host) and byte-28 (guest) seeds, with byte-29 third agent.
The Python cryptographic reference uses synthetic X25519 recipients
byte-51 / byte-52, fixed ephemeral byte-61 / byte-62, independent HPKE
key schedule and AESGCM tag verification, including invalid
AAD and foreign-recipient decryption denials. Public vector JSON includes
canonical `header_hex`, `signed_bytes_hex`, `aad_hex`,
`hpke_info_hex`, `hpke_enc_hex`, `ciphertext_hex`, `signature_hex`,
`signature_b64`, typed hashes, key-ID, key epoch, message-ID, signed key
attestations and declarative negative mutations. These are safe synthetic
fixtures for direct import into HWC tests, not a live Lair signing claim. Both cases are independently
verified by the native Holochain Rust example against Ed25519 key cores.
Fixed timestamps are **historic fixture values**: signatures/vectors
test canonical bytes only; live traffic MUST use current time and HWC
MUST reject the expired fixture.

From the exact authenticated H2HC CI checkout **after** applying its
existing security/compiler/revocation transformations and this branch's
`apply_private_role_relay.py`:

```bash
mkdir -p examples
cp "$IMPOSTER/ci/agent3-h2hc-kit/native-role-vectors.rs" examples/agent3_role_vectors.rs
cargo run --locked --example agent3_role_vectors -- --hashes > /tmp/role-hashes.json
python3 "$IMPOSTER/ci/agent3-h2hc-kit/generate_role_vectors.py" \
  /tmp/role-hashes.json /tmp/role-public-vectors.json
cargo run --locked --example agent3_role_vectors -- /tmp/role-public-vectors.json
cargo fmt --check && cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

The strict security workflow archives `role-public-vectors.json` ONLY on
a completed successful generator/verification step. No fixture private
keys, real role leaves, Lair keys, bearer or operator secrets are archived.
The gateway live network probe uses three **separately authenticated
Holochain Ed25519 fixture identities** and test ciphertext to validate
routing/authorization; that probe does NOT prove HPKE receiver decryption.
The deterministic crypto vectors establish HPKE interoperability only for
the independent test reference, **not** an Agent 2 browser receiver.

**Agent 2 integration:** implement protected per-cell key creation and
signed attestation validation; build the above fixed transcript and HPKE
AAD in extension-only code; sign via real Lair without exporting its secret;
send exactly two `/ws` frame types; treat `role_queued_v1` as only queue
acceptance; confirm local verified receipt and role-commit/seat binding;
persist replay reservations across browser restart; prove guest C cannot
receive or decrypt guest B's role and no old ciphertext is restored after
revocation. Do NOT unblock inbound remote signals or remote zome calls
to implement this feature.

**Acceptance boundary:** even if Rust, signed WS and HPKE vectors are
all green, private role delivery remains **NOT E2E ACCEPTED** until Agent 2
has independently accepted a real encrypted message in its receiver and
reported negative cases. Keep PR #6 Draft.


## Interoperability delta and two-agent freeze gate (18 Nov 2026)

**Candidate negotiation, NOT a frozen standard.** Agent 2 currently signs
`imposter-hwc/role-delivery/v1\\0` plus its own header, uses
`imposter-hwc/role-hpke/v1` as HPKE info, the header itself as AAD,
a **u16** ciphertext length, **120,000 ms** maximum role lifetime,
and an attestation with a different field order/prefix. That implementation
also lacks `role_request_v1` and signed `in_reply_to` correlation.
**Those bytes cannot pass the current H2HC verifier.**

Proposed wire resolution for review:

- Sign the precise v1 `SIGNED_BYTES` and use the precise `AAD` and
  `info` above; no JSON signature, no UTF-8 hash signing, no key reinterpretation.
- Represent the same canonical HoloHash raw39, u16 seat, u64 key epoch,
  u64 timestamps, presence-tagged reply ID, 32-byte HPKE encapsulation,
  and u32 ciphertext length in both receivers and gateway.
- Use the existing wire `envelope` field names exactly;
  HWC's internal `dna/agent/keyId/createdAt/enc` names may remain
  internal but need explicit, lossless canonical mapping.
- Keep 60s maximum lifetime and 30s future skew at the gateway;
  HWC must reject at least the same invalid windows. Keep per-key
  `not_before_ms/not_after_ms` independent from envelope expiry.
- Use attestation `IMPOSTER-H2HC-ROLE-KEY\\0\\x01`
  || DNA raw39 || agent raw39 || key ID raw16 || X25519 pk raw32
  || epoch u64 BE || not-before u64 BE || not-after u64 BE.
  No JSON/MessagePack serialization is part of its signature.
- Request and reply must be separately signed with operation 0x01/0x02;
  a valid gateway queue acknowledgement is never an application receipt.
- Receiver acceptance requires genuine Lair signer verification,
  exact installed DNA, local recipient and native-verified host,
  matching round/commit/seat/Merkle proof, current attested key epoch,
  correlated request where present, and durable replay reservation
  before decryption/application. No role plaintext in gateway or public DHT.

**Freeze is explicitly BLOCKED pending both written approvals**:
1. Agent 3 approves this exact candidate revision and passing gateway,
   native vectors and live restricted network gates.
2. Agent 2 independently matches its HWC implementation to the *same*
   canonical vector fixture, approves all normative bytes by explicit
   PR comment, and supplies separately verified Lair and receiver gates.

Once both approvals exist, publish a single immutable v1 contract pin
(commit SHA + fixture SHA-256); do not reinterpret candidate revision
as already frozen. Browser/desktop live role delivery remains NOT ACCEPTED
until independent receiver post-decryption proof checks pass.
