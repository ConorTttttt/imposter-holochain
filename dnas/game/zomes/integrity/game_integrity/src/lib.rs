//! Integrity zome for the per-lobby Imposter DNA.
//!
//! One clone of this DNA is one game (N members); its network seed names the
//! host — see `parse_game_seed`.
//! Every consensus-critical move is an entry here, and `validate` enforces the
//! rules on it as it lands — a `RoleReveal` whose Merkle proof does not open
//! the committed root, or an `Ejection` whose claimed result does not match a
//! re-tally of the `VoteReveal`s it cites, is *invalid*, not merely ignored, so
//! a cheating client forks its own source chain.
//!
//! Modelled directly on the blackjack `table_integrity` zome: the same
//! commit / per-leaf-proof / full-reveal shape for hidden roles, and the same
//! "re-validate a single-author claim by deterministic replay" shape
//! (`blackjack` `SettleClaim` → here `Ejection` and `GameResult`).
//!
//! What validation cannot prove — exactly as in blackjack — is that a claim is
//! *complete*: an `Ejection` cites the votes its author saw, and a `GameResult`
//! the evidence its author saw. Omissions are detectable off-chain from the
//! DHT, not here.

use hdi::prelude::*;
mod rooms;
pub use rooms::*;
mod recipient_keys;
pub use recipient_keys::*;

use imposter_core::{
    impostor_count, outcome as win_outcome, reveal_matches_root, tally, tally_tie_breaker,
    verify_role_proof, vote_commitment, CrisisTag, Outcome as GameOutcome, RoleProof, TallyOutcome,
    Vote, MAX_PLAYERS, ROLE_CREW, ROLE_IMPOSTOR,
};

// ------------------------------------------------------------------- entries

/// The host opens a lobby. `code` is also the DNA network seed, so agents in
/// different lobbies never share a DHT.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Lobby {
    pub code: String,
    pub player_count: u16,
    pub impostor_count: u16,
    /// Total tasks the crew must finish to win.
    pub task_target: u32,
}

/// A player takes a seat. Published by that player.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct PlayerJoin {
    pub lobby: ActionHash,
    pub player: AgentPubKey,
    pub display_name: String,
}

/// The host seals the role assignment: publishes only the Merkle root plus the
/// canonical seat order. Each player is handed their own leaf + proof over a
/// remote signal (never on the DHT).
#[hdk_entry_helper]
#[derive(Clone)]
pub struct RoleCommit {
    pub lobby: ActionHash,
    pub merkle_root: [u8; 32],
    pub player_count: u16,
    pub impostor_count: u16,
    /// Player keys in seat order (sorted, unique). Index into this is the
    /// "seat" everything else refers to.
    pub seats: Vec<AgentPubKey>,
    /// The `PlayerJoin` behind every seat, the host's own included: proof that
    /// each seated key really joined this lobby.
    pub joins: Vec<ActionHash>,
}

/// One task station.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Task {
    pub id: u16,
    pub name: String,
    pub x: i32,
    pub y: i32,
}

/// The host publishes the round's task list. One shared list for the whole crew
/// (no secret per-player tasking in this demo).
#[hdk_entry_helper]
#[derive(Clone)]
pub struct TaskList {
    pub lobby: ActionHash,
    pub tasks: Vec<Task>,
}

/// A player finishes a task. Any player may author this; a faked completion by
/// an impostor is a game mechanic ("fake tasking"), and only honest clients
/// commit real ones — audited against the role reveal off-chain.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct TaskComplete {
    pub task_list: ActionHash,
    pub task_id: u16,
}

/// The victim's client publishes this on receiving a kill signal.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct KillReport {
    pub lobby: ActionHash,
    pub killer: AgentPubKey,
    pub at_ms: i64,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingTrigger {
    BodyReport,
    Emergency,
}

/// A meeting is called: movement freezes and voting opens.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Meeting {
    pub lobby: ActionHash,
    pub trigger: MeetingTrigger,
    /// The reported body — required when `trigger` is `BodyReport`.
    pub body: Option<AgentPubKey>,
    /// Set on a tie-breaker: the `Ejection` whose outcome was a `Tie`. Only its
    /// tied options may be voted for.
    pub tie_breaker_for: Option<ActionHash>,
}

/// A hidden vote: `commitment = imposter_core::vote_commitment(choice, salt)`.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct VoteCommit {
    pub meeting: ActionHash,
    pub commitment: [u8; 32],
}

/// The matching reveal. `commit` points back at this voter's `VoteCommit` so
/// `validate` can recompute the commitment without enumerating links.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct VoteReveal {
    pub meeting: ActionHash,
    pub commit: ActionHash,
    /// `Some(key)` to vote a player out, `None` for Skip.
    pub choice: Option<AgentPubKey>,
    pub salt: [u8; 32],
}

/// A claimed meeting result. `validate` re-tallies the cited `VoteReveal`s —
/// under the tie-breaker rules when the meeting is a tie-breaker.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Ejection {
    pub meeting: ActionHash,
    pub role_commit: ActionHash,
    pub outcome: TallyOutcome,
    /// The `VoteReveal`s this claim was built from, in any order.
    pub reveals: Vec<ActionHash>,
}

/// One player's role, opened against the commitment. Published for the ejected
/// player at each meeting, and for everyone at game end.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct RoleReveal {
    pub role_commit: ActionHash,
    pub seat: u16,
    pub role: u8,
    pub proof: RoleProof,
}

/// The host opens the whole role vector for audit.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct RolesReveal {
    pub role_commit: ActionHash,
    pub roles: Vec<u8>,
    pub salt: [u8; 32],
}

/// A claimed end-of-game result. `validate` recomputes the live counts from the
/// cited evidence and re-runs the win check.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct GameResult {
    pub lobby: ActionHash,
    pub roles_reveal: ActionHash,
    pub outcome: GameOutcome,
    pub impostors_alive: u32,
    pub crew_alive: u32,
    pub tasks_done: u32,
    pub tasks_total: u32,
    /// `KillReport` / `Ejection` / `TaskComplete` actions, in any order.
    pub evidence: Vec<ActionHash>,
    /// Set when a crisis sabotage ran out: the host's `CreateLink` that
    /// started it. The impostors win however the counts stand.
    pub meltdown: Option<ActionHash>,
}

/// The host's one secret: the role vector and master salt behind the
/// commitment. A private entry — stays on the host's source chain, never
/// published — so a restarted host can still hand out proofs and, later,
/// reveal. Its honesty is proved by `RolesReveal`, not here.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct SealedRoles {
    pub lobby: ActionHash,
    pub roles: Vec<u8>,
    pub salt: [u8; 32],
}

// ---------------------------------------------------------------- game seeds

/// A game's network seed names its host: `g1.<host AgentPubKeyB64>.<random id>`,
/// the random id being 32 lowercase hex digits (128 bits). Only the agent in
/// the seed can open a lobby in it, so nobody can open a game in someone
/// else's name, and two hosts can never open competing lobbies in one network.
pub const GAME_SEED_VERSION: &str = "g1";
/// Hex digits in a game seed's random id.
pub const GAME_SEED_ID_LEN: usize = 32;
/// The room-code games the UI still finds by walking `room1.CODE`,
/// `room1.CODE#2`, … — anyone may open those, as before. Kept until the room
/// pointer replaces the walk; nothing else is exempt.
pub const LEGACY_ROOM_PREFIX: &str = "room1.";

/// Who may open a lobby in a network.
#[derive(Debug, Clone, PartialEq)]
pub enum SeedOwner {
    /// Only this agent.
    Host(AgentPubKey),
    /// Anyone: a legacy room-code game.
    LegacyRoom,
}

/// Read a network seed. Anything that isn't a well-formed game seed or a
/// legacy room seed is an error, worded for whoever reads the rejection.
pub fn parse_game_seed(seed: &str) -> Result<SeedOwner, String> {
    const SHAPE: &str = "invalid game seed: expected g1.<host key>.<random id>";
    if seed.is_empty() {
        return Err("invalid game seed: the network seed is empty".into());
    }
    if let Some(code) = seed.strip_prefix(LEGACY_ROOM_PREFIX) {
        return if code.is_empty() {
            Err("invalid game seed: a room seed needs a room code".into())
        } else {
            Ok(SeedOwner::LegacyRoom)
        };
    }
    let parts: Vec<&str> = seed.split('.').collect();
    let version = parts[0];
    if version != GAME_SEED_VERSION {
        let looks_versioned = version.len() > 1
            && version.starts_with('g')
            && version[1..].chars().all(|c| c.is_ascii_digit());
        return Err(if looks_versioned {
            format!("unsupported game seed version: {version}")
        } else {
            SHAPE.into()
        });
    }
    let [_, host, id] = parts[..] else {
        return Err(SHAPE.into());
    };
    let host = AgentPubKeyB64::from_b64_str(host)
        .map_err(|_| "invalid game seed: the host isn't an agent key".to_string())?;
    if id.len() != GAME_SEED_ID_LEN || !id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err(format!(
            "invalid game seed: the random id must be {GAME_SEED_ID_LEN} lowercase hex digits"
        ));
    }
    Ok(SeedOwner::Host(host.into()))
}

#[cfg(test)]
mod seed_tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];
    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn agent() -> AgentPubKey {
        AgentPubKey::from_raw_32(KEY.to_vec())
    }

    #[test]
    fn a_game_seed_names_its_host() {
        let seed = format!("g1.{}.{ID}", AgentPubKeyB64::from(agent()));
        assert_eq!(parse_game_seed(&seed), Ok(SeedOwner::Host(agent())));
        assert_eq!(parse_game_seed("room1.LOBBY-DEMO#2"), Ok(SeedOwner::LegacyRoom));
    }

    #[test]
    fn anything_else_is_refused() {
        let key = AgentPubKeyB64::from(agent()).to_string();
        let dna = DnaHashB64::from(DnaHash::from_raw_32(KEY.to_vec())).to_string();
        let cases = [
            ("".to_string(), "empty"),
            ("room1.".to_string(), "room code"),
            ("g1".to_string(), "expected g1"),
            ("g1.foo".to_string(), "expected g1"),
            ("not-a-game-seed".to_string(), "expected g1"),
            ("LOBBY-DEMO".to_string(), "expected g1"),
            (format!("g2.{key}.{ID}"), "unsupported game seed version: g2"),
            (format!("g1.not-a-key.{ID}"), "isn't an agent key"),
            (format!("g1.{dna}.{ID}"), "isn't an agent key"),
            (format!("g1.{key}.xyz"), "random id"),
            (format!("g1.{key}.{}", ID.to_uppercase()), "random id"),
            (format!("g1.{key}.{ID}.extra"), "expected g1"),
        ];
        for (seed, why) in cases {
            let err = parse_game_seed(&seed).expect_err(&seed);
            assert!(err.contains(why), "{seed}: {err}");
        }
    }
}

// ---------------------------------------------------------------- link tags

/// Every link in this DNA is a `GameToEntry` link off one of these path
/// anchors. Validation tells them apart by base address.
pub const ANCHOR_GAME: &str = "game";
pub const ANCHOR_LIGHTS: &str = "lights";
pub const ANCHOR_COMMS: &str = "comms";
pub const ANCHOR_DOORS: &str = "doors";
pub const ANCHOR_CRISIS: &str = "crisis";
pub const ANCHOR_RELAY: &str = "relay";
pub const ANCHOR_BODIES: &str = "bodies";
pub const ANCHOR_SETTINGS: &str = "settings";

/// The base address of a path anchor. Only the hash is used: the path entry
/// itself is never committed.
pub fn anchor_hash(name: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(name).path_entry_hash()?.into())
}

/// One flip of the lights, as a link tag on the lights anchor.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LightsSwitch {
    Cut,
    Fixed,
}

/// One flip of comms, as a link tag on the comms anchor. Same shape as
/// `LightsSwitch`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CommsSwitch {
    Cut,
    Fixed,
}

/// Where a killed player's body lies, in map px.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct BodyAt {
    pub x: i32,
    pub y: i32,
}

/// The host's settings, picked in the lobby and fixed once roles are dealt: how
/// far crew and impostors see (map px, 0 for no fog; ghosts always see
/// everything), the kill cooldown, and the meeting timers (0 voting seconds for
/// no time limit). The player, impostor and task counts aren't here: they're in
/// the `Lobby` entry, set when it was created. Like the relay address, these
/// are link tags on their own anchor; validation only checks they're well
/// formed and point at their author; readers keep only the host's (see
/// `validate_create_link`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct GameSettings {
    pub crew_vision: u16,
    pub impostor_vision: u16,
    pub kill_cooldown_s: u16,
    pub discussion_s: u16,
    pub voting_s: u16,
    /// When the crew's task count updates in the HUD: 0 always, 1 only when a
    /// meeting opens, 2 never. Live updates let a watcher spot a faked task.
    pub task_bar: u8,
    /// Emergency meetings each player may call per game (0: none).
    pub emergency_meetings: u8,
    /// Walking speed, percent of normal. Movement runs in each player's window.
    pub player_speed: u16,
    /// How close an impostor must stand to kill: 0 short, 1 normal, 2 long.
    /// Checked in the impostor's window, like movement.
    pub kill_distance: u8,
    /// Whether the host opens a voted-off player's role straight away. Off:
    /// roles stay secret until the game ends.
    pub confirm_ejects: bool,
    /// Whether the tally hides who voted for whom. Only this view hides it:
    /// every `VoteReveal` is still public on the DHT, with its author.
    pub anonymous_votes: bool,
}

impl Default for GameSettings {
    /// Matches the UI's default presets (game/settings.ts, game/world.ts).
    fn default() -> Self {
        Self {
            crew_vision: 170,
            impostor_vision: 250,
            kill_cooldown_s: 20,
            discussion_s: 15,
            voting_s: 60,
            task_bar: 1,
            emergency_meetings: 1,
            player_speed: 100,
            kill_distance: 1,
            confirm_ejects: true,
            anonymous_votes: false,
        }
    }
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Lobby(Lobby),
    PlayerJoin(PlayerJoin),
    RoleCommit(RoleCommit),
    TaskList(TaskList),
    TaskComplete(TaskComplete),
    KillReport(KillReport),
    Meeting(Meeting),
    VoteCommit(VoteCommit),
    VoteReveal(VoteReveal),
    Ejection(Ejection),
    RoleReveal(RoleReveal),
    RolesReveal(RolesReveal),
    GameResult(GameResult),
    #[entry_type(visibility = "private")]
    SealedRoles(SealedRoles),
    RoomPointer(RoomPointer),
    RecipientKeyAttestation(RecipientKeyAttestation),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// From the single per-DNA game anchor to every entry, so any client can
    /// enumerate the whole game.
    GameToEntry,
    RoomToPointer,
    RecipientKeyByAgent,
}

// ---------------------------------------------------------------- validate

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => {
            validate_entry(app_entry, action)
        }
        FlatOp::CreateEntry(OpEntry::UpdateEntry { .. }) => {
            invalid("entries are append-only")
        }
        FlatOp::Update(_) => invalid("entries are append-only"),
        FlatOp::Delete(_) => invalid("entries are append-only"),
        // A link is checked both where its record is stored and where it's
        // indexed under its base, so a bad one is refused at commit time too.
        FlatOp::Link(OpLink::CreateLink { action, link_type })
        | FlatOp::CreateRecord(OpRecord::CreateLink { action, link_type }) => match link_type {
            LinkTypes::GameToEntry => validate_create_link(&action),
            LinkTypes::RoomToPointer => validate_pointer_link(&action),
            LinkTypes::RecipientKeyByAgent => validate_recipient_key_link(&action),
        },
        FlatOp::Link(OpLink::DeleteLink { .. }) | FlatOp::CreateRecord(OpRecord::DeleteLink { .. }) => {
            invalid("links are append-only")
        }
        _ => valid(),
    }
}

// ---------------------------------------------------------------- links

/// The longest tag each anchor's links carry, in bytes. Generous: real tags
/// are a few dozen bytes, a relay address ~200, the settings ~150.
const MAX_SMALL_TAG: usize = 64;
const MAX_SETTINGS_TAG: usize = 256;
const MAX_RELAY_TAG: usize = 512;

/// Every link is a `GameToEntry` link off one of the path anchors. What can be
/// checked from the link alone is checked here: which anchor, who wrote it,
/// what it points at, and that its tag is well formed and small. Who may
/// write it in game terms (only the host cuts the lights, only a seated
/// player fixes them, …) needs the lobby and the roles, which a link doesn't
/// cite, so readers filter on that — see the coordinator.
fn validate_create_link(action: &TypedAction<CreateLinkData>) -> ExternResult<ValidateCallbackResult> {
    let author = action.author();
    let base = &action.base_address;
    let tag = action.tag.clone().into_inner();
    let target_is_author = action.target_address == AnyLinkableHash::from(author.clone());

    if *base == anchor_hash(ANCHOR_GAME)? {
        // The game's index: each entry, linked by whoever wrote it.
        if !tag.is_empty() {
            return invalid("a game index link carries no tag");
        }
        let Some(target) = action.target_address.clone().into_action_hash() else {
            return invalid("a game index link must point at an action");
        };
        let record = must_get_valid_record(target.clone())?;
        if pointer_from_record(&record)?.is_some() {
            return invalid("room pointers require their room index");
        }
        let target = must_get_action(target)?;
        if target.action().author() != author {
            return invalid("you can only index your own entries");
        }
        if !matches!(target.action().data, ActionData::Create(_)) {
            return invalid("a game index link must point at a created entry");
        }
        return valid();
    }

    // Every other link points at its own author, so a link can't be passed
    // off as someone else's.
    if !target_is_author {
        return invalid("this link must point at its author");
    }
    let decodes = |max: usize, ok: bool| -> ExternResult<ValidateCallbackResult> {
        if tag.len() > max {
            invalid("link tag is too long")
        } else if !ok {
            invalid("link tag is malformed")
        } else {
            valid()
        }
    };
    use holochain_serialized_bytes::decode;
    if *base == anchor_hash(ANCHOR_LIGHTS)? {
        decodes(MAX_SMALL_TAG, decode::<_, LightsSwitch>(&tag).is_ok())
    } else if *base == anchor_hash(ANCHOR_COMMS)? {
        decodes(MAX_SMALL_TAG, decode::<_, CommsSwitch>(&tag).is_ok())
    } else if *base == anchor_hash(ANCHOR_DOORS)? {
        decodes(MAX_SMALL_TAG, decode::<_, u8>(&tag).is_ok_and(|room| room < 32))
    } else if *base == anchor_hash(ANCHOR_CRISIS)? {
        let ok = match decode::<_, CrisisTag>(&tag) {
            Ok(CrisisTag::Fix { kind, panel }) => panel < kind.panels(),
            Ok(CrisisTag::Start { .. }) => true,
            Err(_) => false,
        };
        decodes(MAX_SMALL_TAG, ok)
    } else if *base == anchor_hash(ANCHOR_RELAY)? {
        let ok = std::str::from_utf8(&tag).is_ok_and(|a| !a.trim().is_empty());
        decodes(MAX_RELAY_TAG, ok)
    } else if *base == anchor_hash(ANCHOR_BODIES)? {
        decodes(MAX_SMALL_TAG, decode::<_, BodyAt>(&tag).is_ok())
    } else if *base == anchor_hash(ANCHOR_SETTINGS)? {
        decodes(MAX_SETTINGS_TAG, decode::<_, GameSettings>(&tag).is_ok())
    } else {
        invalid("links may only hang off the game's anchors")
    }
}

fn valid() -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
fn invalid(why: impl Into<String>) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(why.into()))
}

fn validate_entry(
    entry: EntryTypes,
    action: TypedAction<CreateData>,
) -> ExternResult<ValidateCallbackResult> {
    // 0.7: common fields left the variant payload — `Create.author` is now
    // `TypedAction::author()` (borrowed off `action.header`). Bind it once so the
    // per-entry checks below stay plain value comparisons.
    let author = action.author().clone();
    match entry {
        EntryTypes::RoomPointer(p) => validate_pointer(p, &author),
        EntryTypes::RecipientKeyAttestation(a) => validate_recipient_key(a, &author, action.timestamp()),
        EntryTypes::Lobby(l) => {
            if l.code.is_empty() {
                return invalid("lobby code is empty");
            }
            // Whose game this network is: read from the cell's own network
            // seed, the same on every validator.
            match parse_game_seed(&dna_info()?.modifiers.network_seed) {
                Err(why) => return invalid(why),
                Ok(SeedOwner::Host(host)) if host != author => {
                    return invalid("game seed host does not match lobby author")
                }
                Ok(_) => {}
            }
            if l.player_count < 3 || l.player_count as usize > MAX_PLAYERS {
                return invalid("player_count must be 3..=64");
            }
            if l.impostor_count == 0 || l.impostor_count >= l.player_count {
                return invalid("impostor_count must be in 1..player_count");
            }
            valid()
        }

        EntryTypes::PlayerJoin(j) => {
            let _ = get_lobby(&j.lobby)?;
            if j.player != author {
                return invalid("you can only seat yourself");
            }
            valid()
        }

        EntryTypes::RoleCommit(rc) => {
            let (lobby, host) = get_lobby(&rc.lobby)?;
            if author != host {
                return invalid("only the host commits roles");
            }
            if rc.player_count != lobby.player_count || rc.impostor_count != lobby.impostor_count {
                return invalid("role commit disagrees with the lobby config");
            }
            if rc.seats.len() != rc.player_count as usize {
                return invalid("seat list length must equal player_count");
            }
            if !is_sorted_unique(&rc.seats) {
                return invalid("seat list must be sorted and free of duplicates");
            }
            // Every seat is a real join to this lobby, one join per seat. This
            // proves who sits, not that they were the first to join: nothing
            // in validation can see the joins it isn't shown.
            if rc.joins.len() != rc.seats.len() {
                return invalid("one join per seat");
            }
            let mut joined: Vec<AgentPubKey> = Vec::with_capacity(rc.joins.len());
            for h in &rc.joins {
                let (j, joiner) = record_app_entry::<PlayerJoin>(h)?;
                if j.lobby != rc.lobby {
                    return invalid("a cited join is for another lobby");
                }
                push_unique(&mut joined, joiner);
            }
            joined.sort_by(|a, b| a.get_raw_39().cmp(b.get_raw_39()));
            if joined != rc.seats {
                return invalid("the seats aren't the players whose joins are cited");
            }
            valid()
        }

        EntryTypes::TaskList(tl) => {
            let (_lobby, host) = get_lobby(&tl.lobby)?;
            if author != host {
                return invalid("only the host publishes the task list");
            }
            if tl.tasks.is_empty() {
                return invalid("task list is empty");
            }
            let mut ids: Vec<u16> = tl.tasks.iter().map(|t| t.id).collect();
            ids.sort_unstable();
            ids.dedup();
            if ids.len() != tl.tasks.len() {
                return invalid("task ids must be unique");
            }
            valid()
        }

        EntryTypes::TaskComplete(tc) => {
            let list = get_task_list(&tc.task_list)?;
            if !list.tasks.iter().any(|t| t.id == tc.task_id) {
                return invalid("task id is not in the referenced task list");
            }
            valid()
        }

        EntryTypes::KillReport(kr) => {
            let _ = get_lobby(&kr.lobby)?;
            if kr.killer == author {
                return invalid("a kill report cannot name its own author as the killer");
            }
            valid()
        }

        EntryTypes::Meeting(m) => {
            let _ = get_lobby(&m.lobby)?;
            if m.trigger == MeetingTrigger::BodyReport && m.body.is_none() {
                return invalid("a body report must name the body");
            }
            if let Some(tied) = &m.tie_breaker_for {
                let (ej, _) = get_ejection(tied)?;
                if !matches!(ej.outcome, TallyOutcome::Tie { .. }) {
                    return invalid("a tie-breaker must follow a tied vote");
                }
            }
            valid()
        }

        EntryTypes::VoteCommit(vc) => {
            let _ = get_meeting(&vc.meeting)?;
            valid()
        }

        EntryTypes::VoteReveal(vr) => {
            let (commit, commit_author) = get_vote_commit(&vr.commit)?;
            if commit_author != author {
                return invalid("a reveal must open the caller's own commit");
            }
            if commit.meeting != vr.meeting {
                return invalid("reveal and commit are for different meetings");
            }
            let choice_bytes = vr.choice.as_ref().map(|k| k.get_raw_39().to_vec());
            if vote_commitment(choice_bytes.as_deref(), &vr.salt) != commit.commitment {
                return invalid("reveal does not open the commitment");
            }
            let (meeting, _) = get_meeting(&vr.meeting)?;
            if let Some((candidates, rc)) = tie_breaker_ballot(&meeting)? {
                let on_ballot = match &vr.choice {
                    None => candidates.contains(&None),
                    Some(key) => rc
                        .seats
                        .iter()
                        .position(|k| k == key)
                        .is_some_and(|i| candidates.contains(&Some(i as u16))),
                };
                if !on_ballot {
                    return invalid("a tie-breaker vote must be for one of the tied options");
                }
            }
            valid()
        }

        EntryTypes::Ejection(ej) => validate_ejection(ej),

        EntryTypes::RoleReveal(rr) => {
            let (rc, host) = get_role_commit(&rr.role_commit)?;
            let seat_ok = rc
                .seats
                .get(rr.seat as usize)
                .map(|k| *k == author)
                .unwrap_or(false);
            if author != host && !seat_ok {
                return invalid("only the host or the seated player may reveal a role");
            }
            if !verify_role_proof(&rc.merkle_root, rr.seat, rr.role, &rr.proof) {
                return invalid("role proof does not open the commitment root");
            }
            valid()
        }

        EntryTypes::RolesReveal(rr) => {
            let (rc, host) = get_role_commit(&rr.role_commit)?;
            if author != host {
                return invalid("only the host reveals the full role vector");
            }
            if rr.roles.len() != rc.player_count as usize {
                return invalid("revealed role vector has the wrong length");
            }
            if impostor_count(&rr.roles) != rc.impostor_count as usize {
                return invalid("revealed role vector has the wrong impostor count");
            }
            if !reveal_matches_root(&rr.roles, &rr.salt, &rc.merkle_root) {
                return invalid("revealed role vector does not rebuild the committed root");
            }
            valid()
        }

        EntryTypes::GameResult(gr) => validate_game_result(gr, action.timestamp()),

        // Private, local-only.
        EntryTypes::SealedRoles(_) => valid(),
    }
}

fn validate_ejection(ej: Ejection) -> ExternResult<ValidateCallbackResult> {
    let (rc, _host) = get_role_commit(&ej.role_commit)?;
    let (meeting, _) = get_meeting(&ej.meeting)?;
    let ballot = tie_breaker_ballot(&meeting)?;

    // Dedup reveals by voter; map each choice to a seat index.
    let mut seen_voters: Vec<AgentPubKey> = Vec::new();
    let mut votes: Vec<Vote> = Vec::new();

    for h in &ej.reveals {
        let (vr, voter) = get_vote_reveal(h)?;
        if vr.meeting != ej.meeting {
            return invalid("a cited reveal is for a different meeting");
        }
        if seen_voters.contains(&voter) {
            continue;
        }
        seen_voters.push(voter.clone());

        let choice_seat = match &vr.choice {
            None => None,
            Some(key) => match rc.seats.iter().position(|k| k == key) {
                Some(i) => Some(i as u16),
                None => return invalid("a cited reveal votes for a non-player"),
            },
        };
        let voter_seat = rc
            .seats
            .iter()
            .position(|k| k == &voter)
            .map(|i| i as u16)
            .unwrap_or(0);
        votes.push(Vote {
            voter: voter_seat,
            choice: choice_seat,
            salt: vr.salt,
        });
    }

    let recount = match &ballot {
        None => tally(&votes),
        Some((candidates, _)) => tally_tie_breaker(&votes, candidates),
    };
    if recount != ej.outcome {
        return invalid("claimed ejection disagrees with a re-tally of its cited reveals");
    }
    valid()
}

fn validate_game_result(gr: GameResult, at: Timestamp) -> ExternResult<ValidateCallbackResult> {
    let (lobby, host) = get_lobby(&gr.lobby)?;
    let roles_reveal = get_roles_reveal(&gr.roles_reveal)?;
    let (rc, _) = get_role_commit(&roles_reveal.role_commit)?;
    let seats = &rc.seats;
    let roles = &roles_reveal.roles;
    if roles.len() != seats.len() {
        return invalid("role vector and seat list disagree");
    }

    let mut dead: Vec<AgentPubKey> = Vec::new();
    let mut done: Vec<(AgentPubKey, u16)> = Vec::new();

    for h in &gr.evidence {
        let record = must_get_valid_record(h.clone())?;
        let author = record.action().author().clone();
        let entry = record.entry().as_option().cloned();
        let Some(entry) = entry else { continue };

        if let Ok(kr) = KillReport::try_from(&entry) {
            let _ = kr;
            push_unique(&mut dead, author);
        } else if let Ok(ej) = Ejection::try_from(&entry) {
            if let TallyOutcome::Ejected { seat } = ej.outcome {
                if let Some(k) = seats.get(seat as usize) {
                    push_unique(&mut dead, k.clone());
                }
            }
        } else if let Ok(tc) = TaskComplete::try_from(&entry) {
            let key = (author, tc.task_id);
            if !done.contains(&key) {
                done.push(key);
            }
        }
    }

    let mut impostors_alive = 0u32;
    let mut crew_alive = 0u32;
    for (i, k) in seats.iter().enumerate() {
        if dead.contains(k) {
            continue;
        }
        match roles[i] {
            ROLE_IMPOSTOR => impostors_alive += 1,
            ROLE_CREW => crew_alive += 1,
            _ => return invalid("role vector holds a value that is neither crew nor impostor"),
        }
    }
    let tasks_done = done.len() as u32;

    if gr.impostors_alive != impostors_alive
        || gr.crew_alive != crew_alive
        || gr.tasks_done != tasks_done
    {
        return invalid("claimed live counts disagree with a recount from the cited evidence");
    }
    if gr.tasks_total != lobby.task_target {
        return invalid("claimed task total is not the lobby's target");
    }
    if let Some(start) = &gr.meltdown {
        return validate_meltdown(&gr, start, &host, at);
    }
    if win_outcome(
        gr.impostors_alive,
        gr.crew_alive,
        gr.tasks_done,
        gr.tasks_total,
    ) != Some(gr.outcome)
    {
        return invalid("claimed outcome is not what the win check returns for these counts");
    }
    valid()
}

/// A crisis ran out: the cited link must be the host starting one, and the
/// result must come after its time was up. What this can't prove — as with a
/// `GameResult`'s evidence — is that nobody fixed it in time: that absence is
/// checkable from the DHT, not here.
fn validate_meltdown(
    gr: &GameResult,
    start: &ActionHash,
    host: &AgentPubKey,
    at: Timestamp,
) -> ExternResult<ValidateCallbackResult> {
    if gr.outcome != GameOutcome::ImpostorsWin {
        return invalid("a meltdown is an impostor win");
    }
    let signed = must_get_action(start.clone())?;
    let action = signed.action();
    if action.author() != host {
        return invalid("only the host starts a crisis");
    }
    let ActionData::CreateLink(link) = &action.data else {
        return invalid("a meltdown must cite the link that started the crisis");
    };
    let Ok(CrisisTag::Start { kind }) =
        holochain_serialized_bytes::decode::<_, CrisisTag>(&link.tag.clone().into_inner())
    else {
        return invalid("the cited link doesn't start a crisis");
    };
    let started = action.timestamp().as_millis();
    if at.as_millis() < started + kind.duration_ms() {
        return invalid("the crisis hadn't run out yet");
    }
    valid()
}

// ------------------------------------------------------- must_get helpers

fn record_app_entry<T>(hash: &ActionHash) -> ExternResult<(T, AgentPubKey)>
where
    for<'a> T: TryFrom<&'a Entry>,
{
    let record = must_get_valid_record(hash.clone())?;
    let author = record.action().author().clone();
    let entry = record
        .entry()
        .as_option()
        .and_then(|e| T::try_from(e).ok())
        .ok_or_else(|| {
            wasm_error!(WasmErrorInner::Guest(
                "referenced record has no matching app entry".into()
            ))
        })?;
    Ok((entry, author))
}

fn get_lobby(hash: &ActionHash) -> ExternResult<(Lobby, AgentPubKey)> {
    record_app_entry::<Lobby>(hash)
}
fn get_role_commit(hash: &ActionHash) -> ExternResult<(RoleCommit, AgentPubKey)> {
    record_app_entry::<RoleCommit>(hash)
}
fn get_meeting(hash: &ActionHash) -> ExternResult<(Meeting, AgentPubKey)> {
    record_app_entry::<Meeting>(hash)
}
fn get_ejection(hash: &ActionHash) -> ExternResult<(Ejection, AgentPubKey)> {
    record_app_entry::<Ejection>(hash)
}
fn get_vote_commit(hash: &ActionHash) -> ExternResult<(VoteCommit, AgentPubKey)> {
    record_app_entry::<VoteCommit>(hash)
}
fn get_vote_reveal(hash: &ActionHash) -> ExternResult<(VoteReveal, AgentPubKey)> {
    record_app_entry::<VoteReveal>(hash)
}
fn get_task_list(hash: &ActionHash) -> ExternResult<TaskList> {
    Ok(record_app_entry::<TaskList>(hash)?.0)
}
fn get_roles_reveal(hash: &ActionHash) -> ExternResult<RolesReveal> {
    Ok(record_app_entry::<RolesReveal>(hash)?.0)
}

/// A tie-breaker's ballot: the options tied in the vote it follows, plus the
/// role commit their seats index into. `None` for an ordinary meeting, where
/// any player or Skip may be voted for.
fn tie_breaker_ballot(meeting: &Meeting) -> ExternResult<Option<(Vec<Option<u16>>, RoleCommit)>> {
    let Some(tied) = &meeting.tie_breaker_for else {
        return Ok(None);
    };
    let (ej, _) = get_ejection(tied)?;
    let TallyOutcome::Tie { candidates } = ej.outcome else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "a tie-breaker must follow a tied vote".into()
        )));
    };
    let (rc, _) = get_role_commit(&ej.role_commit)?;
    Ok(Some((candidates, rc)))
}

fn is_sorted_unique(keys: &[AgentPubKey]) -> bool {
    keys.windows(2)
        .all(|w| w[0].get_raw_39() < w[1].get_raw_39())
}

fn push_unique(v: &mut Vec<AgentPubKey>, k: AgentPubKey) {
    if !v.contains(&k) {
        v.push(k);
    }
}
