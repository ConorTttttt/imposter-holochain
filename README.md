# Imposter — on Holochain + PeerKit

A demo build. The **consensus-critical** parts run as a Holochain hApp:

- **hidden roles** — the host seals a Merkle commitment over the role vector and
  hands each player only their own leaf + proof over a remote signal; the full
  vector is revealed and audited at game end (the blackjack shoe-commitment
  pattern, role byte for a leaf);
- **tamper-evident voting** — commit-reveal votes; the `Ejection` entry is a
  single-author claim that `validate` re-tallies from the cited `VoteReveal`s
  (the blackjack `SettleClaim` pattern);
- **win check** — `GameResult` is likewise re-validated by recomputing the live
  counts from the cited kill / ejection / task evidence.

**Real-time movement** runs alongside over **PeerKit** (`@peerkit/*` libp2p) —
ephemeral position packets, never on the DHT, never validated. **Meeting chat**
and **voice chat** ride the same connections: living players type, dead players
can only read. If the relay is unreachable the game still works fully; you just
don't see other players glide, and there's no chat or voice.

One cloned DNA per game, N members. A lobby code names a **room**: its first
game's network seed is `room1.CODE`, later games in the same room use
`room1.CODE#2`, `room1.CODE#3`, … PeerKit is keyed on the room, so one relay serves them all.

A game can also live in a **host-owned seed**, `g1.<host AgentPubKeyB64>.<32
hex digits>`. The integrity zome reads the cell's own network seed
(`dna_info().modifiers.network_seed`) when it validates a `Lobby`, and only
the agent named in the seed can open one there. Anything else — a malformed
seed, an unknown version, another agent's key — is refused. `room1.` seeds
are the one exemption: the UI still finds a room's games by walking them,
which a random seed can't support until a room points at its current game,
so anyone may open a lobby there, as before. `newGameSeed` in
`ui/src/game/rooms.ts` makes host-owned seeds; the sweettests play every game
in one.

## Layout

```
crates/imposter-core/     pure rules (merkle / roles / tally / vote / wincheck / crisis), `cargo test`
dnas/game/zomes/
  integrity/game_integrity/   entry + link types, validate()
  coordinator/game/           lobby, settings, deal_roles, tasks, kills, meetings, voting,
                              sabotage (lights, comms, doors, crises), try_finish, get_game_state
workdir/happ.yaml        role `game`, clone_limit 1000
tests/tests/full_round.rs 4-agent sweettests, headless
scripts/                 in-nix.sh (enter nix develop), test-each.sh, demo.sh
ui/                      plain TS + Vite; @holochain/client for moves, @peerkit for movement
  src/game/              map (rooms, doors, Maintenance Network, airlock), canvas, HUD, mini-games, sound, chat
  src/peerkit/           movement + voice over PeerKit
  src/relay.ts           PeerKit bootstrap relay (run with tsx)
```

## Prerequisites

- Nix with flakes (the dev shell pins Holochain 0.7.0 via holonix `main-0.7`;
  HDK 0.7.0, HDI 0.8.0)
- Node 22 (the dev shell provides it; the relay and Vite also run on Node 20)
- `@holochain/hc-spin` matching Holochain 0.7.x — `package.json` pins `^0.700.0`;
  adjust if your conductor differs.

## Build & test

```bash
nix develop                       # Holochain 0.7.0 toolchain

cargo test -p imposter-core        # pure rule vectors  (runs anywhere, no nix needed)

# headless full round — the authoritative regression:
npm run build:happ                # zomes -> wasm, then hc dna/app pack
npm run test:round                # tests/tests/full_round.rs, one test per process
npm run test:ui                   # UI logic (node:test via tsx), no conductor needed
```

`full_round.rs` holds 29 tests, one lobby of 4 agents each. The main one,
`impostor_wins_on_parity`, drives: create lobby → 3 joins → `deal_roles` →
per-player tasks (and an impostor's fake task that isn't counted) → impostor
kill → body report → meeting → unanimous Skip (`Ejection` = no ejection) →
second kill (parity) → `reveal_all` + `check_result` → `GameResult` =
**ImpostorsWin**, and asserts the re-tally, the role-reveal proof, and the
recount. The rest cover one rule each: relay sharing, host settings (and their
lock at the deal), secret task lists, kills over remote signals (and a forged
one rejected), host presence, meeting rules, discussion time, tie breakers,
lights, comms and doors sabotage, the crisis sabotages (two-player reactor, and
a crisis running out as an impostor win), the seat cap (a join past it, and two
players racing for the last seat), forged and deleted links being rejected,
host-owned game seeds (only the host opens a lobby in one; malformed seeds are refused), the medbay scan, ghosts finishing their
tasks, and secret ejects with anonymous votes. Running them all
in one process runs out of memory, so `test:round` starts one per process.
The forged-link tests give one agent a tampered coordinator:
`scripts/build-forge-dna.sh` (run by `test:round`) builds the game DNA with
the coordinator's test-only `forge` feature into `tests/forge/game.dna`. Its
integrity zome is the normal build's, so it joins the same network.

> Zome build note: `.cargo/config.toml` adds `--allow-undefined` (host functions
> are imported at runtime) and `getrandom_backend="custom"`. Do **not** pass a
> `RUSTFLAGS` env var when building zomes — it overrides that table. Use
> `npm run build:zomes` / `build:happ` which call plain `cargo build`.
>
> Lockfile note: `Cargo.lock` is committed with a known-good resolution for
> Holochain 0.7.0 (the sweettest tree pulls `iroh`, which pulls pre-release
> `ed25519-dalek` that only compiles at specific pinned versions). **Don't
> delete it or run `cargo update`** — a fresh resolution can pick incompatible
> pre-releases and fail to build. If it happens anyway: `git checkout
> Cargo.lock` and build inside `nix develop`.

## Live demo (4 windows)

The commands below need the `nix develop` shell — it provides Node 22, the
Holochain binaries, and `kitsune2-bootstrap-srv` (hc-spin's local bootstrap
server). `npm run spin`, `build:zomes`, `build:happ` and `test:round` enter it
by themselves (`scripts/in-nix.sh`), and the relay and Vite also run on a plain
Node 20, so a plain terminal works for all of them. Use a separate shell per
long-running process.

```bash
nix develop
npm install                              # root — installs hc-spin
npm run build:happ                       # produces workdir/imposter.happ
( cd ui && npm install )

# optional but nicer — real movement (own shell):
npm run relay                            # any room; game windows find it by themselves

( cd ui && npm run dev )                 # Vite dev server on :5173 — own shell, keep running
npm run spin                             # hc-spin -n 4 --ui-port 5173 workdir/imposter.happ  → 4 windows
```

> `npm run spin` needs the Vite dev server already listening on `:5173`;
> hc-spin loads the UI from that port.

Or all in one: **`npm run demo`** starts the relay and the dev server (reusing
any already running), then spin — `npm run demo -- 6` for six windows.

In each window:

1. **Entry screen** — players enter a name and room code. Choose **Join Game**
   to join an existing room, or **Host Game** to choose players, impostors, tasks
   each and optionally generate a new room code. Hosts choose **Create Game**;
   everyone else chooses **Join Room**. No PeerKit addresses, relay commands or
   debug information appear in the player-facing UI. A green/yellow/red
   connection dot indicates connected/connecting/connection trouble, with
   plain-language errors.
2. Networking is configured behind the scenes: `npm run relay` still starts
   the development relay, whose address is served to local clients by Vite
   and can be shared between room members by the coordinator. Other players
   don't enter it by hand. For more than 4 players, open more windows:
   `npm run demo -- 6`. Players get colors in join order; movement, lobby
   chat and voice require a working PeerKit relay.
3. Host: the lobby shows editable settings — **Crew vision** / **Impostor vision**
   (how far each sees through the fog; ghosts see the whole map), **Kill
   cooldown**, **Discussion** and **Voting** time, **Task bar** (when the crew's
   task count updates: always, at meetings — the default, so nobody can watch
   an impostor's fake task fail to count — or never), **Emergency meetings**
   each, **Player speed**, **Kill distance**, **Confirm ejects** (show a
   voted-off player's role and how many impostors remain) and **Anonymous
   votes** — then **Start game**
   (enabled once the lobby is full). Settings are fixed from then on. Roles are dealt; each window shows its
   own secret badge (CREWMATE / IMPOSTOR).
4. Move with arrow keys / WASD. Everyone starts on the Navigator Bridge. The
   camera follows you, zoomed in — the map (the **Holo-Net Node**, see below) is
   bigger than one screen, so the
   minimap in the top-right corner shows the whole layout, the emergency
   button, task consoles, and only players already visible on the main
   view — nothing it shows gets past fog-of-war that the main view wouldn't
   already show. Rooms have walls with doorways: walls stop you
   (ghosts drift through), hide what's behind them, muffle voices, and you
   can't kill, report or use a console through one. Crewmates walk to their yellow consoles and hit
   **Use** (or <kbd>E</kbd>) to play the task's mini-game (<kbd>Esc</kbd> closes it). Each
   player has a secret task list from the host: your consoles are yellow, and
   turn green when done — only for you. Impostors get a cover list and play the
   same mini-games, but their "tasks" are never recorded. Crewmates who die
   keep doing their tasks as ghosts — they still count, so the crew can always
   finish every task between them. One console is the **Medbay Scan**: holding
   still in the scanner publishes your own role, proved against the host's
   commitment — public, unforgeable proof of crew, from then on (shown as a
   role tag on the vitals panel). An impostor gains nothing from a real one —
   it never counts toward the crew's tasks, and it outs them for nothing — so
   they always fake it, like any other task. The impostor walks next to a crewmate and hits
   **Kill** (the host's kill cooldown, 20 s by default, which also runs at the
   start and after every meeting). The kill carries the impostor's role proof, and the victim's
   client checks it and the cooldown before recording the death, so only the
   impostor can kill.
   The impostor can also **Sabotage lights** (<kbd>L</kbd>; ghosts too): the
   crew's vision drops to a small circle (impostors' only a little) until
   someone holds **Use** at the lights panel in Electrical Systems, then
   there's a 30 s cooldown. The host writes
   every cut on the impostor's behalf, so nobody can tell who pulled it.
   Impostors can also **Sabotage comms** (<kbd>C</kbd>; ghosts too): the crew's
   task list and task bar go dark until someone holds **Use** at the comms
   panel in the Communications Array, then a 30 s cooldown — the same shape as the lights, and
   also written by the host so nobody can tell who pulled it. Impostors can
   also **Lockdown** any room's doors for 10 s (then a 30 s
   cooldown): its doorways turn red and block movement, sight and voices.
   And they can start a **crisis** — **Reactor Emergency**, **Life Support**
   or **Navigation Drift**, one at a time — which the crew must stabilise at
   its consoles before the countdown runs out, or the impostors win. The
   reactor needs two players holding its two consoles at once; Life Support
   needs both of its terminals (opposite sides of the ship); Navigation Drift
   needs all three Forward consoles. No emergency meetings while one runs; a
   body report ends it. And a living impostor at a **Maintenance Network**
   hatch presses <kbd>F</kbd> to slip in — unseen and unheard, hopping along
   linked hatches — then <kbd>F</kbd> again to climb out. Meetings pull them out.
5. A body stays where its victim fell, and the victim becomes a ghost the
   living can't see. A living player near a body hits **Report body**, or walks
   to the red button and hits **Emergency** (one each by default, unlocked 15 s after the
   start and after every meeting) → the meeting screen opens everywhere. A
   meeting clears all bodies, so each is reported at most once. Ghosts can't
   call meetings. The **vitals** panel in the Medical Bay (<kbd>E</kbd>) shows
   everyone as OK, DEAD — as soon as they're killed, reported or not — or
   DISCONNECTED (no movement over PeerKit).
6. During the meeting, living players can **chat** in the box under the vote
   card (PeerKit only). Dead players see the chat but can't type.
7. After the discussion time, everyone **picks a player or Skip** (a hidden
   commit). Each vote reveals itself once every living player has voted, or
   just before voting time runs out. The host's window tallies when everyone
   has revealed or time is up (the host can hit **Tally now** to close voting
   early). The option with the most votes wins: that player is **ejected**,
   or nobody is if Skip wins. The ejection screen says whether they were an
   impostor (unless **Confirm ejects** is off: then roles stay secret until
   the end), and the tally shows who voted for whom (just the counts with
   **Anonymous votes**). **A tie goes to a
   tie breaker**: a second vote with only the tied options on the ballot. If
   that ties too, a draw seeded by the revealed vote salts picks one of them.
8. Back to the game. Play until the host's window auto-publishes the
   `GameResult` (crew win on all tasks / last impostor out, or impostor win on
   parity or a crisis that ran out). The **result screen** shows every role, and how much **XP** you
   earned this game (your own real tasks, surviving, and winning) plus your
   running total, shown on the entry screen too.
9. **Next game** — the host hits **New game**, which opens the room's next
   lobby with the same settings. Everyone else hits **Play again** (before or
   after) and is seated in it automatically; the host starts it as before. No
   restart, same relay address. **Back to menu** returns to the entry screen,
   which skips past finished games. Moving on disables the clones of the
   room's earlier games, so old games stop syncing.

## The Holo-Net Node (greybox)

The map is a **greybox**: flat zone-tinted floors, plain walls, grey blocks
for machinery and crates, room names as debug labels. It is there to find out
whether the map plays well — routes, sightlines, task spread, sabotage
pressure — before any art goes in. Four zones, top to bottom
([game/world.ts](ui/src/game/world.ts) has the layout and an ASCII sketch):

- **Forward** (blue): Navigator Bridge (spawn), Communications Array, Shields
  Control, Weapons Control, Medical Bay (vitals, the scan), Life Support.
- **Central** (green): Commons (the emergency button; four entrances, benches
  breaking it up) and Core Engine (machinery blocks: you see someone go in,
  not what happens inside).
- **Engineering** (orange): Security & Network (cameras and network status;
  you stand still with your back to the door while you watch), Reactor Core
  (two consoles far apart, two exits), Electrical Systems (cramped, the lights
  panel).
- **Cargo** (purple): Cargo Control (five cargo terminals), Storage Bay (open,
  with crates for cover), Decontamination — a two-door airlock: step in, both
  doors shut for 3.5 s, then the far one opens. It joins Storage to Electrical
  along the keel corridor, so the bottom of the ship is a loop, not a dead end.

**Maintenance Network** (impostors only): four local networks — Bridge ·
Shields · Weapons; Medical · Security · Commons; Reactor · Electrical · Core
Engine; Cargo Control · Storage · Decontamination — plus one shortcut,
Security ↔ Reactor.

**Tunables.** In the UI: `TUNING` and the layout arrays at the top of
`world.ts` (airlock time, lights-out vision for crew and impostors, camera
range, rooms, corridors, blocks, doors, tasks, panels, spawns). On the zome
side, because the host enforces them: the door lockdown (`DOOR_CLOSE_MS`, 10
s, in the coordinator) and the crisis timers (`REACTOR_EMERGENCY_MS` 45 s,
`LIFE_SUPPORT_MS` 45 s, `NAV_DRIFT_MS` 60 s, in `imposter-core`'s crisis.rs —
validation re-checks a meltdown against them, so changing them changes the DNA
hash).

Task ids 0–5 keep their mini-games; the rest are placeholders (a plain Run
button) until there's art and design for them.

## Character & XP

Original art: a plain capsule body (still tinted per-player)
with a flat head-plate socket on top. By default that socket shows a
**blockie** — a deterministic identicon generated client-side from the
player's agent key ([game/blockie.ts](ui/src/game/blockie.ts)), the same idea
as Ethereum blockies/Jazzicons: no art, no lookup, and every player has a
distinct, stable "face" the instant they're seen. The socket is designed to
later show an owned head skin instead (see the hNFT roadmap below) — swapping
that in is a one-line change where the blockie is drawn.

Finishing a game earns **XP**: 5 per real task of your own, 10 for surviving,
25 for winning — computed by that game's coordinator once it has ended
([lib.rs "XP" section](dnas/game/zomes/coordinator/game/src/lib.rs)), no new
entry or DNA hash change. There's no durable, cross-game ledger for it: each
game is its own DNA clone (its own network), and a finished game's clone is
disabled once the room moves on, so nothing could read an old game's XP back
afterward regardless. Instead the UI ([game/xp.ts](ui/src/game/xp.ts)) banks
each game's XP the moment it's seen ending — before that clone can be
disabled — and keeps a running total in this browser's `localStorage`. That
total is per-device, not a shared ledger: a different browser or a cleared
profile starts at zero.

**Owned head skins**, from a separate sibling project, **hNFT** (a P2P NFT
marketplace hApp — mint/reveal/transfer). `hc-spin` can't link the two apps:
every launch mints a fresh, random agent key, in its own sandbox, so a window
opened that way can never be the same identity as anything in hNFT. Instead:

```bash
npm run linked-conductor    # own shell, inside nix develop; keeps running
```

This drives one Holochain conductor directly over its admin API
(`scripts/shared-conductor.mjs`) — the same `hc sandbox` invocation `hc-spin`
itself uses, minus the part that mints a new key every time. It installs
imposter-holochain and hNFT side by side under **one** agent key, creates
hNFT's "Imposter Heads" collection (a clone of hNFT's `nft` role) with that
key as the collection's minter, and writes the connection details to
`ui/.shared-conductor.json` — served by the dev server (absent, a 404, the
rest of the time), the same way the relay's address is. With it present,
`Hc.connect()` uses this shared identity instead of `hc-spin`'s; without it,
nothing changes — the normal solo demo doesn't know this exists. A window
connected this way that owns a revealed head (`game/heads.ts`, best-effort:
any failure just falls back to the blockie) shows it in the head socket
instead. **Buying one with XP isn't built** — hNFT's minting is
single-authority by design (that's how it enforces a collection's
`max_supply`), so spending XP for real needs something holding that minter
key to verify a claim and mint+transfer, deliberately left for later; this
is the identity and rendering foundation it would sit on.

## Sound & voice

The bar at the top of every window, once you're in a game:

- **Sound on/off** — synthesized effects: task done, kill, body report,
  emergency, voted off, your role at the start, win/lose, lights out, comms
  down, a crisis alarm, the medbay scan, maintenance hatches, doors slamming. Per window, remembered across
  reloads.
- **Mic on/off** (or <kbd>V</kbd>) — voice chat, off until you turn it on.
  Peer-to-peer WebRTC audio, set up over the PeerKit connections, so it needs
  the relay like text chat. "Talking:" shows who you can hear right now.
- **Deafen** — stop hearing voices (effects are separate).

Who hears whom: everyone, in the lobby, in meetings and on the result screen.
Out on the map a voice carries as far as you can see (your vision radius, or
250 px with no fog), fading out towards the edge. Ghosts are only heard by
other ghosts. With four windows on one machine, keep a single mic on (or use
headphones), or they feed back into each other.

## Known scope cuts (demo)

- Movement, and so kill *distance*, is **client-authoritative** — no
  anti-cheat / lockstep. Who may kill (a role proof), whether both players are
  alive and the cooldown are checked by the victim's client, which is the one
  that records a death.
- **The host is a single point of failure**: it deals, tallies, publishes the
  result and alone knows the roles. When it stops answering (two missed pings,
  about 6–10 s), the other windows show HOST LEFT and offer a new game in the
  same room, which anyone may host. The abandoned game can't be finished; it
  resumes if the host comes back. Two players pressing New game at the same
  moment can open two lobbies.
- Meeting **chat** is PeerKit-only and unauthenticated: a line claims its
  sender's Holochain key, but nothing proves it. Honest clients enforce the
  mute: a dead player's input is disabled, and receivers drop lines from
  anyone who is dead on-chain. A modified client could still spoof a living
  player's name.
- **Voice chat** is unauthenticated like text chat, and its rules (distance,
  ghosts) are applied by the listener: everyone's audio reaches every client,
  and a modified one could play it all. Players on different networks rely on
  public STUN; there is no TURN server, so strict NATs won't connect.
- **Vision fog** is drawn by each client: every position still arrives over
  PeerKit, so a modified client can see through it. The host's setting is a
  coordinator link, not a validated entry.
- The **shared relay address** is unauthenticated too: any player can share
  one and the newest wins. A bogus address only costs movement and chat — the
  game itself never depends on PeerKit.
- The **host learns every role** (host-as-dealer), mitigated only by the commit
  + reveal audit — exactly like the blackjack dealer sees the shoe. The seed is
  `host_entropy XOR sha256(sorted player keys)` so the host can't choose the
  assignment alone, but it does see the result.
- **Task lists** are dealt by the host from the role salt, so they stay secret
  until the end, when the reveal lets anyone check them. Completing a task off
  your list is only stopped by honest clients: the public task count includes
  it, but the host's `GameResult` counts only crewmates' own tasks. The mini-games
  run in each player's own window, so a modified client can skip them.
- A tie breaker that ties again is settled by a draw over the revealed salts;
  the last player to reveal can predict that draw and withhold their reveal.
- The **airlock** runs in each player's own window: its doors only ever shut
  for the player inside, so another player sees them open.
- **Crisis sabotages** are host-checked like the others. A crisis that runs
  out ends the game with a `GameResult` citing the link that started it;
  validation checks that link is the host's and that its time was up, but —
  like any `GameResult`'s evidence — it can't prove nobody fixed it in time.
  The reactor's "two players at once" is two holds by different players
  within 1.5 s of each other.
- **Seats** are capped in the zome: `join_lobby` refuses once the lobby is
  full as far as that node can see. Holochain has no global lock, so two
  players racing for the last seat can both get a join in. Every node then
  seats the same players — the host, then the earliest joins by (timestamp,
  action hash) — and the loser sees "Game full". Timestamps come from each
  joiner's own clock, so this is a deterministic tie-break, not proof of who
  was first. The host's deal is the final word, and validation checks that
  every seat in it cites a real join to the lobby, one per seat.
- **Links** are validated: each must hang off one of the game's anchors,
  point at its own author (or, in the game's index, at the author's own
  entry), and carry a well-formed tag under a size cap; no link can be
  deleted. Who may write which link in game terms (only the host cuts the
  lights, only seated players fix them, …) needs the roles, which a link
  doesn't cite, so readers still filter on that.
- **Walls, doors and vents** are enforced by each client too: positions (and
  the "in a vent" flag) still reach everyone over PeerKit, so a modified client
  can walk through a closed door or see a hidden impostor. The lights, comms
  and doors sabotages themselves are coordinator checks: only the host's
  writes count, and only impostors may ask for them.
- The **medbay scan** self-publishes a `RoleReveal` — the same entry a host
  opens for someone voted off, here validated the same way for a player
  revealing their own seat, so it needs no new validation and no DNA hash
  change. It's real proof of crew (a forged one can't open the commitment
  root), but revealing is a one-way, permanent trade a player makes for
  themselves — nothing stops a crewmate from just not scanning.
- **Anonymous votes** only hide votes on screen: every vote reveal is public
  on the DHT with its author, so a modified client can still see who voted
  for whom. **Player speed** and **kill distance** are enforced by each
  client, like movement. With **Confirm ejects** off the host still knows
  every role, as always.
- Only one map, and it's a greybox. Security cameras show what each camera
  sees from positions every client already has; nobody can tell you're
  watching. No live admin table (the minimap is static layout only, not player
  tracking); win-by-tasks is a counter.
- **XP is per-device, not a shared ledger**: it lives in `localStorage`, keyed
  by finished games this browser has recorded. A different browser, a cleared
  profile, or another device starts at zero. A durable, cross-agent-readable
  total (so e.g. a shop could verify a claim without trusting the client)
  would need a dedicated, uncloned role other cells could call into.
- The player UI never exposes relay addresses. Auto-discovery uses the relay
  descriptor served by Vite on the relay machine, or a relay address shared
  through the game. Remote players need a reachable, correctly advertised relay;
  without one, movement, chat and voice may be unavailable. This is a deployment
  concern, not an in-game setting.
- The **meeting rules** (ghosts can't call meetings, one emergency each with a
  15 s cooldown, one report per body) are coordinator checks, not validation:
  a modified client can skip them. The emergency button's position is only
  checked by the UI, and "since the last meeting" compares different agents'
  clocks.
- `Ejection` / `GameResult` are single-author claims re-validated by replay, not
  countersigned — a claim can be internally consistent yet omit an entry the
  author didn't see (same limitation as blackjack `SettleClaim`); detectable
  off-chain from the DHT.
- Holochain 0.7.0. The patterns come from the blackjack / battleship projects,
  which are on 0.6.3.

## Private room pointers (Phase 3)

New private games use host-owned `g1` seeds. Room-code lookup uses the provisioned
base `game` cell and opens only the resolved game clone. Conflicting host claims
block joining; a short code cannot authenticate the intended host on first use.
See [the data model, validation, conflict policy, retries and migration notes](docs/phase3-room-pointers.md).
Play Again still uses legacy later-round seeds until Phase 4; use explicit
`LEGACY:CODE` to join an older room. Registry lookup never falls back to legacy.
