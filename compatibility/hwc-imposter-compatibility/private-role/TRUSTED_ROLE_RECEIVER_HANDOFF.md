# Agent 2 — restricted private-role receiver integration handoff

**18 Nov 2026.** Branch `validation/agent2-hwc-integration`, Draft PR #5.
Existing accepted HWC compatibility patch `apply.py`, storage migration and
remote provenance protections are **unchanged**. This handoff distinguishes
three stages: (1) independent cryptographic and protected-store tests;
(2) deny-only HWC frame routing with strict offscreen sender validation;
(3) genuine installed-cell receiver and native-game-state acceptance,
**NOT YET ENABLED**.

## Sources added

- `private-role/installed-cell.mjs` obtains the enabled *installed* HWC
  context's exact DNA and Lair agent, creates or loads its persisted
  non-extractable X25519 key, creates a genuine per-cell Lair signature
  using injected privileged HWC `signByPubKey`, checks the original
  revision-2 attestation signature and HPKE possession, then durably
  stores the signed public key with its held private key. A valid
  *fixture-DNA* Lair signing test already exists; this helper has **not**
  yet been connected to the real installed browser extension.
- `private-role/installed-native-enrollment.mjs` maps those original bytes
  to Agent 4's new `game::publish_signed_recipient_key_attestation`
  and `game::lookup_recipient_key`. Its simulated integration tests require
  the native round-trip to return the same signed key ID/epoch, never a
  forged recipient. The native coordinator, not the browser or gateway,
  must supply the trusted read-only zome executor.
- `private-role/native-enrollment.mjs` accepts ONLY Agent 4's
  `{status:"observed",current_unproven:true,view:{action,attestation}}`
  response from a privileged native coordinator adapter; validates DNA,
  agent, original Ed25519 attestation and validity window again. The native
  entry validator checks the actual action author and typed entry.
- `private-role/store.mjs`: non-destructive IndexedDB v1→v2 migration
  adds a `trusted` record family with a persistent per-(DNA,agent) epoch
  floor. Same-epoch key equivocation, skipped/rolled-back epochs, renewal
  validity rewind, expired key and revoked epoch are denied. The existing
  `cells` and `replay` stores remain, and replay reservations survive
  browser-process restarts.
- `private-role/merkle.mjs`: independently duplicates
  `imposter-core::merkle` role opening: SHA-256 tagged leaf, seat u16 BE,
  sixteen-byte salt and six SHA-256 sibling steps (64 leaves). The
  **candidate inner private-role body** is role byte + salt16 + six
  siblings32 = 209 bytes; it requires joint review with Agent 3 before
  declaring a frozen inner payload format.
- `private-role/request-attestation.mjs`: **candidate inner request body**
  containing ONLY signed public key attestation metadata (215 bytes);
  zero role secret, bearer or X25519 private key. The outer revision-2
  signed wire and RFC9180 HPKE info/AAD remain unchanged.
- `private-role/trusted-receiver.mjs`: strict privileged factory; no
  webpage event listener or generic `call_remote` or
  `send_remote_signal` export. Accepts only an installed (DNA,agent),
  a signed authenticated H2HC WS lease, and privileged current game
  and key-enrollment readers. A cold host MUST refuse role encryption
  until Guest B sends a fresh, signed, HPKE-protected
  `role_request_v1` containing that guest's signed attestation, and
  the host rechecks the native DHT observation and durable epoch floor.
  The host sends a correlated `role_delivery_v1` only after checking
  the current host/commit/seat/root and full opening. Recipient verifies
  signed host, exact recipient, key/epoch, current round/commit, replay,
  request ID, expiration and Merkle opening, and returns ONLY an
  extension-local secure receipt with `coordinatorInvoked:false`.
  No role is emitted into pages, DHT, logs or shared browser storage.
- `private-role/apply_restricted_hwc_handler.py`: **separate,
  deny-only source patch** for pinned HWC after accepted `apply.py`.
  It recognizes the two role frame types only on authenticated H2HC WS,
  forwards ciphertext over the extension's offscreen-only runtime route,
  checks the actual Chrome `MessageSender` id/url/tab, and always responds
  `NATIVE_ROLE_STATE_BRIDGE_UNAVAILABLE`. This is safe staging, **not an
  enabled encrypted receiver**. The separate
  `agent2-role-staged-hwc-handler.yml` typechecks/builds this staged
  HWC patch. It does not claim that native state or a role ever reached
  the extension service.

## Independent acceptance evidence and limits

1. Existing `agent2-role-preflight.yml`: exact Agent 3 public
   native-reference fixture checksum
   `065435eee01a44b2111627636136efa21a777954de8cd86786d0d8d044fbd6e4`,
   two signed revision-2 wire operations, synthetic real WebCrypto role
   request/delivery with distinct host, B and C signing keys, B-only
   HPKE acceptance, wrong DNA/author/round/commit/seat/proof denials,
   request correlation, replay and revocation.
2. `agent2-role-chromium-persistence.yml`: two fresh Chromium
   **processes** share one protected profile and confirm X25519 key,
   duplicate replay, monotonic rotation and signed-recipient
   epoch/revocation persisted across restart. This is a platform-level
   browser test, NOT three installed HWC identities receiving a role.
3. Existing pinned HWC full compatibility, strict session lifecycle,
   browser Lair fixture signing and migration remain independent green
   gates. The staged deny-only patch has its own new CI gate; record
   its final conclusion, not its existence, as evidence.
4. Agent 4's independent genuine native recipient-key enrollment CI
   **44309180176 SUCCESS** uses two native 0.7 conductors; source
   `05e2344835f64ae6b8ebc8bfc1a1f2c990bdc044`. It does NOT show
   Agent 2 installed browser key publication, a recipient role handshake
   or a decrypted role.

## Hard security blockers — must remain disabled until solved

1. **Native current-round reader**: Agent 4 must expose a restricted,
   independently native-validated view containing the exact current
   Lobby action and author, RoleCommit action, author, root, seat order,
   phase and current-round marker. `game::get_game_state` currently does
   not expose all this proof. No untyped DHT fetch, page `nativeValidated`
   flag, locally forged context or alternate host may be accepted.
2. **Genuine HWC binding**: instantiate the service in the HWC
   extension/offscreen with installed context, true Lair signer, strict
   WS authenticated session incarnation/lease, trusted native coordinator
   read/execution bridge and origin-isolated private IndexedDB. Reject
   any generic page or `chrome.runtime` caller; verify replay across
   actual Chrome restarts, revocation and key rotation. Existing
   `apply_restricted_hwc_handler.py` is deliberately deny-only.
3. **Three genuine installed HWC/Lair identities**: complete Guest B
   enrollment/host validation, correlated signed restricted H2HC
   request/delivery, B-only decrypt and Merkle check, Guest C denial,
   replay/expired epoch after full Chromium restart and revocation,
   plus log/DHT/shared storage leak audit. No gateway
   `role_queued_v1` ACK counts as a role receipt.
4. **Remote coordinator provenance**: do not invoke
   `recv_remote_signal` with `ChainAuthor` or outer
   `from_agent`. Until an independently authenticated HWC executor
   can represent true remote provenance safely, accept only a
   secure **extension-local** receipt; keep game execution disabled.

**Release decision:** current isolated crypto/keystore and native enrollment
building blocks are NOT a completed encrypted three-player game or
browser↔desktop role interoperability. Keep PRs #4/#5/#6 Draft.

## 18 Nov — tightened actual-entry contract (Agent 2 only)

`native-state.mjs` now checks an extension-only native reader response
`{dna,phase,roles_dealt,lobby:{action,author,entry},roleCommit:{action,author,entry}}`.
Here `entry` fields are **actual** Lobby (`code,player_count,impostor_count,task_target`)
and RoleCommit (`lobby,merkle_root,player_count,impostor_count,seats,joins`)
fields. No `Lobby.round`, `RoleCommit.round`, invented `active`, or
page-supplied `nativeValidated` is used. The **native** reader must select
current action hashes and establish native Valid status for both typed Create
records and canonical PlayerJoin records, conflict absence, and consistent
`get_game_state.phase/roles_dealt`; a JS contract validator alone is not a
native Valid result. Agent 4 has not yet supplied this reader, so the HWC
handler remains deny-only. Signed published enrollment action hash and
lookup action hash must now agree byte-for-byte before success.

## Agent 4 native RoleCommit v1 observed contract (newly available)

Agent 4's current Draft PR #4 adds `game::get_authoritative_game_view` response
`{schema_version:1,dna,network_seed,host,lobby_action,lobby,role_commit_action,
merkle_root,seats:[{seat,agent,join_action,display_name}],phase,observed_only:true}`
and host-only `game::host_role_opening({expected_lobby,expected_role_commit,
expected_recipient,expected_seat})`, returning one `{role_commit,recipient,seat,
role,proof:{role_salt,path}}`. The `native-state.mjs` validator maps these
**actual fields** to the restricted service and checks the bound action, seated
host/guest identity, sorted seat order, native join action hashes, Merkle root
and active phase. `sendRole({seat})` no longer takes a proposed private role
from its caller: it requires the privileged native single-seat opening and
revalidates that opening against the native root *after* a live signed request.

**Still disabled in HWC:** the privileged executor adapter must pin the actual
native Lobby/RoleCommit action hashes (from genuine installed-cell actions),
call Agent 4's exact query from the installed cell, and use its native Valid
result without arbitrary page-supplied hashes. Agent 4's `observed_only:true`
is NOT global DHT finality. The browser must also implement protected role
signing/enrollment, authenticated WS request/delivery, and same-cell durable
replay; the staged patch does none of that yet. Do not count native-only
acceptance or a queued H2HC ACK as an extension-decrypted role.
