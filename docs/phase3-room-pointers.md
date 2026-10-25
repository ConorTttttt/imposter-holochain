# Phase 3: private room → current game

The existing provisioned `game` role is the shared registry. Its DNA network
seed is empty. Each game remains a clone of that same DNA with its own network
seed. No additional DNA, discovery index, advertisements, or signaling were
added. `happ.yaml` already provisions this cell and needs no structural change.
All players must install the same new integrity DNA and base modifiers: changing
integrity changes the DNA hash. This is not a rolling upgrade onto an old DHT.

## Model and integrity

Public `RoomPointer` entry (appended after existing entry types):

```
version: 1
room_code_hash: [u8; 32]
game_seed: g1.<host AgentPubKeyB64>.<32 lowercase hex digits>
host: AgentPubKey
round: u32 (1..=1,000,000)
previous: Option<ActionHash>
```

Round 1 has no predecessor; round N must cite a valid round N−1 pointer for the
same hash and host, with a different game seed. This is an append-only sequence,
not a timestamp contest or an entry update. Links use the new `RoomToPointer`
type, from `Path("private-room-v1.<hash hex>")` to the pointer's action, with an
empty tag. There is no root index of these paths and no plaintext room code in
registry entries, links, or tags.

Integrity enforces the empty base-cell seed, schema/version/hash shape, bounded
seed and round, parsed `g1` format, author = pointer host = encoded seed host,
valid predecessor record/type/ownership/room/round, and different game seed.
Unknown entry fields are rejected. A hash is a nonzero fixed 32-byte identifier;
validators cannot prove that it is the hash of an actual short code without
publishing that code. The coordinator derives it from normalized input.

Each registry link must target a valid created `RoomPointer` action, have the
correct per-code base, carry no tag, and be authored by that pointer's host.
Pointers cannot be indexed through `GameToEntry`. All entry updates, entry
deletions and link deletions remain forbidden, including deletions by the host.
No unconditional link validation was introduced. Test-only forgery externs are
compiled only with the existing `forge` feature.

## Normalization and API

Both clients and coordinator trim surrounding ASCII whitespace, uppercase ASCII,
and accept 4–32 ASCII letters, digits and hyphens with at least one alphanumeric.
Non-ASCII codes and internal spaces are rejected. The room identifier is
SHA-256 of UTF-8 `imposter/private-room/v1:` followed by the normalized code.

Base-cell externs:

* `publish_room_pointer({room_code, game_seed, round, previous}) → {action, pointer}`.
* `resolve_room_pointer(room_code) → {status: not_found | unavailable | conflict}`
  or `{status: found, current: {action, pointer}}`.

Publishing recovers an identical entry from the host's local source chain,
including one whose link failed, then repairs its index. It refuses a different
seed/configuration for a locally existing room round. This is retry safety, not
a global uniqueness guarantee. Duplicate indexing links are harmless and readers
deduplicate by action hash. Different hosts can still make valid competing roots.

## Resolution and conflicts

For the visible record set, resolution is deterministic and independent of link
order and author timestamps:

1. Fetch and type-check all records under the exact room hash; a missing record
   makes the room unavailable, rather than silently selecting an older entry.
2. More than one host means conflict. Never pick the first or newest host.
3. More than one distinct action for a host's same round means conflict, including
   duplicate roots and round forks by a modified coordinator.
4. Require a complete consecutive predecessor chain starting at round 1. Gaps or
   inconsistent predecessor indexes mean temporarily unavailable.
5. Return the highest consecutive round of the sole unambiguous host.

The UI remembers the first resolved host and highest observed round/seed in
local storage, scoped by player identity and normalized room code. Later reads
cannot change hosts, regress rounds, or replace a seed at the same round. A
newer valid round may advance the pin. Pins survive a reload, but clearing local
storage removes them. A conflict asks the host to choose a new code; it does not
try to delete or override another host's claim.

This policy prefers interruption to silently changing rooms. It cannot prove a
first-time user's intended host from a short code. A malicious host can claim a
code first or publish a competing valid pointer, causing denial of service.
Incomplete DHT views can temporarily appear unambiguous, hide newer rounds, or
omit a conflicting host. Pins prevent observed regressions and host changes;
they do not provide global finality. Creation also refuses to reuse a pinned code
without its existing pending receipt, even if the registry temporarily appears
empty. Even once a pin exists, an observed conflict
blocks joining rather than hiding competing claims.

## UI, retries, stale pointers, and clone count

Create Private Game checks the base registry, saves one random `g1` seed and
creation configuration in a local pending receipt, opens that game clone,
creates the lobby and host seat, then publishes the pointer. The ready lobby
screen displays the shareable code after publication succeeds. Retries and
reloads reuse the same seed/configuration. `create_lobby` also repairs locally
interrupted creation and joins instead of creating another lobby entry.
Pending receipts are intentionally retained for recovery; using another code
creates another game. A DHT absence check improves the experience but reserves
nothing and cannot prevent races.

Joining resolves in the base cell first, opens only the selected clone, checks
its state and available seats, and joins. It never creates a lobby. The UI shows
messages for invalid code, absent pointer, unavailable room, conflicting records,
full game, and started game. Polling retries absent/delayed records without
creating game instances. Seat races remain governed by existing gameplay rules.

Lookup takes **zero clone operations** for nonexistent, conflicting, or unresolved
rooms; a found room takes **at most one createCloneCell operation**, reused on
subsequent reads. No candidates are cloned while searching the new registry.

Pointers do not expire or disappear. Stale pointers to missing/unreachable games
show temporary unavailability; full/started/ended games are not joined as new
players. An existing seat can be rejoined. The host advances the round with a
new signed pointer. Readers never infer a new game from absence and never fall
back to a legacy room when registry resolution fails.

## Round progression and temporary legacy compatibility

The backend publish/update mechanism is implemented and tested: create the next
host-owned clone and lobby, then publish round N+1 citing the current pointer
hash. Readers resolve the new seed according to the chain policy.

The results screen, `watchNextGame`, and Play Again still use the existing
`room1.CODE#N` walk after the initial pointer-selected game. The selected initial
`g1` seed is retained for polling, relay calls, and cleanup. Play Again retains
its former host-offline takeover behavior in these legacy rounds. It does **not**
publish pointer updates yet. Consequently, a fresh room-code join/reload still
resolves the old pointer while an existing session plays a legacy later round;
for a later legacy round, use the explicit `LEGACY:CODE` join path. Completing
that handoff is Phase 4. No new remote signaling or results redesign is included.

`room1.*` seed validation is unchanged. Legacy joining is explicit through the
`LEGACY:` input prefix; it never activates because a new-style lookup failed.
Only this explicit legacy path and existing Play Again can walk legacy clones.
New private-game creation always uses `g1` seeds. Legacy input is normalized to
the same restricted alphabet as new codes; old nonconforming or case-sensitive
codes remain DNA-valid but are not reachable through this compatibility input.

## Security limits and Phase 4 recommendations

Hashing short codes hides plaintext metadata, not guessing. Registry pointers
are public DHT data: they reveal host identity and game seed to anyone who can
find the hash. Codes are invitation conveniences, not access control. There are
no membrane proofs; knowing/guessing a seed can open its clone and request a seat.

The base cell cannot verify that a lobby in another DNA is ready. Host ownership
is cryptographically validated; ready-before-publish is the honest client flow.
A malicious host can point to a nonexistent game it owns. Readers check the
selected game and wait; they do not construct its lobby.

Before Phase 4, use this predecessor API for Play Again and replace legacy next
round probing with base-cell pointer polling. Retain the established host pin;
do not transfer a code on host failure. Persist the current pointer action along
with round/seed so interrupted host round creation can reuse its exact next
seed and predecessor. Define how users intentionally retire/change a code and
how long local receipts/pins are retained. For stronger first-contact identity,
consider a longer invitation carrying an authenticated host/root fingerprint;
a short code alone cannot supply that guarantee.

API references checked for this implementation: [HDK 0.7 link API changes](https://docs.rs/crate/hdk/0.7.0/source/CHANGELOG.md)
and [HDI 0.8](https://docs.rs/hdi/0.8.0/hdi/). Compilation and conductor tests use
the project's pinned Holochain 0.7 / HDI 0.8 toolchain.

## Files changed for Phase 3

* `dnas/game/zomes/integrity/game_integrity/{Cargo.toml,src/lib.rs,src/rooms.rs}`
* `dnas/game/zomes/coordinator/game/src/{lib.rs,rooms.rs}`
* `ui/src/{holochain.ts,main.ts}`
* `ui/src/game/{rooms.ts,registry.ts,registry.test.ts,holochain.test.ts,ui.ts,ui.test.ts}`
* `tests/tests/full_round.rs`, `scripts/build-forge-dna.sh`, `Cargo.lock`
* `README.md`, `docs/phase3-room-pointers.md`

The working tree already contained Phase 1/2 changes and renames when this task
started; those were preserved. Generated DNA/hApp and UI build artifacts are
rebuilt locally and ignored by Git. No changes were committed.

## Verification results

| Check | Result |
| --- | --- |
| All sweettests, run in separate processes | **29 passed** (25 existing + 4 new) |
| Core unit tests and integration vectors | **19 passed** |
| Integrity unit tests | **3 passed** |
| Coordinator resolution unit test | **1 passed** |
| UI tests in the project Node 22 environment | **60 passed** |
| TypeScript typechecking | **Passed** |
| Normal and forge DNA builds, hApp packing | **Passed** |
| Production UI build | **Passed**, with the existing large-chunk warning |
| Four-window live demo smoke check | **Passed**: absent-room lookup opened zero clones in all windows; host created and published a private game; three players joined by code; every window had exactly one clone with the same `g1` seed; host started the game and all four windows entered play. PeerKit showed all three peers live. |

The demo was actually launched and exercised through the UI, using a temporary
local debugging harness. It was a creation/join/start smoke check, not an entire
manually played GUI round. Game completion, sabotage, meetings and voting were
verified by the sweettests. Delayed registry/lobby visibility is simulated by UI
tests; real peer propagation is also exercised by the conductor tests.

Legacy Play Again still permits the former host-offline takeover in unowned
`room1` rounds. Registry host pins protect pointer resolution; they do not upgrade
that legacy handoff's ownership rules. Immutable history also means registry
storage and lookup work grow with the number of rounds/claims; there is no global
quota or expiry in Phase 3.
