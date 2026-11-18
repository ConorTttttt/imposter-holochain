# Agent 4 — Native RoleCommit boundary (provisional HWC v1 contract)

**18 November 2026.** Branch `feature/browser-compatibility-harness`, PR #4 **Draft**.
Agent 2 has given **conditional field-level approval** of this exact v1
schema on [Draft PR #4](https://github.com/ConorTttttt/imposter-holochain/pull/4#issuecomment-6981151436),
but durable recipient-side RoleCommit identity and real installed-HWC encrypted
role-delivery acceptance are **outstanding**. This native boundary must not
be represented as an HWC secure private-role transport release.

## Model and non-negotiable identifiers

The actual public integrity entries are:

* `Lobby { code, player_count, impostor_count, task_target }`
* `PlayerJoin { lobby: ActionHash, player: AgentPubKey, display_name }`
* `RoleCommit { lobby: ActionHash, merkle_root: [u8;32],
  player_count, impostor_count, seats: Vec<AgentPubKey>,
  joins: Vec<ActionHash> }`

There is **no game `round` field** on any of these entries. `RoomPointer.round`
is a separate registry pointer across separately seeded game DNAs and
**must never** be copied into a RoleCommit. The **exact native Valid
RoleCommit `Create` action hash**, not a merkle-root hash, mutable label,
page-reported round, timestamp, or entry hash, is the role-delivery commitment
identity.

Every installed `g1.<host>.<random-id>` clone is one game. The native
coordinator reads the *actual* `dna_info()?.hash` and network seed. The
privileged HWC receiver must independently compare these with the enabled
installed App/Cell and authenticated Lair agent; an untrusted webpage cannot
provide those values.

## Read-only zome API

`game::get_authoritative_game_view(input: NativeGameViewQuery) ->
NativeGameViewV1` uses **network `get_links` + `must_get_valid_record`**
for every game-index record and every cited accepted PlayerJoin action, and
fails closed rather than skipping a missing/invalid index. It never uses
page-provided `nativeValidated`/`active` or other Boolean attestation.

Request (MessagePack/serde fields; Holochain hashes are native 39-byte
objects, not arbitrary strings):

```ts
type NativeGameViewQuery = {
  expected_lobby: ActionHash;                 // exact, independently pinned
  expected_role_commit: ActionHash | null;    // required for role/seat binding
  expected_recipient: AgentPubKey | null;     // both or neither with seat
  expected_seat: number | null;               // u16
};
```

A `null` expected commitment is **discovery only**: it can report an
observed commitment, but cannot authorize any recipient seat. Before role
operations, pin the observed action in the extension's protected state and
re-query with `expected_role_commit` set to that **same exact action hash**,
along with the intended recipient and seat. No caller may replace that pin
with a value supplied by a webpage. If the actual observed commitment
disagrees, or cannot be retrieved as native Valid, the request errors.

Successful response:

```ts
type NativeGameViewV1 = {
  schema_version: 1;
  dna: DnaHash;                  // actual installed zome cell
  network_seed: string;
  host: AgentPubKey;             // exact Lobby action author, checked vs g1 seed
  lobby_action: ActionHash;
  lobby: {
    code: string;
    player_count: number;        // u16
    impostor_count: number;      // u16
    task_target: number;         // u32
  };
  role_commit_action: ActionHash | null;
  merkle_root: number[] | null;  // 32 bytes; null while in lobby
  seats: Array<{
    seat: number;                // u16, index into canonical sorted seats
    agent: AgentPubKey;          // actual PlayerJoin action author and player
    join_action: ActionHash;     // exact native Valid PlayerJoin Create action
    display_name: string;
  }>;
  phase: 'lobby'|'playing'|'meeting'|'ended';
  observed_only: true;           // WARNING, not an authority Boolean
};
```

Seats are strictly sorted by raw 39-byte AgentPubKey as in RoleCommit.
**Do not index `RoleCommit.joins[seat]` directly:** legacy commits may
store join hashes in host-first join order. The API resolves every join
action to its native Valid author, checks `PlayerJoin.player == author`
and `PlayerJoin.lobby == lobby_action`, requires a unique witnessed
join for every committed seat and returns those witnesses in canonical
sorted seat order. Before the deal, `seats` are **candidate seats only**
and must not authorize a private role.

The phase is computed from the independently read game records:
`lobby` until commitment; `playing` after commitment; `meeting` while
the latest meeting remains unresolved or tied; `ended` after a GameResult.
Contradictory results, multiple commitments, conflicting lobby actions,
multiple ejections of one meeting, missing records, host mismatch, and stale
expected actions error. A source-chain or DHT peer's *observed valid* records
cannot establish global absence of a later/forked host action. Treat
`observed_only` as an explicit limitation; never invert it to infer
finality or freshness.

## Host-only commitment and opening (NO remote signals)

`game::commit_roles_only(null) -> { role_commit: ActionHash, seats:
AgentPubKey[] }` authorizes the actual Lobby host only. It creates the
host's private `SealedRoles { lobby, roles, salt }` and public native Valid
`RoleCommit` **without calling `send_remote_signal`**. It returns no role
vector, salt or Merkle opening. Host retry checks the local source chain
for the original `RoleCommit`, verifies the corresponding unique private
seal/root, repairs a missing anchor index, and returns the **same action**;
it does not create a second commitment or seal after failed delivery.
Public conflicting commitments fail closed. The preexisting desktop
`deal_roles(null)` remains available and uses this recovery helper before
its legacy remote signals; do not use `deal_roles` for secure HWC role
delivery. `send_remote_signal` and generic `call_remote` are still
disabled in the HWC path.

`game::host_role_opening(input) -> HostRoleOpening`:

```ts
type HostRoleOpeningQuery = {
  expected_lobby: ActionHash;
  expected_role_commit: ActionHash;
  expected_recipient: AgentPubKey;
  expected_seat: number;
};
type HostRoleOpening = {
  role_commit: ActionHash;
  recipient: AgentPubKey;
  seat: number;
  role: number; // 0=crew, 1=impostor
  proof: { role_salt: number[]; path: number[][] }; // 16 bytes, 6x32 bytes
};
```

Only the native **host cell** can open the host's private seal. Before
returning one recipient opening the zome re-reads native Valid Lobby,
RoleCommit and signed join evidence; checks exact recipient/seat/action;
verifies the local private seal recomputes the public Merkle root; and
checks the per-seat Merkle proof. Any other agent, wrong seat, wrong lobby,
stale commitment, ambiguous game state or missing private seal errors.
The opening is **plaintext until HWC encrypts it**: it must remain exclusively
inside the trusted host background/offscreen compartment. Do **not** expose
this result to a webpage, a content script, a generic HTTP route, arbitrary
`chrome.runtime` messages, a WebSocket before HPKE sealing or logs.
The existing host `deal_roles` returns a host-only full-vector legacy
response for desktop compatibility; do not invoke that API from HWC.

## Agent 2 `trusted-receiver.mjs` mapping — v1 schema conditionally approved, receiver pending

The predecessor Agent 2 receiver at source
`d9abab04559cb059e0de6c3499ed1915943fe74b` assumed
`lobby.round`, `commit.round`, `state.currentRound`, and page-shaped
`active` flags. **Agent 2 has since staged** `native-state.mjs`,
`native-authority.mjs`, and a revised `trusted-receiver.mjs` in Draft PR #5
at `c5cf6730b04e09a97d79b7bb2381d8a797158e5a`. Those files now
consume these exact v1 fields and host-private opening calls, as documented
in PR #5's Agent 2 checkpoint. They remain **deny-only / not installed in
real HWC role delivery**. These are mandatory receiver-integration rules
and outstanding review conditions:

1. In the extension-owned `native.readCurrentGame(cell)`, assert the
   extension's enabled installed `contextId`, exact `cell.dna` and
   `cell.agent` from its own HWC context/Lair; query the specific installed
   clone's `game` zome with extension-maintained `expected_lobby`,
   `expected_role_commit`, recipient and seat. Do not accept a data object
   or verification flag from `window`/a content script.
2. The receiver should read `role_commit_action`, `lobby_action`,
   `host`, `merkle_root`, and sorted `seats[i].agent` directly from this
   native response. Derive `commit.author = lobby.author = host` **only
   after** native author validation, compare `dna` with its own installed
   cell, and require `phase` to permit an active role delivery
   (`playing`/`meeting`, not `lobby`/`ended`). Preserve the full
   canonical per-seat `join_action` evidence in the trusted snapshot.
3. The receiver's existing `currentGame`/test fixtures must stop using
   `round` and `currentRound`. A re-authenticated or revoked socket
   lease still cancels pending deliveries. The key-epoch trusted floor,
   in-reply-to ID, per-recipient nonce ledger and HPKE transcript remain
   unchanged. `current_unproven` recipient-key lookup still requires
   the live signed restricted `role_request_v1` confirmation; the
   native game view does **not** strengthen key freshness.
4. The host-side `sendRole({seat,role,roleSalt,path})` API must not
   accept role/opening bytes from page-supplied parameters. After a
   live, authenticated recipient request, invoke
   `host_role_opening({expected_lobby, expected_role_commit,
   expected_recipient, expected_seat})` from trusted extension code,
   convert `proof.role_salt` and `proof.path` to `Uint8Array`,
   build the existing 209-byte `encodeRoleOpening(role,roleSalt,path)`,
   verify it against the native `merkle_root`, then HPKE encrypt under
   the recipient's independently checked installed-cell key.
5. The recipient's `receiveRoleDelivery` must compare the exact native
   `role_commit_action` in the ciphertext AAD, committed seat/agent,
   host sender, own DNA/agent, and fresh request ID, and independently
   verify the opening against `merkle_root`. No generic zome call and
   no `call_info().provenance` replacement with a page-provided sender.
   Keep private role memory in the privileged receiver until presentation
   through an explicitly reviewed, recipient-scoped UI API.

**Agent 2 staging follow-up:** The two-step native observation/identical
commitment requery must be supplemented by an **extension-protected
RoleCommit action pin across successive requests and browser restarts**;
otherwise changing an observed but unproven DHT candidate may silently
change the commitment identity. Normalize `RoleProof.role_salt` and each
`RoleProof.path` sibling from the native serde representation into
`Uint8Array(16)` and six `Uint8Array(32)` before calling
`encodeRoleOpening`; the restricted sender must fail closed on any length,
root or action mismatch. These review notes were posted to Draft PR #5.

The native endpoint does **not** create a signed quorum certificate, prove
global latest-commit finality, authenticate HWC's own extension compartment,
confirm possession of X25519 private keys, or deliver a role. Those remain
distinct integration gates. Agent 2 must explicitly agree the precise field
names and types before describing the adapter as accepted.


## Pinned cross-branch schema fixture (contract coverage, not installed-HWC E2E)

Agent 2 explicitly accepted the **names, field types and omission of invented
round values** at [PR #4 comment 6981151436](https://github.com/ConorTttttt/imposter-holochain/pull/4#issuecomment-6981151436).
No change is required to the native v1 zome response or the original
game integrity rules. Approval to *interpret the schema* is **not** approval
to activate the privileged receiver.

Added `scripts/agent4-rolecommit-v1-contract.test.mjs`, executed by
`.github/workflows/agent4-recipient-key-native.yml` using immutable Agent 2
source **`c5cf6730b04e09a97d79b7bb2381d8a797158e5a`**:
`native-state.mjs`, `native-authority.mjs`, and `merkle.mjs`. The test
fails on any Rust public struct field/type drift; feeds the actual round-free
v1 *response layout* through Agent 2's validator with HoloHashes encoded
as byte arrays (39-byte hash kind/type prefix), canonical sorted agents,
non-positional join witnesses, exact action and DNA identity, active phase,
and missing/incorrect hash/seat/root negatives. It checks the adapter's
native discovery → exact-action requery and host-opening call, and exercises
the native `RoleProof` serde **number-array representation** (16-byte
`role_salt`, six 32-byte siblings) converted to the strict 209-byte
JavaScript opening and checked against a real computed Merkle root.

**Scope limitation:** this is a pinned cross-language contract *fixture*,
not a captured real native MessagePack result, an installed-cell executor,
a persistent protected commitment pin, or an encrypted end-to-end role
delivery. Its fixture performs proof normalization explicitly; Agent 2's
production host adapter must still perform it before encryption. CI evidence
must be reported for the new head separately from the already passing native
Holochain `44320254863` and three-browser `44320189807` baseline.

### Remaining Agent 2 receiver acceptance gates

* The exact native Valid `role_commit_action` must be selected only after
  protected installed-cell/Lobby binding and then **persisted across requests
  and browser restarts**, scoped to installed DNA, Lobby and host; any
  substitution, corruption, stale or ambiguous observed state must fail closed.
  A new game requires explicit independent rebinding; the page may never reset
  or reassign the pin.
* Normalize and validate role, per-seat `RoleProof.role_salt` and all path
  siblings *inside the privileged native adapter*. Preserve sender/recipient
  identity, current phase, network seed, full canonical signed join evidence,
  Merkle root and exact commitment through role request and delivery.
* Call only the trusted installed-cell native executor and host-only private
  opening, never expose plaintext to page/content script/generic messages.
  Never infer finality from `observed_only`, nor X25519 key freshness from
  `current_unproven`. Keep fresh signed recipient confirmation, lease
  revocation, durable epoch floor and replay protections.
* Independently pass real installed HWC Host/Guest B/Guest C encrypted
  receipt, wrong-recipient exclusion, restart/replay and revoked-session
  tests before enabling the role transport.

## Genuine native acceptance and evidence

CI workflow `.github/workflows/agent4-recipient-key-native.yml` was
repurposed for this **new** native game-boundary acceptance; the previous
recipient-key accepted runs **44309180176** and **44309852341** are historical
and are not retested as the new protocol boundary.

**PASS — independently confirmed native Holochain 0.7** in GitHub Actions
[run 44320254863](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44320254863)
on test commit `d93520f57c2f3fcb190ebf55a3c79d1dec4eb2d1` (unchanged
coordinator since `83a08228e9430f342611fdd4bf73992783de2781`).
The production and forge-test DNA builds passed. Two genuine 0.7
SweetConductor tests passed, **2 passed; 0 failed**; the second used the
forge-only coordinator against the **unchanged native integrity zome**.
The native Valid host commitment was independently retrieved from the guest
cell with exactly this **RoleCommit Create action hash**:

```text
uhCkk7gneBt_u4u9tNZcHTig9N2tWXfv-WK9j3_xobTO_Mm-RwwXa
```

Exact log evidence: `NATIVE_GAME_VALID_LOBBY_AND_JOINS=PASS`,
`NATIVE_GAME_EXACT_COMMIT_INDEPENDENT_READ=PASS`,
`NATIVE_GAME_NO_SIGNAL_COMMIT_AND_IDEMPOTENT_RETRY=PASS`,
`NATIVE_GAME_WRONG_HOST_DENIED=PASS`,
`NATIVE_GAME_WRONG_LOBBY_DENIED=PASS`,
`NATIVE_GAME_WRONG_RECIPIENT_SEAT_DENIED=PASS`,
`NATIVE_GAME_STALE_COMMIT_DENIED=PASS`,
`NATIVE_GAME_MISMATCHED_JOIN_NATIVE_INVALID=PASS`, and
`NATIVE_GAME_INVALID_RECORD_FAIL_CLOSED=PASS`. Native source-chain secrecy,
response-shape and exact Merkle opening are tested in the genuine zome path.
Evidence is retained in
[artifact 14436071933](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44320254863/artifacts/14436071933).
This is native-validated observed DHT state, *not global commitment finality*.

The independent three-browser host/join/restart workflow is
`.github/workflows/browser-poc-hwc-multiplayer.yml`. The rerun
[44320189807](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44320189807)
**PASS** on the same coordinator source with three separate browser/Lair
identities, native DHT game convergence and restart recovery. Browser lobby
regression passing does **not** imply encrypted role delivery passes.

**Deployment state:** PR #4 **Draft**, secured HWC role transport **disabled**
pending Agent 2 response + separately accepted end-to-end encrypted receiver.
