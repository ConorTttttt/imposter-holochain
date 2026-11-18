//! Coordinator zome for the per-lobby Imposter DNA.
//!
//! One clone of this DNA (network seed = lobby code) is one game. The externs
//! here are the moves a client makes; `game_integrity::validate` enforces the
//! rules on each entry as it lands.
//!
//! Structure follows the blackjack `table` coordinator: a single `Path` anchor
//! that every entry is linked from so any client can enumerate the game, a
//! cooked read (`get_game_state`) the UI projects from, and the host's one
//! secret kept as a private `SealedRoles` entry so a restarted host can still
//! hand out proofs and reveal.
//!
//! Real-time movement is NOT here — that runs over PeerKit in the UI. This zome
//! only sees the consensus-critical moves.

use hdk::prelude::*;
mod rooms;
mod recipient_keys;
use sha2::{Digest, Sha256};

use imposter_core::crisis::{resolved_at as crisis_resolved_at, Fix as CrisisFix};
use imposter_core::{
    assign, build_layers, commitment_root, mix_seed, outcome as win_outcome, role_proof, tally,
    tally_tie_breaker, verify_role_proof, Outcome as GameOutcome, RoleProof, TallyOutcome, Vote,
    CrisisKind, CrisisTag, ROLE_CREW, ROLE_IMPOSTOR,
};
use game_integrity::*;
use imposter_core::role_auth::authorize_role_delivery;

// ------------------------------------------------------------------- init

#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    // Let the host push each player their role leaf, and let an impostor push a
    // kill, via `send_remote_signal` → `recv_remote_signal`.
    //
    // `provide_role` is the pull counterpart: a player who missed the
    // fire-and-forget `RoleDealt` signal calls it on the host (`call_remote`)
    // to fetch their own leaf. The host guards it — it only ever returns the
    // caller's own seat, from the host's private `SealedRoles`.
    let mut fns = std::collections::HashSet::new();
    fns.insert((zome_info()?.name, FunctionName::from("recv_remote_signal")));
    fns.insert((zome_info()?.name, FunctionName::from("provide_role")));
    // `ping` answers anyone, so players can tell whether the host is still there.
    fns.insert((zome_info()?.name, FunctionName::from("ping")));
    // `provide_tasks` hands a player their own secret task list, as
    // `provide_role` hands them their role.
    fns.insert((zome_info()?.name, FunctionName::from("provide_tasks")));
    // `host_cut_lights`: impostors ask the host to write their sabotage.
    fns.insert((zome_info()?.name, FunctionName::from("host_cut_lights")));
    fns.insert((zome_info()?.name, FunctionName::from("host_cut_comms")));
    fns.insert((zome_info()?.name, FunctionName::from("host_close_doors")));
    fns.insert((zome_info()?.name, FunctionName::from("host_start_crisis")));
    create_cap_grant(ZomeCallCapGrant {
        tag: "remote-signals".into(),
        access: CapAccess::Unrestricted,
        functions: GrantedFunctions::Listed(fns),
    })?;
    Ok(InitCallbackResult::Pass)
}

// --------------------------------------------------------------- anchor

fn anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_GAME)
}

fn link_entry(target: &ActionHash) -> ExternResult<()> {
    create_link(anchor()?, target.clone(), LinkTypes::GameToEntry, ())?;
    Ok(())
}

fn all_records() -> ExternResult<Vec<Record>> {
    let links = get_links(
        LinkQuery::try_new(anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    let mut out = Vec::new();
    for l in links {
        if let Some(ah) = l.target.into_action_hash() {
            if let Some(r) = get(ah, GetOptions::network())? {
                out.push(r);
            }
        }
    }
    Ok(out)
}

fn app_entry<T>(record: &Record) -> Option<T>
where
    T: TryFrom<SerializedBytes, Error = SerializedBytesError>,
{
    record.entry().to_app_option::<T>().ok().flatten()
}

fn fetch<T>(hash: &ActionHash) -> ExternResult<T>
where
    T: TryFrom<SerializedBytes, Error = SerializedBytesError>,
{
    let record = get(hash.clone(), GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("referenced record not found".into())))?;
    record
        .entry()
        .to_app_option::<T>()
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("record has no app entry".into())))
}

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

fn now_ms() -> ExternResult<i64> {
    Ok(sys_time()?.as_millis() as i64)
}

// ---------------------------------------------------- lobby / players

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateLobby {
    pub code: String,
    pub player_count: u16,
    pub impostor_count: u16,
    pub task_target: u32,
    pub display_name: String,
}

#[hdk_extern]
pub fn create_lobby(input: CreateLobby) -> ExternResult<Record> {
    // Recover interrupted creation from the local chain, including an entry
    // whose index link failed. A retry never opens a second lobby in this cell.
    let local = query(ChainQueryFilter::new().include_entries(true))?;
    let existing = local
        .iter()
        .find_map(|r| app_entry::<Lobby>(r).map(|l| (r.action_address().clone(), l)));
    let lobby_hash = if let Some((hash, l)) = existing {
        if l.code != input.code
            || l.player_count != input.player_count
            || l.impostor_count != input.impostor_count
            || l.task_target != input.task_target
        {
            return Err(wasm_error!(WasmErrorInner::Guest(
                "this game already has a different lobby configuration".into()
            )));
        }
        hash
    } else {
        create_entry(EntryTypes::Lobby(Lobby {
            code: input.code,
            player_count: input.player_count,
            impostor_count: input.impostor_count,
            task_target: input.task_target,
        }))?
    };
    link_entry(&lobby_hash)?;
    let my_key = me()?;
    let join = if let Some(hash) = local.iter().find_map(|r| {
        app_entry::<PlayerJoin>(r)
            .filter(|j| j.lobby == lobby_hash && j.player == my_key)
            .map(|_| r.action_address().clone())
    }) {
        hash
    } else {
        create_entry(EntryTypes::PlayerJoin(PlayerJoin {
            lobby: lobby_hash.clone(),
            player: me()?,
            display_name: input.display_name,
        }))?
    };
    link_entry(&join)?;

    get(lobby_hash, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("lobby vanished".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct JoinLobby {
    pub display_name: String,
}

/// Take a seat. Refused once the game has started, or once every seat is
/// taken as far as this node can see. Joining twice just returns the seat
/// already held. Two players racing for the last seat can both get past the
/// check (each sees a free seat); `seated_joins` then settles it the same way
/// everywhere, and the loser's state says `seat_lost`.
#[hdk_extern]
pub fn join_lobby(input: JoinLobby) -> ExternResult<Record> {
    let (lobby_hash, host, lobby) = find_lobby()?;
    let records = all_records()?;
    if records.iter().any(|r| app_entry::<RoleCommit>(r).is_some()) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game has already started".into()
        )));
    }
    let my_key = me()?;
    let seated = seated_joins(&records, &lobby_hash, &host, lobby.player_count as usize);
    if let Some((_, held)) = seated.iter().find(|(k, _)| k == &my_key) {
        return get(held.clone(), GetOptions::network())?
            .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("join vanished".into())));
    }
    if seated.len() >= lobby.player_count as usize {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "game full: all {} seats are taken",
            lobby.player_count
        ))));
    }
    let join = create_entry(EntryTypes::PlayerJoin(PlayerJoin {
        lobby: lobby_hash,
        player: me()?,
        display_name: input.display_name,
    }))?;
    link_entry(&join)?;
    get(join, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("join vanished".into())))
}

fn find_lobby() -> ExternResult<(ActionHash, AgentPubKey, Lobby)> {
    for r in all_records()? {
        if let Some(l) = app_entry::<Lobby>(&r) {
            return Ok((r.action_address().clone(), r.action().author().clone(), l));
        }
    }
    Err(wasm_error!(WasmErrorInner::Guest(
        "no lobby in this network yet".into()
    )))
}

/// Who holds the lobby's seats before the deal, with the join behind each:
/// the host, then each other player's earliest join to this lobby, oldest
/// first by (timestamp, action hash), until `cap` seats are filled. Every node
/// that holds the same joins seats the same players. Timestamps are the
/// joiners' own clocks, so this is a deterministic tie-break, not proof of who
/// was first. Joins past the cap stay on the DHT but never get a seat; the
/// host's deal (`RoleCommit`) is the final word.
fn seated_joins(
    records: &[Record],
    lobby: &ActionHash,
    host: &AgentPubKey,
    cap: usize,
) -> Vec<(AgentPubKey, ActionHash)> {
    let mut joins: Vec<(Timestamp, ActionHash, AgentPubKey)> = records
        .iter()
        .filter_map(|r| {
            let j = app_entry::<PlayerJoin>(r)?;
            (j.lobby == *lobby).then(|| (r.action().timestamp(), r.action_address().clone(), r.action().author().clone()))
        })
        .collect();
    joins.sort();
    let mut seated: Vec<(AgentPubKey, ActionHash)> = Vec::new();
    // the host's seat is never at risk
    if let Some((_, h, k)) = joins.iter().find(|(_, _, k)| k == host) {
        seated.push((k.clone(), h.clone()));
    }
    for (_, h, k) in &joins {
        if seated.len() >= cap {
            break;
        }
        if !seated.iter().any(|(s, _)| s == k) {
            seated.push((k.clone(), h.clone()));
        }
    }
    seated
}

/// The seated players' keys, in canonical seat order (sorted by key bytes).
fn seat_keys(seated: &[(AgentPubKey, ActionHash)]) -> Vec<AgentPubKey> {
    let mut keys: Vec<AgentPubKey> = seated.iter().map(|(k, _)| k.clone()).collect();
    keys.sort_by(|a, b| a.get_raw_39().cmp(b.get_raw_39()));
    keys
}

fn display_names(records: &[Record]) -> std::collections::BTreeMap<AgentPubKey, String> {
    let mut names = std::collections::BTreeMap::new();
    for r in records {
        if let Some(j) = app_entry::<PlayerJoin>(r) {
            names.insert(j.player, j.display_name);
        }
    }
    names
}

// ---------------------------------------------------- role dealing

/// What the host learns when it deals — legitimately, in this host-as-dealer
/// model. Other players only ever learn their own seat's role (via the
/// `RoleDealt` signal), until `reveal_all`.
#[derive(Serialize, Deserialize, Debug)]
pub struct DealResult {
    pub role_commit: ActionHash,
    pub seats: Vec<AgentPubKey>,
    pub roles: Vec<u8>,
}

/// Host only. Seal the role assignment, publish the commitment root + seat
/// order, and hand each player their own leaf + proof over a remote signal.
#[hdk_extern]
pub fn deal_roles(_: ()) -> ExternResult<DealResult> {
    let records = all_records()?;
    let (lobby_hash, host, lobby) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host deals roles".into()
        )));
    }
    if records.iter().any(|r| app_entry::<RoleCommit>(r).is_some()) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "roles have already been dealt".into()
        )));
    }
    let seated = seated_joins(&records, &lobby_hash, &host, lobby.player_count as usize);
    let seats = seat_keys(&seated);
    if seats.len() != lobby.player_count as usize {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "need {} players, have {}",
            lobby.player_count,
            seats.len()
        ))));
    }

    let host_entropy = {
        let bytes = random_bytes(32)?;
        let mut b = [0u8; 32];
        b.copy_from_slice(bytes.as_ref());
        b
    };
    let seat_key_bytes: Vec<Vec<u8>> = seats.iter().map(|k| k.get_raw_39().to_vec()).collect();
    let seed = mix_seed(&host_entropy, &seat_key_bytes);
    let salt = seed;

    let roles = assign(seats.len(), lobby.impostor_count as usize, &seed)
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(e.into())))?;
    let layers = build_layers(&roles, &salt);
    let root = commitment_root(&roles, &salt);

    // The host's one secret — local only.
    create_entry(EntryTypes::SealedRoles(SealedRoles {
        lobby: lobby_hash.clone(),
        roles: roles.clone(),
        salt,
    }))?;

    let rc_hash = create_entry(EntryTypes::RoleCommit(RoleCommit {
        lobby: lobby_hash,
        merkle_root: root,
        player_count: lobby.player_count,
        impostor_count: lobby.impostor_count,
        seats: seats.clone(),
        joins: seated.iter().map(|(_, h)| h.clone()).collect(),
    }))?;
    link_entry(&rc_hash)?;

    for (seat, key) in seats.iter().enumerate() {
        let proof = role_proof(&layers, &salt, seat as u16);
        let payload = GameSignal::RoleDealt {
            role_commit: rc_hash.clone(),
            recipient: key.clone(),
            seat: seat as u16,
            role: roles[seat],
            proof,
        };
        // send_remote_signal is fire-and-forget; a client that misses it can
        // ask the host to re-deal its own leaf via `resend_role`.
        send_remote_signal(payload, vec![key.clone()])?;
    }

    Ok(DealResult {
        role_commit: rc_hash,
        seats,
        roles,
    })
}

/// Host only. Re-send one seat's role leaf (if a remote signal was missed).
#[hdk_extern]
pub fn resend_role(seat: u16) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest("host only".into())));
    }
    let sealed = my_sealed_roles()?;
    let rc = find_role_commit()?.ok_or_else(|| {
        wasm_error!(WasmErrorInner::Guest("roles not dealt yet".into()))
    })?;
    let layers = build_layers(&sealed.roles, &sealed.salt);
    let key = rc
        .1
        .seats
        .get(seat as usize)
        .cloned()
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("no such seat".into())))?;
    let role = *sealed.roles.get(seat as usize).ok_or_else(|| {
        wasm_error!(WasmErrorInner::Guest("sealed roles do not include this seat".into()))
    })?;
    let proof = role_proof(&layers, &sealed.salt, seat);
    authorize_role_delivery(
        host.get_raw_39(), host.get_raw_39(), key.get_raw_39(), key.get_raw_39(),
        rc.1.seats.get(seat as usize).map(|k| &k.get_raw_39()[..]),
        rc.0.get_raw_39(), rc.0.get_raw_39(), &rc.1.merkle_root,
        seat, role, &proof,
    ).map_err(role_delivery_error)?;
    send_remote_signal(
        GameSignal::RoleDealt {
            role_commit: rc.0,
            recipient: key.clone(),
            seat,
            role,
            proof,
        },
        vec![key],
    )
}

/// One player's sealed role leaf, as handed back by `provide_role`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RoleLeafResp {
    pub role_commit: ActionHash,
    pub seat: u16,
    pub role: u8,
    pub proof: RoleProof,
}

/// Host-side. Called remotely (`call_remote`) by a player who never received
/// their `RoleDealt` signal. Rebuilds *that caller's* leaf + proof from the
/// host's private `SealedRoles` and returns it. `None` if roles are not dealt
/// yet or the caller holds no seat.
#[hdk_extern]
pub fn provide_role(_: ()) -> ExternResult<Option<RoleLeafResp>> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host can provide roles".into()
        )));
    }
    let caller = call_info()?.provenance;
    let rc = match find_role_commit()? {
        Some(rc) => rc,
        None => return Ok(None),
    };
    let seat = match rc.1.seats.iter().position(|k| k == &caller) {
        Some(s) => s as u16,
        None => return Ok(None),
    };
    let sealed = my_sealed_roles()?;
    let role = *sealed.roles.get(seat as usize).ok_or_else(|| {
        wasm_error!(WasmErrorInner::Guest("sealed roles do not include this seat".into()))
    })?;
    let layers = build_layers(&sealed.roles, &sealed.salt);
    let proof = role_proof(&layers, &sealed.salt, seat);
    // The remote executor MUST set call_info().provenance from the verified
    // Lair-authenticated caller. HWC currently rejects inbound remote calls.
    authorize_role_delivery(
        host.get_raw_39(), host.get_raw_39(), caller.get_raw_39(), caller.get_raw_39(),
        rc.1.seats.get(seat as usize).map(|k| &k.get_raw_39()[..]),
        rc.0.get_raw_39(), rc.0.get_raw_39(), &rc.1.merkle_root,
        seat, role, &proof,
    ).map_err(role_delivery_error)?;
    Ok(Some(RoleLeafResp {
        role_commit: rc.0,
        seat,
        role,
        proof,
    }))
}

/// Player-side recovery for a missed `RoleDealt` signal — safe to poll. The
/// host reads its own role locally; everyone else asks the host over
/// `call_remote`, verifies the returned proof against the public commitment,
/// then emits `YourRole` to the UI. Returns the role if known yet, else `None`.
#[hdk_extern]
pub fn request_role(_: ()) -> ExternResult<Option<u8>> {
    let (_, host, _) = find_lobby()?;
    let my_key = me()?;

    if my_key == host {
        let rc = match find_role_commit()? {
            Some(rc) => rc,
            None => return Ok(None),
        };
        let seat = match rc.1.seats.iter().position(|k| k == &my_key) {
            Some(s) => s,
            None => return Ok(None),
        };
        let sealed = my_sealed_roles()?;
        let role = *sealed.roles.get(seat).ok_or_else(|| {
            wasm_error!(WasmErrorInner::Guest("sealed roles do not include my seat".into()))
        })?;
        let proof = role_proof(&build_layers(&sealed.roles, &sealed.salt), &sealed.salt, seat as u16);
        authorize_role_delivery(
            host.get_raw_39(), host.get_raw_39(), my_key.get_raw_39(), my_key.get_raw_39(),
            rc.1.seats.get(seat).map(|k| &k.get_raw_39()[..]),
            rc.0.get_raw_39(), rc.0.get_raw_39(), &rc.1.merkle_root,
            seat as u16, role, &proof,
        ).map_err(role_delivery_error)?;
        emit_signal(GameSignal::YourRole {
            seat: seat as u16,
            role,
        })?;
        return Ok(Some(role));
    }

    let io = match call_remote(host.clone(), zome_info()?.name, "provide_role".into(), None, ())? {
        ZomeCallResponse::Ok(io) => io,
        other => {
            return Err(wasm_error!(WasmErrorInner::Guest(format!(
                "host could not provide role: {other:?}"
            ))))
        }
    };
    let leaf: Option<RoleLeafResp> = io
        .decode()
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("bad provide_role reply: {e:?}"))))?;
    let leaf = match leaf {
        Some(l) => l,
        None => return Ok(None),
    };

    let rc = find_role_commit()?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("no role commit yet".into())))?;
    // The transport must authenticate the host. A valid Merkle opening
    // for a different seat or previous commitment is never sufficient.
    authorize_role_delivery(
        host.get_raw_39(), host.get_raw_39(), my_key.get_raw_39(), my_key.get_raw_39(),
        rc.1.seats.get(leaf.seat as usize).map(|k| &k.get_raw_39()[..]),
        leaf.role_commit.get_raw_39(), rc.0.get_raw_39(), &rc.1.merkle_root,
        leaf.seat, leaf.role, &leaf.proof,
    ).map_err(role_delivery_error)?;
    emit_signal(GameSignal::YourRole {
        seat: leaf.seat,
        role: leaf.role,
    })?;
    Ok(Some(leaf.role))
}

fn my_sealed_roles() -> ExternResult<SealedRoles> {
    let entries = query(
        ChainQueryFilter::new()
            .entry_type(UnitEntryTypes::SealedRoles.try_into()?)
            .include_entries(true),
    )?;
    for r in entries.into_iter().rev() {
        if let Some(s) = app_entry::<SealedRoles>(&r) {
            return Ok(s);
        }
    }
    Err(wasm_error!(WasmErrorInner::Guest(
        "no sealed roles on this chain (are you the host?)".into()
    )))
}

fn find_role_commit() -> ExternResult<Option<(ActionHash, RoleCommit)>> {
    let (lobby_hash, host, _) = find_lobby()?;
    for r in all_records()? {
        if r.action().author() != &host {
            continue;
        }
        if let Some(rc) = app_entry::<RoleCommit>(&r) {
            if rc.lobby == lobby_hash {
                return Ok(Some((r.action_address().clone(), rc)));
            }
        }
    }
    Ok(None)
}

/// Shared non-secret rejection for remote role authorization.
fn role_delivery_error(reason: &'static str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(format!("role delivery rejected: {reason}")))
}

// ---------------------------------------------------- sabotage: lights

/// After the lights are fixed, or a meeting closes, impostors wait this long
/// before they can cut them again.
const SABOTAGE_COOLDOWN_MS: i64 = 30_000;

fn lights_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_LIGHTS)
}


/// The lights' flips so far, oldest first, as (when, out afterwards). A cut
/// only counts if the host wrote it: the host writes every cut, on behalf of
/// whichever impostor asked, so a link's author never gives an impostor away.
/// A fix counts from any seated player.
fn lights_history(host: &AgentPubKey, rc: &RoleCommit) -> ExternResult<Vec<(Timestamp, bool)>> {
    let links = get_links(
        LinkQuery::try_new(lights_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    let mut flips: Vec<(Timestamp, bool)> = links
        .into_iter()
        .filter_map(|l| {
            let bytes = l.tag.into_inner();
            match decode::<_, LightsSwitch>(&bytes).ok()? {
                LightsSwitch::Cut => (&l.author == host).then_some((l.timestamp, true)),
                LightsSwitch::Fixed => rc.seats.contains(&l.author).then_some((l.timestamp, false)),
            }
        })
        .collect();
    flips.sort_by_key(|(at, _)| *at);
    Ok(flips)
}

/// Whether the lights are out, and when an impostor may next cut them (ms since
/// the epoch): a cooldown after the last fix and after the latest meeting.
fn lights_state(records: &[Record], host: &AgentPubKey, rc: &RoleCommit) -> ExternResult<(bool, i64)> {
    let flips = lights_history(host, rc)?;
    let out = flips.last().is_some_and(|(_, out)| *out);
    let since = flips
        .iter()
        .filter(|(_, out)| !out)
        .map(|(at, _)| *at)
        .chain(last_meeting_closed(records))
        .max();
    Ok((out, since.map_or(0, |t| t.as_millis() as i64 + SABOTAGE_COOLDOWN_MS)))
}

/// An impostor — alive or a ghost — puts the lights out, and crew vision
/// shrinks until someone fixes them. The host checks and writes the cut (see
/// `lights_history`); everyone else asks it to.
#[hdk_extern]
pub fn cut_lights(_: ()) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? == host {
        return host_cut_lights(());
    }
    match call_remote(host, zome_info()?.name, "host_cut_lights".into(), None, ())? {
        ZomeCallResponse::Ok(_) => Ok(()),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!(
            "the host refused or couldn't be reached: {other:?}"
        )))),
    }
}

/// Host-side, for itself or called remotely by an impostor: cut the lights.
#[hdk_extern]
pub fn host_cut_lights(_: ()) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host writes sabotage".into()
        )));
    }
    let caller = call_info()?.provenance;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    if records.iter().any(|r| app_entry::<GameResult>(r).is_some()) {
        return Err(wasm_error!(WasmErrorInner::Guest("the game is over".into())));
    }
    if !is_impostor(&caller, &rc)? {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only an impostor can sabotage".into()
        )));
    }
    if meeting_in_progress(&records) {
        return Err(wasm_error!(WasmErrorInner::Guest("not during a meeting".into())));
    }
    let (out, ready_at) = lights_state(&records, &host, &rc)?;
    if out {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the lights are already out".into()
        )));
    }
    let wait = ready_at - now_ms()?;
    if wait > 0 {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "sabotage cooldown: {}s left",
            (wait + 999) / 1000
        ))));
    }
    let tag = encode(&LightsSwitch::Cut).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(lights_anchor()?, host, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// Any living player, at the panel, turns the lights back on.
#[hdk_extern]
pub fn fix_lights(_: ()) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    let my_key = me()?;
    if !rc.seats.contains(&my_key) || dead_players(&records, Some(&rc)).contains(&my_key) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only a living player can fix the lights".into()
        )));
    }
    if !lights_state(&records, &host, &rc)?.0 {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the lights aren't out".into()
        )));
    }
    let tag = encode(&LightsSwitch::Fixed).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(lights_anchor()?, my_key, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// Host-side: whether `player` holds an impostor seat, from the host's sealed roles.
fn is_impostor(player: &AgentPubKey, rc: &RoleCommit) -> ExternResult<bool> {
    let sealed = my_sealed_roles()?;
    Ok(rc
        .seats
        .iter()
        .position(|k| k == player)
        .is_some_and(|seat| sealed.roles.get(seat) == Some(&ROLE_IMPOSTOR)))
}

// ---------------------------------------------------- sabotage: comms

fn comms_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_COMMS)
}


/// Comms' flips so far, oldest first, as (when, out afterwards). Same rules as
/// `lights_history`: a cut only counts from the host (who writes it on behalf
/// of whichever impostor asked), a fix from any seated player.
fn comms_history(host: &AgentPubKey, rc: &RoleCommit) -> ExternResult<Vec<(Timestamp, bool)>> {
    let links = get_links(
        LinkQuery::try_new(comms_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    let mut flips: Vec<(Timestamp, bool)> = links
        .into_iter()
        .filter_map(|l| {
            let bytes = l.tag.into_inner();
            match decode::<_, CommsSwitch>(&bytes).ok()? {
                CommsSwitch::Cut => (&l.author == host).then_some((l.timestamp, true)),
                CommsSwitch::Fixed => rc.seats.contains(&l.author).then_some((l.timestamp, false)),
            }
        })
        .collect();
    flips.sort_by_key(|(at, _)| *at);
    Ok(flips)
}

/// Whether comms are out, and when an impostor may next cut them: the same
/// cooldown shape as the lights, after the last fix and after the latest
/// meeting.
fn comms_state(records: &[Record], host: &AgentPubKey, rc: &RoleCommit) -> ExternResult<(bool, i64)> {
    let flips = comms_history(host, rc)?;
    let out = flips.last().is_some_and(|(_, out)| *out);
    let since = flips
        .iter()
        .filter(|(_, out)| !out)
        .map(|(at, _)| *at)
        .chain(last_meeting_closed(records))
        .max();
    Ok((out, since.map_or(0, |t| t.as_millis() as i64 + SABOTAGE_COOLDOWN_MS)))
}

/// An impostor cuts comms: the crew's task list and task bar go dark until
/// someone fixes them at the comms panel. Same host-writes-it-for-you shape as
/// `cut_lights`.
#[hdk_extern]
pub fn cut_comms(_: ()) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? == host {
        return host_cut_comms(());
    }
    match call_remote(host, zome_info()?.name, "host_cut_comms".into(), None, ())? {
        ZomeCallResponse::Ok(_) => Ok(()),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!(
            "the host refused or couldn't be reached: {other:?}"
        )))),
    }
}

/// Host-side, for itself or called remotely by an impostor: cut comms.
#[hdk_extern]
pub fn host_cut_comms(_: ()) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host writes sabotage".into()
        )));
    }
    let caller = call_info()?.provenance;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    if records.iter().any(|r| app_entry::<GameResult>(r).is_some()) {
        return Err(wasm_error!(WasmErrorInner::Guest("the game is over".into())));
    }
    if !is_impostor(&caller, &rc)? {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only an impostor can sabotage".into()
        )));
    }
    if meeting_in_progress(&records) {
        return Err(wasm_error!(WasmErrorInner::Guest("not during a meeting".into())));
    }
    let (out, ready_at) = comms_state(&records, &host, &rc)?;
    if out {
        return Err(wasm_error!(WasmErrorInner::Guest("comms are already down".into())));
    }
    let wait = ready_at - now_ms()?;
    if wait > 0 {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "sabotage cooldown: {}s left",
            (wait + 999) / 1000
        ))));
    }
    let tag = encode(&CommsSwitch::Cut).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(comms_anchor()?, host, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// Any living player, at the panel, restores comms.
#[hdk_extern]
pub fn fix_comms(_: ()) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    let my_key = me()?;
    if !rc.seats.contains(&my_key) || dead_players(&records, Some(&rc)).contains(&my_key) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only a living player can fix comms".into()
        )));
    }
    if !comms_state(&records, &host, &rc)?.0 {
        return Err(wasm_error!(WasmErrorInner::Guest("comms aren't down".into())));
    }
    let tag = encode(&CommsSwitch::Fixed).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(comms_anchor()?, my_key, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

// ---------------------------------------------------- sabotage: doors

/// How long a room's doors stay shut.
const DOOR_CLOSE_MS: i64 = 10_000;
/// How long impostors wait, after doors open again, before shutting any more.
const DOORS_COOLDOWN_MS: i64 = 30_000;

fn doors_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_DOORS)
}

/// Shut doors: which room (an index into the UI's map) and until when (ms since the epoch).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DoorsView {
    pub room: u8,
    pub until_ms: i64,
}

/// Every door shutting so far, oldest first, as (ms since the epoch, room). As
/// with a lights cut, only the host's links count: it writes them for whichever
/// impostor asked, so nothing gives that impostor away.
fn door_closes(host: &AgentPubKey) -> ExternResult<Vec<(i64, u8)>> {
    let links = get_links(
        LinkQuery::try_new(doors_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    let mut closes: Vec<(i64, u8)> = links
        .into_iter()
        .filter(|l| &l.author == host)
        .filter_map(|l| {
            let at = l.timestamp.as_millis() as i64;
            let bytes = l.tag.into_inner();
            Some((at, decode::<_, u8>(&bytes).ok()?))
        })
        .collect();
    closes.sort_unstable();
    Ok(closes)
}

/// The rooms whose doors are shut at `now`, and when impostors may shut doors next.
fn doors_state(host: &AgentPubKey, now: i64) -> ExternResult<(Vec<DoorsView>, i64)> {
    let closes = door_closes(host)?;
    let shut = closes
        .iter()
        .filter(|(at, _)| at + DOOR_CLOSE_MS > now)
        .map(|(at, room)| DoorsView {
            room: *room,
            until_ms: at + DOOR_CLOSE_MS,
        })
        .collect();
    let ready_at = closes.last().map_or(0, |(at, _)| at + DOOR_CLOSE_MS + DOORS_COOLDOWN_MS);
    Ok((shut, ready_at))
}

/// An impostor — alive or a ghost — shuts a room's doors for a while: they
/// block movement and sight until they open again. The host checks and writes
/// it; everyone else asks it to.
#[hdk_extern]
pub fn close_doors(room: u8) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? == host {
        return host_close_doors(room);
    }
    match call_remote(host, zome_info()?.name, "host_close_doors".into(), None, room)? {
        ZomeCallResponse::Ok(_) => Ok(()),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!(
            "the host refused or couldn't be reached: {other:?}"
        )))),
    }
}

/// Host-side, for itself or called remotely by an impostor: shut a room's doors.
#[hdk_extern]
pub fn host_close_doors(room: u8) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host writes sabotage".into()
        )));
    }
    let caller = call_info()?.provenance;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    if records.iter().any(|r| app_entry::<GameResult>(r).is_some()) {
        return Err(wasm_error!(WasmErrorInner::Guest("the game is over".into())));
    }
    if !is_impostor(&caller, &rc)? {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only an impostor can sabotage".into()
        )));
    }
    if meeting_in_progress(&records) {
        return Err(wasm_error!(WasmErrorInner::Guest("not during a meeting".into())));
    }
    if room >= 32 {
        return Err(wasm_error!(WasmErrorInner::Guest("no such room".into())));
    }
    let now = now_ms()?;
    let (_, ready_at) = doors_state(&host, now)?;
    if ready_at > now {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "doors cooldown: {}s left",
            (ready_at - now + 999) / 1000
        ))));
    }
    let tag = encode(&room).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(doors_anchor()?, host, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

// ---------------------------------------------------- sabotage: crises

/// Reactor Emergency, Life Support and Navigation Drift: each runs on a timer,
/// and if the crew hasn't stabilised it by then the impostors win (see
/// `imposter_core::crisis` for the rules and durations). One at a time; a
/// meeting ends whichever is running. Same host-writes-the-start shape as the
/// lights, so a start link never names the impostor who asked for it.
fn crisis_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_CRISIS)
}

/// How long a reactor console counts as held after its latest confirmation.
const REACTOR_HELD_MS: i64 = 2_000;

/// A crisis under way.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CrisisView {
    pub kind: CrisisKind,
    pub started_ms: i64,
    pub ends_at_ms: i64,
    /// Per console: fixed since the crisis started — at the reactor, held right now.
    pub panels: Vec<bool>,
}

struct CrisisState {
    active: Option<CrisisView>,
    /// A crisis that ran out: its kind and the host's link that started it.
    melted: Option<(CrisisKind, ActionHash)>,
    /// When an impostor may start the next one, ms since the epoch.
    ready_at: i64,
}

fn crisis_links() -> ExternResult<Vec<Link>> {
    get_links(
        LinkQuery::try_new(crisis_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )
}

fn crisis_state(records: &[Record], host: &AgentPubKey, rc: &RoleCommit, now: i64) -> ExternResult<CrisisState> {
    let mut starts: Vec<(i64, CrisisKind, ActionHash)> = Vec::new();
    let mut fixes: Vec<(CrisisKind, CrisisFix<AgentPubKey>)> = Vec::new();
    for l in crisis_links()? {
        let at = l.timestamp.as_millis() as i64;
        match decode::<_, CrisisTag>(&l.tag.into_inner()) {
            Ok(CrisisTag::Start { kind }) if &l.author == host => starts.push((at, kind, l.create_link_hash)),
            Ok(CrisisTag::Fix { kind, panel }) if rc.seats.contains(&l.author) => fixes.push((
                kind,
                CrisisFix {
                    at_ms: at,
                    panel,
                    by: l.author,
                },
            )),
            _ => {}
        }
    }
    starts.sort_by_key(|(at, _, _)| *at);
    let meetings: Vec<i64> = records
        .iter()
        .filter(|r| app_entry::<Meeting>(r).is_some())
        .map(|r| r.action().timestamp().as_millis() as i64)
        .collect();
    let after_meeting = last_meeting_closed(records).map(|t| t.as_millis() as i64);
    let ready = |since: Option<i64>| since.map_or(0, |t| t + SABOTAGE_COOLDOWN_MS);

    let Some((started, kind, start_link)) = starts.last().cloned() else {
        return Ok(CrisisState {
            active: None,
            melted: None,
            ready_at: ready(after_meeting),
        });
    };
    let ends = started + kind.duration_ms();
    let since: Vec<CrisisFix<AgentPubKey>> = fixes
        .into_iter()
        .filter(|(k, f)| *k == kind && f.at_ms >= started)
        .map(|(_, f)| f)
        .collect();
    let meeting = meetings.iter().copied().filter(|t| *t >= started).min();
    let stopped = [crisis_resolved_at(kind, &since), meeting]
        .into_iter()
        .flatten()
        .filter(|t| *t <= ends)
        .min();
    if let Some(stopped) = stopped {
        return Ok(CrisisState {
            active: None,
            melted: None,
            ready_at: ready(Some(after_meeting.map_or(stopped, |m| m.max(stopped)))),
        });
    }
    if now >= ends {
        return Ok(CrisisState {
            active: None,
            melted: Some((kind, start_link)),
            ready_at: ends,
        });
    }
    let panels = (0..kind.panels())
        .map(|p| {
            since.iter().any(|f| {
                f.panel == p && (kind != CrisisKind::Reactor || now - f.at_ms <= REACTOR_HELD_MS)
            })
        })
        .collect();
    Ok(CrisisState {
        active: Some(CrisisView {
            kind,
            started_ms: started,
            ends_at_ms: ends,
            panels,
        }),
        melted: None,
        // at the earliest: it's stabilised right now
        ready_at: now + SABOTAGE_COOLDOWN_MS,
    })
}

/// An impostor — alive or a ghost — starts a crisis. The host checks and
/// writes it; everyone else asks it to.
#[hdk_extern]
pub fn start_crisis(kind: CrisisKind) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? == host {
        return host_start_crisis(kind);
    }
    match call_remote(host, zome_info()?.name, "host_start_crisis".into(), None, kind)? {
        ZomeCallResponse::Ok(_) => Ok(()),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!(
            "the host refused or couldn't be reached: {other:?}"
        )))),
    }
}

/// Host-side, for itself or called remotely by an impostor: start a crisis.
#[hdk_extern]
pub fn host_start_crisis(kind: CrisisKind) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host writes sabotage".into()
        )));
    }
    let caller = call_info()?.provenance;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    if records.iter().any(|r| app_entry::<GameResult>(r).is_some()) {
        return Err(wasm_error!(WasmErrorInner::Guest("the game is over".into())));
    }
    if !is_impostor(&caller, &rc)? {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only an impostor can sabotage".into()
        )));
    }
    if meeting_in_progress(&records) {
        return Err(wasm_error!(WasmErrorInner::Guest("not during a meeting".into())));
    }
    let now = now_ms()?;
    let state = crisis_state(&records, &host, &rc, now)?;
    if state.active.is_some() || state.melted.is_some() {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "a crisis is already under way".into()
        )));
    }
    if state.ready_at > now {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "sabotage cooldown: {}s left",
            (state.ready_at - now + 999) / 1000
        ))));
    }
    let tag = encode(&CrisisTag::Start { kind }).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(crisis_anchor()?, host, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// Any living player, at one of the crisis's consoles, fixes it — or, at the
/// reactor, confirms they're still holding it (the UI repeats this while Use
/// is held, and two players' holds must overlap).
#[hdk_extern]
pub fn fix_crisis(panel: u8) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    let records = all_records()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    let my_key = me()?;
    if !rc.seats.contains(&my_key) || dead_players(&records, Some(&rc)).contains(&my_key) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only a living player can stabilise a crisis".into()
        )));
    }
    let Some(active) = crisis_state(&records, &host, &rc, now_ms()?)?.active else {
        return Err(wasm_error!(WasmErrorInner::Guest("there's no crisis".into())));
    };
    if panel >= active.kind.panels() {
        return Err(wasm_error!(WasmErrorInner::Guest("no such console".into())));
    }
    let tag = encode(&CrisisTag::Fix {
        kind: active.kind,
        panel,
    })
    .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(crisis_anchor()?, my_key, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// The crisis a `GameResult`'s meltdown cites, by its start link.
fn meltdown_kind(start: &ActionHash) -> ExternResult<Option<CrisisKind>> {
    Ok(crisis_links()?
        .into_iter()
        .find(|l| &l.create_link_hash == start)
        .and_then(|l| match decode::<_, CrisisTag>(&l.tag.into_inner()) {
            Ok(CrisisTag::Start { kind }) => Some(kind),
            _ => None,
        }))
}

// ---------------------------------------------------- test-only forgery

/// A raw link, as a tampered client could write one: any anchor, any target,
/// any tag. Only in the `forge` build the sweettests use.
#[cfg(feature = "forge")]
#[derive(Serialize, Deserialize, Debug)]
pub struct ForgeLink {
    pub anchor: String,
    pub target: AnyLinkableHash,
    pub tag: Vec<u8>,
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_link(input: ForgeLink) -> ExternResult<ActionHash> {
    create_link(
        anchor_hash(&input.anchor)?,
        input.target,
        LinkTypes::GameToEntry,
        LinkTag::new(input.tag),
    )
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_list_links(anchor: String) -> ExternResult<Vec<ActionHash>> {
    Ok(get_links(
        LinkQuery::try_new(anchor_hash(&anchor)?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?
    .into_iter()
    .map(|l| l.create_link_hash)
    .collect())
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_delete_link(link: ActionHash) -> ExternResult<ActionHash> {
    delete_link(link, GetOptions::network())
}

// ---------------------------------------------------- host presence

/// Answers anyone. Lets a player check that the host is still reachable.
#[hdk_extern]
pub fn ping(_: ()) -> ExternResult<()> {
    Ok(())
}

/// Whether the host answers a `ping`. The host deals, tallies and publishes the
/// result, and only it knows the roles, so a game whose host has gone can't go
/// on. The UI polls this to say so and offer a fresh game instead.
#[hdk_extern]
pub fn host_online(_: ()) -> ExternResult<bool> {
    let (_, host, _) = find_lobby()?;
    if me()? == host {
        return Ok(true);
    }
    let reply = call_remote(host, zome_info()?.name, "ping".into(), None, ())?;
    Ok(matches!(reply, ZomeCallResponse::Ok(_)))
}

// ---------------------------------------------------- signals

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GameSignal {
    /// host → player: your sealed role, with a proof against the commitment.
    RoleDealt {
        role_commit: ActionHash,
        recipient: AgentPubKey,
        seat: u16,
        role: u8,
        proof: RoleProof,
    },
    /// impostor → victim: you have been killed. `seat` + `proof` open the role
    /// commitment, showing the killer really is an impostor.
    Killed {
        killer: AgentPubKey,
        at_ms: i64,
        seat: u16,
        proof: RoleProof,
    },

    // --- emitted locally to the UI only ---
    YourRole { seat: u16, role: u8 },
    YouDied { killer: AgentPubKey },
    Refresh,
}

// The payload arrives as the msgpack-encoded `GameSignal` itself, so take it
// typed. Taking `ExternIO` failed to deserialize on every delivery, and because
// `send_remote_signal` is fire-and-forget, kills and role signals were dropped
// without an error anywhere.
#[hdk_extern]
pub fn recv_remote_signal(sig: GameSignal) -> ExternResult<()> {
    match sig {
        GameSignal::RoleDealt {
            role_commit,
            recipient,
            seat,
            role,
            proof,
        } => {
            // HWC remote receive is still disabled. Future adapters MUST
            // inject independently verified sender provenance, never a
            // caller-supplied from_agent/ChainAuthor substitution.
            let sender = call_info()?.provenance;
            let (_, host, _) = find_lobby()?;
            let local_agent = me()?;
            let (accepted_hash, rc) = find_role_commit()?.ok_or_else(|| {
                wasm_error!(WasmErrorInner::Guest("role commitment is unavailable".into()))
            })?;
            authorize_role_delivery(
                sender.get_raw_39(), host.get_raw_39(),
                recipient.get_raw_39(), local_agent.get_raw_39(),
                rc.seats.get(seat as usize).map(|k| &k.get_raw_39()[..]),
                role_commit.get_raw_39(), accepted_hash.get_raw_39(), &rc.merkle_root,
                seat, role, &proof,
            ).map_err(role_delivery_error)?;
            emit_signal(GameSignal::YourRole { seat, role })?;
        }
        GameSignal::Killed {
            killer,
            at_ms,
            seat,
            proof,
        } => {
            // A kill only counts once the victim's own client records it, so
            // this is where the kill rules are enforced.
            let victim = me()?;
            kill_allowed(&all_records()?, &killer, &victim, seat, ROLE_IMPOSTOR, &proof, now_ms()?, kill_cooldown()?)
                .map_err(|why| wasm_error!(WasmErrorInner::Guest(format!("kill rejected: {why}"))))?;
            if call_info()?.provenance != killer {
                return Err(wasm_error!(WasmErrorInner::Guest(
                    "kill rejected: the signal didn't come from the killer".into()
                )));
            }
            commit_kill_report(killer.clone(), at_ms)?;
            emit_signal(GameSignal::YouDied { killer })?;
        }
        _ => {}
    }
    Ok(())
}

fn commit_kill_report(killer: AgentPubKey, at_ms: i64) -> ExternResult<ActionHash> {
    let (lobby_hash, _host, _lobby) = find_lobby()?;
    let ah = create_entry(EntryTypes::KillReport(KillReport {
        lobby: lobby_hash,
        killer,
        at_ms,
    }))?;
    link_entry(&ah)?;
    Ok(ah)
}

/// Records the caller's own death, without the kill checks `recv_remote_signal`
/// applies. The headless tests use it so they don't depend on remote-signal
/// timing; a client can only ever kill itself with it.
#[hdk_extern]
pub fn report_own_death(killer: AgentPubKey) -> ExternResult<Record> {
    let ah = commit_kill_report(killer, now_ms()?)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("kill report vanished".into())))
}

/// Impostor UI calls this when a crewmate is in reach — a PeerKit distance
/// check, so client-side only. The signal carries the killer's role proof, and
/// the victim's client checks it and the other kill rules (`kill_allowed`)
/// before recording its death. The same check runs here first, so a refused
/// kill comes back as an error rather than silently doing nothing.
#[hdk_extern]
pub fn kill(target: AgentPubKey) -> ExternResult<()> {
    let killer = me()?;
    let leaf = my_role_leaf()?;
    kill_allowed(&all_records()?, &killer, &target, leaf.seat, leaf.role, &leaf.proof, now_ms()?, kill_cooldown()?)
        .map_err(|why| wasm_error!(WasmErrorInner::Guest(why)))?;
    send_remote_signal(
        GameSignal::Killed {
            killer,
            at_ms: now_ms()?,
            seat: leaf.seat,
            proof: leaf.proof,
        },
        vec![target],
    )
}

/// My own role leaf and proof. The host reads its sealed roles; anyone else asks
/// the host, as `request_role` does.
fn my_role_leaf() -> ExternResult<RoleLeafResp> {
    let (_, host, _) = find_lobby()?;
    if me()? == host {
        let (rc_hash, rc) = find_role_commit()?
            .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("roles not dealt yet".into())))?;
        let seat = rc
            .seats
            .iter()
            .position(|k| k == &host)
            .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("the host holds no seat".into())))?
            as u16;
        let sealed = my_sealed_roles()?;
        let layers = build_layers(&sealed.roles, &sealed.salt);
        return Ok(RoleLeafResp {
            role_commit: rc_hash,
            seat,
            role: sealed.roles[seat as usize],
            proof: role_proof(&layers, &sealed.salt, seat),
        });
    }
    let io = match call_remote(host.clone(), zome_info()?.name, "provide_role".into(), None, ())? {
        ZomeCallResponse::Ok(io) => io,
        other => {
            return Err(wasm_error!(WasmErrorInner::Guest(format!(
                "the host could not be reached: {other:?}"
            ))))
        }
    };
    let leaf: Option<RoleLeafResp> = io
        .decode()
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("bad provide_role reply: {e:?}"))))?;
    let leaf = leaf.ok_or_else(|| wasm_error!(WasmErrorInner::Guest("roles not dealt yet".into())))?;
    let (accepted_hash, rc) = find_role_commit()?.ok_or_else(|| {
        wasm_error!(WasmErrorInner::Guest("role commitment is unavailable".into()))
    })?;
    let local_agent = me()?;
    authorize_role_delivery(
        host.get_raw_39(), host.get_raw_39(), local_agent.get_raw_39(), local_agent.get_raw_39(),
        rc.seats.get(leaf.seat as usize).map(|k| &k.get_raw_39()[..]),
        leaf.role_commit.get_raw_39(), accepted_hash.get_raw_39(), &rc.merkle_root,
        leaf.seat, leaf.role, &leaf.proof,
    ).map_err(role_delivery_error)?;
    Ok(leaf)
}

// ---------------------------------------------------- tasks

#[hdk_extern]
pub fn publish_tasks(tasks: Vec<Task>) -> ExternResult<Record> {
    let (lobby_hash, host, _lobby) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host publishes tasks".into()
        )));
    }
    let ah = create_entry(EntryTypes::TaskList(TaskList {
        lobby: lobby_hash,
        tasks,
    }))?;
    link_entry(&ah)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("task list vanished".into())))
}

/// Records a task completion for the caller, once. Shared by `complete_task`
/// and `scan_role`; `task_completions` also ignores repeats, so this is belt
/// and braces against two of a player's own writes racing.
fn record_task_complete(task_id: u16) -> ExternResult<ActionHash> {
    let tl = find_task_list()?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("no task list yet".into())))?;
    let my_key = me()?;
    let repeat = all_records()?.iter().any(|r| {
        r.action().author() == &my_key
            && app_entry::<TaskComplete>(r).is_some_and(|tc| tc.task_id == task_id)
    });
    if repeat {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "you've already done that task".into()
        )));
    }
    let ah = create_entry(EntryTypes::TaskComplete(TaskComplete {
        task_list: tl.0,
        task_id,
    }))?;
    link_entry(&ah)?;
    Ok(ah)
}

#[hdk_extern]
pub fn complete_task(task_id: u16) -> ExternResult<Record> {
    let ah = record_task_complete(task_id)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("task completion vanished".into())))
}

/// The medbay scan: a task like any other (it records a `TaskComplete`), but
/// also publishes the caller's own role as a `RoleReveal` — proved against the
/// commitment, the same entry a host opens for someone voted off, here
/// self-issued (`validate` already lets the seated player reveal their own
/// seat). A crewmate's scan is public, unforgeable proof they're crew, from
/// then on.
///
/// No impostor gains anything from a real one: it never counts toward the
/// crew's tasks (`real_tasks` only counts a crewmate's own list), and it
/// reveals them for nothing — so a rational impostor always fakes this task
/// locally, exactly like any other, and never calls this.
#[hdk_extern]
pub fn scan_role(task_id: u16) -> ExternResult<()> {
    record_task_complete(task_id)?;
    let leaf = my_role_leaf()?;
    let already_revealed = all_records()?
        .iter()
        .filter_map(|r| app_entry::<RoleReveal>(r))
        .any(|rr| rr.seat == leaf.seat);
    if !already_revealed {
        let ah = create_entry(EntryTypes::RoleReveal(RoleReveal {
            role_commit: leaf.role_commit,
            seat: leaf.seat,
            role: leaf.role,
            proof: leaf.proof,
        }))?;
        link_entry(&ah)?;
    }
    Ok(())
}

fn find_task_list() -> ExternResult<Option<(ActionHash, TaskList)>> {
    for r in all_records()? {
        if let Some(tl) = app_entry::<TaskList>(&r) {
            return Ok(Some((r.action_address().clone(), tl)));
        }
    }
    Ok(None)
}

/// The completions that count, one per player and task: the earliest, so
/// everyone picks the same record. `counts` decides which (player, task) pairs
/// count at all — every one for the public tally, or only crewmates' own tasks
/// for the result (`real_tasks`). A `GameResult` cites exactly these, and
/// `validate` recounts its evidence the same way, per player and task.
fn task_completions(
    records: &[Record],
    counts: impl Fn(&AgentPubKey, u16) -> bool,
) -> std::collections::BTreeMap<(AgentPubKey, u16), &Record> {
    let mut done: std::collections::BTreeMap<(AgentPubKey, u16), &Record> =
        std::collections::BTreeMap::new();
    for r in records {
        let Some(tc) = app_entry::<TaskComplete>(r) else {
            continue;
        };
        let key = (r.action().author().clone(), tc.task_id);
        if !counts(&key.0, key.1) {
            continue;
        }
        let kept_is_earlier = done.get(&key).is_some_and(|prev| {
            (prev.action().timestamp(), prev.action_address())
                <= (r.action().timestamp(), r.action_address())
        });
        if !kept_is_earlier {
            done.insert(key, r);
        }
    }
    done
}

// ---------------------------------------------------- secret task lists

/// How many tasks each player gets: enough for the crew to reach the lobby's
/// target between them (the UI sets the target as tasks each × crew), capped by
/// the number of consoles.
fn tasks_each(lobby: &Lobby, consoles: usize) -> usize {
    let crew = lobby.player_count.saturating_sub(lobby.impostor_count).max(1) as u32;
    (lobby.task_target.div_ceil(crew) as usize).clamp(1, consoles.max(1))
}

/// A seat's secret task list: `n` of the consoles, picked by a shuffle seeded
/// from the host's secret salt and the seat. Nobody but the host can work it
/// out until `RolesReveal` publishes the salt, when every list can be checked.
/// Impostors get one too, as cover.
fn task_list_for(salt: &[u8; 32], seat: u16, consoles: &[u16], n: usize) -> Vec<u16> {
    let mut ids = consoles.to_vec();
    ids.sort_unstable();
    ids.dedup();
    // Fisher–Yates, each draw from sha256(tag ‖ salt ‖ seat ‖ i)
    for i in (1..ids.len()).rev() {
        let mut h = Sha256::new();
        h.update(b"imposter:tasks:v1");
        h.update(salt);
        h.update(seat.to_be_bytes());
        h.update((i as u32).to_be_bytes());
        let d = h.finalize();
        let j = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) as usize % (i + 1);
        ids.swap(i, j);
    }
    ids.truncate(n);
    ids.sort_unstable();
    ids
}

/// `player`'s task list, from the role salt (sealed, or revealed at the end).
/// Empty for a non-player, or before the task list is published.
fn task_list_of(records: &[Record], lobby: &Lobby, rc: &RoleCommit, salt: &[u8; 32], player: &AgentPubKey) -> Vec<u16> {
    let Some(seat) = rc.seats.iter().position(|k| k == player) else {
        return vec![];
    };
    let Some(tl) = records.iter().find_map(|r| app_entry::<TaskList>(r)) else {
        return vec![];
    };
    let consoles: Vec<u16> = tl.tasks.iter().map(|t| t.id).collect();
    task_list_for(salt, seat as u16, &consoles, tasks_each(lobby, consoles.len()))
}

/// Which completions count toward the result: a crewmate's, of a task on their
/// own list. Impostors only ever fake tasks, so theirs never count — not even
/// from a modified client that records one.
// ---------------------------------------------------- XP
//
// A running total lives nowhere on this DHT: every game is its own DNA
// clone (a separate network), and a finished game's clone is disabled once
// the room moves on (`closeLobby`), so nothing could read it back afterward
// anyway. Instead each clone answers "how much XP did I earn in THIS game",
// once it has ended, and the UI is the one keeping the running total — see
// `game/xp.ts`, which records each finished game's amount the moment it's
// seen (before that clone can be disabled) and sums them locally from then
// on. That's a per-device tally, not a durable cross-agent ledger; making it
// one (so e.g. the hNFT app's shop could verify a claim independently) would
// need a dedicated, uncloned role other cells could call into.
const XP_PER_TASK: u32 = 5;
const XP_FOR_SURVIVING: u32 = 10;
const XP_FOR_WINNING: u32 = 25;

fn xp_for(tasks_done: u32, survived: bool, won: bool) -> u32 {
    XP_PER_TASK * tasks_done + if survived { XP_FOR_SURVIVING } else { 0 } + if won { XP_FOR_WINNING } else { 0 }
}

fn real_tasks(records: &[Record], lobby: &Lobby, rc: &RoleCommit, roles: &[u8], salt: &[u8; 32]) -> impl Fn(&AgentPubKey, u16) -> bool {
    let lists: std::collections::BTreeMap<AgentPubKey, Vec<u16>> = rc
        .seats
        .iter()
        .enumerate()
        .filter(|(i, _)| roles.get(*i) == Some(&ROLE_CREW))
        .map(|(_, k)| (k.clone(), task_list_of(records, lobby, rc, salt, k)))
        .collect();
    move |player, task| lists.get(player).is_some_and(|l| l.contains(&task))
}

/// My secret task list (console ids): empty until roles are dealt and the task
/// list is published. The host works its own out; everyone else asks the host.
#[hdk_extern]
pub fn my_tasks(_: ()) -> ExternResult<Vec<u16>> {
    let (_, host, _) = find_lobby()?;
    let my_key = me()?;
    if my_key == host {
        return host_task_list(&my_key);
    }
    match call_remote(host, zome_info()?.name, "provide_tasks".into(), None, ())? {
        ZomeCallResponse::Ok(io) => io
            .decode::<Vec<u16>>()
            .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("bad provide_tasks reply: {e:?}")))),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!(
            "the host could not be reached: {other:?}"
        )))),
    }
}

/// Host-side, called remotely: the caller's own task list, and nobody else's.
#[hdk_extern]
pub fn provide_tasks(_: ()) -> ExternResult<Vec<u16>> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host hands out task lists".into()
        )));
    }
    host_task_list(&call_info()?.provenance)
}

fn host_task_list(player: &AgentPubKey) -> ExternResult<Vec<u16>> {
    let (_, _, lobby) = find_lobby()?;
    let Some((_, rc)) = find_role_commit()? else {
        return Ok(vec![]);
    };
    let sealed = my_sealed_roles()?;
    Ok(task_list_of(&all_records()?, &lobby, &rc, &sealed.salt, player))
}

// ---------------------------------------------------- meetings & voting

#[derive(Serialize, Deserialize, Debug)]
pub struct ReportBody {
    pub dead: AgentPubKey,
}

#[hdk_extern]
pub fn report_body(input: ReportBody) -> ExternResult<Record> {
    open_meeting(MeetingTrigger::BodyReport, Some(input.dead))
}

#[hdk_extern]
pub fn press_emergency(_: ()) -> ExternResult<Record> {
    open_meeting(MeetingTrigger::Emergency, None)
}

/// The emergency button stays locked this long after the game starts and after
/// every meeting.
const EMERGENCY_COOLDOWN_MS: i64 = 15_000;

/// Opens a meeting under the table rules: the game has started, the caller is
/// alive and no meeting is running. A body report must name a body still lying
/// there (no meeting has cleared it); an emergency needs a use left and the
/// button off cooldown. Like the rest of the coordinator these are honest-client
/// checks: `validate` can't know "alive" without the host's secret, nor "since"
/// without trusting clocks.
fn open_meeting(trigger: MeetingTrigger, body: Option<AgentPubKey>) -> ExternResult<Record> {
    let (lobby_hash, host, _lobby) = find_lobby()?;
    let records = all_records()?;
    let Some((dealt_at, rc)) = records
        .iter()
        .find_map(|r| Some((r.action().timestamp(), app_entry::<RoleCommit>(r)?)))
    else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the game hasn't started".into()
        )));
    };
    let my_key = me()?;
    if dead_players(&records, Some(&rc)).contains(&my_key) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "ghosts can't call meetings".into()
        )));
    }
    if meeting_in_progress(&records) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "a meeting is already running".into()
        )));
    }
    match &body {
        Some(dead) => {
            if !live_bodies(&records).iter().any(|(k, _)| k == dead) {
                return Err(wasm_error!(WasmErrorInner::Guest(
                    "no body to report: not killed, or already cleared by a meeting".into()
                )));
            }
        }
        None => {
            let allowed = current_settings(Some(&host))?.emergency_meetings as usize;
            if allowed == 0 {
                return Err(wasm_error!(WasmErrorInner::Guest(
                    "this game has no emergency meetings".into()
                )));
            }
            if emergencies_used(&records, &my_key) >= allowed {
                return Err(wasm_error!(WasmErrorInner::Guest(
                    "you've used your emergency meetings".into()
                )));
            }
            if crisis_state(&records, &host, &rc, now_ms()?)?.active.is_some() {
                return Err(wasm_error!(WasmErrorInner::Guest(
                    "no emergency meetings during a crisis: stabilise it first".into()
                )));
            }
            let wait = emergency_unlocks_at(&records, dealt_at) - now_ms()?;
            if wait > 0 {
                return Err(wasm_error!(WasmErrorInner::Guest(format!(
                    "the emergency button unlocks in {}s",
                    (wait + 999) / 1000
                ))));
            }
        }
    }
    let ah = create_entry(EntryTypes::Meeting(Meeting {
        lobby: lobby_hash,
        trigger,
        body,
        tie_breaker_for: None,
    }))?;
    link_entry(&ah)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("meeting vanished".into())))
}

/// Everyone out of the game: killed (they filed a `KillReport`) or voted off.
fn dead_players(records: &[Record], rc: Option<&RoleCommit>) -> Vec<AgentPubKey> {
    let mut dead: Vec<AgentPubKey> = Vec::new();
    for r in records {
        let out = if app_entry::<KillReport>(r).is_some() {
            Some(r.action().author().clone())
        } else {
            match (app_entry::<Ejection>(r).map(|e| e.outcome), rc) {
                (Some(TallyOutcome::Ejected { seat }), Some(rc)) => rc.seats.get(seat as usize).cloned(),
                _ => None,
            }
        };
        if let Some(k) = out {
            if !dead.contains(&k) {
                dead.push(k);
            }
        }
    }
    dead
}

/// The latest meeting is still open: unresolved, or tied with its tie breaker
/// about to open (the same test `get_game_state` uses for the phase).
fn meeting_in_progress(records: &[Record]) -> bool {
    let Some(latest) = records
        .iter()
        .filter(|r| app_entry::<Meeting>(r).is_some())
        .max_by_key(|r| r.action().timestamp())
    else {
        return false;
    };
    match records
        .iter()
        .filter_map(|r| app_entry::<Ejection>(r))
        .find(|e| &e.meeting == latest.action_address())
    {
        None => true,
        Some(e) => matches!(e.outcome, TallyOutcome::Tie { .. }),
    }
}

/// Killed players whose body is still on the map — killed after the latest
/// meeting opened, since every meeting clears the bodies — with when they died.
/// Kill and meeting times come from different agents' clocks; fine on one
/// machine, and off only by clock skew between machines.
fn live_bodies(records: &[Record]) -> Vec<(AgentPubKey, Timestamp)> {
    let last_meeting = records
        .iter()
        .filter(|r| app_entry::<Meeting>(r).is_some())
        .map(|r| r.action().timestamp())
        .max();
    let mut bodies: Vec<(AgentPubKey, Timestamp)> = Vec::new();
    for r in records {
        if app_entry::<KillReport>(r).is_none() {
            continue;
        }
        let at = r.action().timestamp();
        if last_meeting.is_some_and(|m| at <= m) {
            continue;
        }
        let key = r.action().author().clone();
        if !bodies.iter().any(|(k, _)| k == &key) {
            bodies.push((key, at));
        }
    }
    bodies
}

/// Emergency meetings this player has called (tie breakers repeat their
/// meeting's trigger, but are the host's, and don't count).
fn emergencies_used(records: &[Record], key: &AgentPubKey) -> usize {
    records
        .iter()
        .filter(|r| r.action().author() == key)
        .filter_map(|r| app_entry::<Meeting>(r))
        .filter(|m| m.trigger == MeetingTrigger::Emergency && m.tie_breaker_for.is_none())
        .count()
}

/// When the latest meeting closed. A tie doesn't close one: its tie breaker follows.
fn last_meeting_closed(records: &[Record]) -> Option<Timestamp> {
    records
        .iter()
        .filter(|r| app_entry::<Ejection>(r).is_some_and(|e| !matches!(e.outcome, TallyOutcome::Tie { .. })))
        .map(|r| r.action().timestamp())
        .max()
}

/// When the emergency button unlocks (ms since the epoch): a cooldown after the
/// game started and after the latest meeting closed.
fn emergency_unlocks_at(records: &[Record], dealt_at: Timestamp) -> i64 {
    let since = last_meeting_closed(records).map_or(dealt_at, |t| t.max(dealt_at));
    since.as_millis() as i64 + EMERGENCY_COOLDOWN_MS
}

/// Kill and meeting times come from different agents' clocks; allow this much skew.
const CLOCK_SLACK_MS: i64 = 1_000;

/// When this impostor may kill again (ms since the epoch): a cooldown after the
/// game started, after the latest meeting closed and after their last kill.
fn kill_unlocks_at(records: &[Record], dealt_at: Timestamp, killer: &AgentPubKey, cooldown_ms: i64) -> i64 {
    let last_kill = records
        .iter()
        .filter(|r| app_entry::<KillReport>(r).is_some_and(|kr| &kr.killer == killer))
        .map(|r| r.action().timestamp())
        .max();
    let since = [last_meeting_closed(records), last_kill]
        .into_iter()
        .flatten()
        .fold(dealt_at, |a, t| a.max(t));
    since.as_millis() as i64 + cooldown_ms
}

/// The kill rules. The killer checks them before signalling, for a clear error;
/// the victim checks them before recording its death, which is what makes them
/// stick. The game is on and no meeting is running, both players are alive,
/// `proof` opens the role commitment at the killer's seat as an impostor, and
/// the killer's cooldown has run out. Distance can't be checked: positions only
/// exist in PeerKit.
fn kill_allowed(
    records: &[Record],
    killer: &AgentPubKey,
    victim: &AgentPubKey,
    seat: u16,
    role: u8,
    proof: &RoleProof,
    now: i64,
    cooldown_ms: i64,
) -> Result<(), String> {
    let Some((dealt_at, rc)) = records
        .iter()
        .find_map(|r| Some((r.action().timestamp(), app_entry::<RoleCommit>(r)?)))
    else {
        return Err("the game hasn't started".into());
    };
    if records.iter().any(|r| app_entry::<GameResult>(r).is_some()) {
        return Err("the game is over".into());
    }
    let seated = rc.seats.get(seat as usize) == Some(killer);
    if !seated || role != ROLE_IMPOSTOR || !verify_role_proof(&rc.merkle_root, seat, role, proof) {
        return Err("only an impostor can kill".into());
    }
    let dead = dead_players(records, Some(&rc));
    if dead.contains(killer) {
        return Err("ghosts can't kill".into());
    }
    if killer == victim || !rc.seats.contains(victim) || dead.contains(victim) {
        return Err("that player isn't alive in this game".into());
    }
    if meeting_in_progress(records) {
        return Err("not during a meeting".into());
    }
    let wait = kill_unlocks_at(records, dealt_at, killer, cooldown_ms) - now - CLOCK_SLACK_MS;
    if wait > 0 {
        return Err(format!("kill cooldown: {}s left", (wait + 999) / 1000));
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CommitVote {
    pub meeting: ActionHash,
    pub commitment: [u8; 32],
}

#[hdk_extern]
pub fn commit_vote(input: CommitVote) -> ExternResult<Record> {
    // No votes until the discussion time is up; a tie breaker has none. An
    // honest-client rule, and clocks differ between agents, hence the slack.
    let record = get(input.meeting.clone(), GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("meeting not found".into())))?;
    let meeting: Meeting = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("that's not a meeting".into())))?;
    if meeting.tie_breaker_for.is_none() {
        let (_, host, _) = find_lobby()?;
        let discussion_ms = current_settings(Some(&host))?.discussion_s as i64 * 1000;
        let wait = record.action().timestamp().as_millis() as i64 + discussion_ms - now_ms()? - CLOCK_SLACK_MS;
        if wait > 0 {
            return Err(wasm_error!(WasmErrorInner::Guest(format!(
                "still in discussion: voting opens in {}s",
                (wait + 999) / 1000
            ))));
        }
    }
    let ah = create_entry(EntryTypes::VoteCommit(VoteCommit {
        meeting: input.meeting,
        commitment: input.commitment,
    }))?;
    link_entry(&ah)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("vote commit vanished".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RevealVote {
    pub meeting: ActionHash,
    pub choice: Option<AgentPubKey>,
    pub salt: [u8; 32],
}

#[hdk_extern]
pub fn reveal_vote(input: RevealVote) -> ExternResult<Record> {
    let my_key = me()?;
    let commit_hash = all_records()?
        .into_iter()
        .find_map(|r| {
            let vc = app_entry::<VoteCommit>(&r)?;
            if vc.meeting == input.meeting && *r.action().author() == my_key {
                Some(r.action_address().clone())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            wasm_error!(WasmErrorInner::Guest(
                "you have not committed a vote for this meeting".into()
            ))
        })?;

    let ah = create_entry(EntryTypes::VoteReveal(VoteReveal {
        meeting: input.meeting,
        commit: commit_hash,
        choice: input.choice,
        salt: input.salt,
    }))?;
    link_entry(&ah)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("vote reveal vanished".into())))
}

/// Host only. Tally the revealed votes for a meeting and publish the `Ejection`.
///
/// The option with the most votes wins: that player is voted off (and, when the
/// settings confirm ejects, the host opens their role with a `RoleReveal`), or nobody is if it is Skip. A tie
/// publishes a `Tie` and, in the same call, opens the tie-breaker meeting with
/// only the tied options on its ballot. A tie-breaker always decides — see
/// `imposter_core::tally_tie_breaker`.
///
/// Host only so one agent decides when voting closes, and a tie opens exactly
/// one tie-breaker.
#[hdk_extern]
pub fn resolve_meeting(meeting_hash: ActionHash) -> ExternResult<Record> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host tallies votes".into()
        )));
    }
    let records = all_records()?;
    if records
        .iter()
        .filter_map(|r| app_entry::<Ejection>(r))
        .any(|e| e.meeting == meeting_hash)
    {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "this meeting is already resolved".into()
        )));
    }
    let (rc_hash, rc) = find_role_commit()?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("roles not dealt".into())))?;
    let meeting: Meeting = fetch(&meeting_hash)?;
    let ballot: Option<Vec<Option<u16>>> = match &meeting.tie_breaker_for {
        None => None,
        Some(tied) => match fetch::<Ejection>(tied)?.outcome {
            TallyOutcome::Tie { candidates } => Some(candidates),
            _ => {
                return Err(wasm_error!(WasmErrorInner::Guest(
                    "a tie-breaker must follow a tied vote".into()
                )))
            }
        },
    };

    let mut seen: Vec<AgentPubKey> = Vec::new();
    let mut reveals: Vec<ActionHash> = Vec::new();
    let mut votes: Vec<Vote> = Vec::new();
    for r in &records {
        let Some(vr) = app_entry::<VoteReveal>(r) else {
            continue;
        };
        if vr.meeting != meeting_hash {
            continue;
        }
        // Citing a vote for a non-player, or an off-ballot tie-breaker vote,
        // would make the whole claim fail validation — leave those out.
        let choice_seat = match &vr.choice {
            None => None,
            Some(k) => match rc.seats.iter().position(|s| s == k) {
                Some(i) => Some(i as u16),
                None => continue,
            },
        };
        if ballot.as_ref().is_some_and(|b| !b.contains(&choice_seat)) {
            continue;
        }
        let voter = r.action().author().clone();
        if seen.contains(&voter) {
            continue;
        }
        seen.push(voter.clone());
        reveals.push(r.action_address().clone());
        let voter_seat = rc
            .seats
            .iter()
            .position(|s| s == &voter)
            .map(|i| i as u16)
            .unwrap_or(0);
        votes.push(Vote {
            voter: voter_seat,
            choice: choice_seat,
            salt: vr.salt,
        });
    }

    let outcome = match &ballot {
        None => tally(&votes),
        Some(candidates) => tally_tie_breaker(&votes, candidates),
    };
    let ejection = create_entry(EntryTypes::Ejection(Ejection {
        meeting: meeting_hash,
        role_commit: rc_hash.clone(),
        outcome: outcome.clone(),
        reveals,
    }))?;
    link_entry(&ejection)?;

    match outcome {
        TallyOutcome::Tie { .. } => {
            let tie_breaker = create_entry(EntryTypes::Meeting(Meeting {
                lobby: meeting.lobby,
                trigger: meeting.trigger,
                body: meeting.body,
                tie_breaker_for: Some(ejection.clone()),
            }))?;
            link_entry(&tie_breaker)?;
        }
        TallyOutcome::Ejected { seat } => {
            // With confirm ejects off, the role stays sealed until `reveal_all`.
            let opened = records
                .iter()
                .filter_map(|r| app_entry::<RoleReveal>(r))
                .any(|rr| rr.seat == seat);
            if current_settings(Some(&host))?.confirm_ejects && !opened {
                let sealed = my_sealed_roles()?;
                let layers = build_layers(&sealed.roles, &sealed.salt);
                let proof = role_proof(&layers, &sealed.salt, seat);
                let rr = create_entry(EntryTypes::RoleReveal(RoleReveal {
                    role_commit: rc_hash,
                    seat,
                    role: sealed.roles[seat as usize],
                    proof,
                }))?;
                link_entry(&rr)?;
            }
        }
        TallyOutcome::NoEjection => {}
    }

    get(ejection, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("ejection vanished".into())))
}

// ---------------------------------------------------- reveal & result

/// Host only. Open the whole role vector for audit.
#[hdk_extern]
pub fn reveal_all(_: ()) -> ExternResult<Record> {
    let (rc_hash, _rc) = find_role_commit()?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("roles not dealt".into())))?;
    let sealed = my_sealed_roles()?;
    let ah = create_entry(EntryTypes::RolesReveal(RolesReveal {
        role_commit: rc_hash,
        roles: sealed.roles,
        salt: sealed.salt,
    }))?;
    link_entry(&ah)?;
    get(ah, GetOptions::network())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("roles reveal vanished".into())))
}

/// Recompute the live counts and, if the game is over, publish the
/// `GameResult`. Requires `reveal_all` to have run first (validation of
/// `GameResult` checks against the revealed vector).
#[hdk_extern]
pub fn check_result(_: ()) -> ExternResult<Option<Record>> {
    let records = all_records()?;
    let (lobby_hash, _host, lobby) = find_lobby()?;
    let Some((_rc_hash, rc)) = find_role_commit()? else {
        return Ok(None);
    };
    let Some((rr_hash, roles_reveal)) = records.iter().find_map(|r| {
        Some((r.action_address().clone(), app_entry::<RolesReveal>(r)?))
    }) else {
        return Ok(None);
    };
    let roles = &roles_reveal.roles;
    let seats = &rc.seats;

    let mut dead: Vec<AgentPubKey> = Vec::new();
    let mut evidence: Vec<ActionHash> = Vec::new();

    for r in &records {
        let ah = r.action_address().clone();
        if let Some(kr) = app_entry::<KillReport>(r) {
            let _ = kr;
            let victim = r.action().author().clone();
            if !dead.contains(&victim) {
                dead.push(victim);
            }
            evidence.push(ah);
        } else if let Some(ej) = app_entry::<Ejection>(r) {
            if let TallyOutcome::Ejected { seat } = ej.outcome {
                if let Some(k) = seats.get(seat as usize) {
                    if !dead.contains(k) {
                        dead.push(k.clone());
                    }
                }
            }
            evidence.push(ah);
        }
    }
    // crewmates' completions of their own tasks, one each — see `real_tasks`
    let tasks = task_completions(&records, real_tasks(&records, &lobby, &rc, roles, &roles_reveal.salt));
    evidence.extend(tasks.values().map(|r| r.action_address().clone()));

    let mut impostors_alive = 0u32;
    let mut crew_alive = 0u32;
    for (i, k) in seats.iter().enumerate() {
        if dead.contains(k) {
            continue;
        }
        match roles[i] {
            ROLE_IMPOSTOR => impostors_alive += 1,
            ROLE_CREW => crew_alive += 1,
            _ => {}
        }
    }
    let tasks_done = tasks.len() as u32;
    let tasks_total = lobby.task_target;

    let Some(oc) = win_outcome(impostors_alive, crew_alive, tasks_done, tasks_total) else {
        return Ok(None);
    };
    if records
        .iter()
        .filter_map(|r| app_entry::<GameResult>(r))
        .next()
        .is_some()
    {
        // already published; return it
        let existing = records
            .into_iter()
            .find(|r| app_entry::<GameResult>(r).is_some())
            .unwrap();
        return Ok(Some(existing));
    }

    let ah = create_entry(EntryTypes::GameResult(GameResult {
        lobby: lobby_hash,
        roles_reveal: rr_hash,
        outcome: oc,
        impostors_alive,
        crew_alive,
        tasks_done,
        tasks_total,
        evidence,
        meltdown: None,
    }))?;
    link_entry(&ah)?;
    Ok(get(ah, GetOptions::network())?)
}

/// Host only, safe to call on a timer. Compute the live counts from the host's
/// own `SealedRoles` plus the public kill/ejection/task evidence; if the game
/// is over, publish `RolesReveal` then `GameResult` in one go. Returns the
/// result once it exists.
#[hdk_extern]
pub fn try_finish(_: ()) -> ExternResult<Option<GameResultView>> {
    let records = all_records()?;

    // already finished?
    if let Some(gr) = records.iter().find_map(|r| app_entry::<GameResult>(r)) {
        return Ok(Some(result_view(&gr)?));
    }

    let (_lobby_hash, host, lobby) = find_lobby()?;
    if me()? != host {
        return Ok(None); // only the host drives the finish
    }
    let Some((rc_hash, rc)) = find_role_commit()? else {
        return Ok(None);
    };
    let sealed = match my_sealed_roles() {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let roles = &sealed.roles;
    let seats = &rc.seats;

    let mut dead: Vec<AgentPubKey> = Vec::new();
    for r in &records {
        if app_entry::<KillReport>(r).is_some() {
            let v = r.action().author().clone();
            if !dead.contains(&v) {
                dead.push(v);
            }
        } else if let Some(ej) = app_entry::<Ejection>(r) {
            if let TallyOutcome::Ejected { seat } = ej.outcome {
                if let Some(k) = seats.get(seat as usize) {
                    if !dead.contains(k) {
                        dead.push(k.clone());
                    }
                }
            }
        }
    }

    let mut impostors_alive = 0u32;
    let mut crew_alive = 0u32;
    for (i, k) in seats.iter().enumerate() {
        if dead.contains(k) {
            continue;
        }
        match roles.get(i).copied() {
            Some(ROLE_IMPOSTOR) => impostors_alive += 1,
            Some(ROLE_CREW) => crew_alive += 1,
            _ => {}
        }
    }
    let tasks = task_completions(&records, real_tasks(&records, &lobby, &rc, roles, &sealed.salt));
    let tasks_done = tasks.len() as u32;
    let tasks_total = lobby.task_target;

    // the counts first; failing that, a crisis that ran out
    let (oc, meltdown) = match win_outcome(impostors_alive, crew_alive, tasks_done, tasks_total) {
        Some(oc) => (oc, None),
        None => match crisis_state(&records, &host, &rc, now_ms()?)?.melted {
            Some((kind, start)) => (GameOutcome::ImpostorsWin, Some((kind, start))),
            None => return Ok(None),
        },
    };

    // publish the full reveal (if not already) then the result
    let rr_hash = match records
        .iter()
        .find_map(|r| Some((r.action_address().clone(), app_entry::<RolesReveal>(r)?)))
    {
        Some((h, _)) => h,
        None => {
            let h = create_entry(EntryTypes::RolesReveal(RolesReveal {
                role_commit: rc_hash,
                roles: sealed.roles.clone(),
                salt: sealed.salt,
            }))?;
            link_entry(&h)?;
            h
        }
    };

    // re-collect evidence hashes for the GameResult: every kill and ejection,
    // and the completions that counted (see `real_tasks`)
    let mut evidence: Vec<ActionHash> = records
        .iter()
        .filter(|r| app_entry::<KillReport>(r).is_some() || app_entry::<Ejection>(r).is_some())
        .map(|r| r.action_address().clone())
        .collect();
    evidence.extend(tasks.values().map(|r| r.action_address().clone()));

    let (lobby_hash, _, _) = find_lobby()?;
    let ah = create_entry(EntryTypes::GameResult(GameResult {
        lobby: lobby_hash,
        roles_reveal: rr_hash,
        outcome: oc,
        impostors_alive,
        crew_alive,
        tasks_done,
        tasks_total,
        evidence,
        meltdown: meltdown.as_ref().map(|(_, start)| start.clone()),
    }))?;
    link_entry(&ah)?;

    Ok(Some(GameResultView {
        outcome: oc,
        impostors_alive,
        crew_alive,
        tasks_done,
        tasks_total,
        meltdown: meltdown.map(|(kind, _)| kind),
    }))
}

// ---------------------------------------------------- relay sharing

/// The PeerKit relay address players share with this game, so everyone else
/// gets it filled in instead of pasting it. Kept as link tags on an anchor of
/// its own: not entries, and not under the `game` anchor, so `all_records`
/// never sees them.
fn relay_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_RELAY)
}

/// A multiaddr is ~200 bytes; this only stops junk from bloating the DHT.
const MAX_RELAY_ADDR_LEN: usize = 512;

/// Share a relay address that works for the caller. The UI only calls this
/// once its PeerKit node has actually reached the relay, so a stale address
/// never spreads.
#[hdk_extern]
pub fn share_relay(addr: String) -> ExternResult<()> {
    let addr = addr.trim().to_string();
    if addr.is_empty() || addr.len() > MAX_RELAY_ADDR_LEN {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "relay address must be 1..={MAX_RELAY_ADDR_LEN} bytes"
        ))));
    }
    if get_relay(())?.as_deref() == Some(addr.as_str()) {
        return Ok(()); // already the newest shared address
    }
    create_link(relay_anchor()?, me()?, LinkTypes::GameToEntry, LinkTag::new(addr))?;
    Ok(())
}

/// The most recently shared relay address in this game, if any. Newest wins,
/// so a restarted relay (new peer id, new address) replaces the old one.
#[hdk_extern]
pub fn get_relay(_: ()) -> ExternResult<Option<String>> {
    let links = get_links(
        LinkQuery::try_new(relay_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    Ok(links
        .into_iter()
        .max_by_key(|l| l.timestamp)
        .and_then(|l| String::from_utf8(l.tag.into_inner()).ok()))
}

// ---------------------------------------------------- bodies


/// A body still on the map (killed since the latest meeting). `at` is empty
/// until the victim's client has marked the spot.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BodyView {
    pub key: AgentPubKey,
    pub at: Option<BodyAt>,
}

fn bodies_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_BODIES)
}

/// The victim marks where they died — their client does, the moment it learns
/// of the kill. Movement never reaches the DHT, so this is the only record of
/// the spot. The first mark stands, so the ghost moving on can't drag the body
/// along. A link tag, like the relay address.
#[hdk_extern]
pub fn mark_body(at: BodyAt) -> ExternResult<()> {
    let my_key = me()?;
    let killed = all_records()?
        .iter()
        .any(|r| r.action().author() == &my_key && app_entry::<KillReport>(r).is_some());
    if !killed {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only a killed player marks their body".into()
        )));
    }
    if body_marks()?.contains_key(&my_key) {
        return Ok(()); // the first mark stands
    }
    let tag = encode(&at).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(bodies_anchor()?, my_key, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// Each player's first body mark, keyed by its author — a player can only mark
/// their own body, and only a killed player's mark is ever shown.
fn body_marks() -> ExternResult<std::collections::BTreeMap<AgentPubKey, BodyAt>> {
    let links = get_links(
        LinkQuery::try_new(bodies_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    let mut first: std::collections::BTreeMap<AgentPubKey, (Timestamp, BodyAt)> =
        std::collections::BTreeMap::new();
    for l in links {
        let bytes = l.tag.into_inner();
        let Ok(at) = decode::<_, BodyAt>(&bytes) else {
            continue;
        };
        if first.get(&l.author).is_some_and(|(t, _)| *t <= l.timestamp) {
            continue;
        }
        first.insert(l.author, (l.timestamp, at));
    }
    Ok(first.into_iter().map(|(k, (_, at))| (k, at)).collect())
}

// ---------------------------------------------------- game settings



fn settings_anchor() -> ExternResult<AnyLinkableHash> {
    anchor_hash(ANCHOR_SETTINGS)
}

/// Host only, and only before roles are dealt.
#[hdk_extern]
pub fn set_settings(settings: GameSettings) -> ExternResult<()> {
    let (_, host, _) = find_lobby()?;
    if me()? != host {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the host changes the settings".into()
        )));
    }
    if find_role_commit()?.is_some() {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "the settings are fixed once the game has started".into()
        )));
    }
    let tag = encode(&settings).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?;
    create_link(settings_anchor()?, host, LinkTypes::GameToEntry, LinkTag::new(tag))?;
    Ok(())
}

/// The host's newest settings, or the defaults. Links anyone else made are ignored.
fn current_settings(host: Option<&AgentPubKey>) -> ExternResult<GameSettings> {
    let Some(host) = host else {
        return Ok(GameSettings::default());
    };
    let links = get_links(
        LinkQuery::try_new(settings_anchor()?, LinkTypes::GameToEntry)?,
        GetStrategy::Network,
    )?;
    Ok(links
        .into_iter()
        .filter(|l| &l.author == host)
        .max_by_key(|l| l.timestamp)
        .and_then(|l| decode::<_, GameSettings>(&l.tag.into_inner()).ok())
        .unwrap_or_default())
}

/// The host's kill cooldown, in ms.
fn kill_cooldown_ms(settings: &GameSettings) -> i64 {
    settings.kill_cooldown_s as i64 * 1000
}

/// This game's kill cooldown, as the host set it.
fn kill_cooldown() -> ExternResult<i64> {
    let (_, host, _) = find_lobby()?;
    Ok(kill_cooldown_ms(&current_settings(Some(&host))?))
}

/// Player colors, by the order players joined: the host first, then each
/// `PlayerJoin` as it was published. Stable while a lobby fills up, and the
/// same for everyone.
fn join_order(records: &[Record]) -> std::collections::BTreeMap<AgentPubKey, u8> {
    let mut joins: Vec<(Timestamp, &ActionHash, AgentPubKey)> = records
        .iter()
        .filter(|r| app_entry::<PlayerJoin>(r).is_some())
        .map(|r| (r.action().timestamp(), r.action_address(), r.action().author().clone()))
        .collect();
    joins.sort();
    let mut order = std::collections::BTreeMap::new();
    for (_, _, key) in joins {
        let next = order.len() as u8;
        order.entry(key).or_insert(next);
    }
    order
}

// ---------------------------------------------------- cooked read

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Lobby,
    Playing,
    Meeting,
    Ended,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerView {
    pub key: AgentPubKey,
    pub name: String,
    pub seat: Option<u16>,
    pub dead: bool,
    pub is_host: bool,
    /// Only ever set for the calling agent's own seat, or after a reveal.
    pub role: Option<u8>,
    /// Index into the UI's palette, by join order.
    pub color: u8,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MeetingView {
    pub meeting: ActionHash,
    /// When the meeting opened, ms since the epoch; its timers count from here.
    pub opened_at_ms: i64,
    pub trigger: MeetingTrigger,
    pub body: Option<AgentPubKey>,
    /// Set on a tie-breaker: the options tied in the vote before (seat, or
    /// `None` for Skip), the only valid votes. Empty until that vote has synced.
    pub candidates: Option<Vec<Option<u16>>>,
    pub committed: Vec<AgentPubKey>,
    pub revealed: Vec<AgentPubKey>,
    pub resolved: Option<TallyOutcome>,
    /// Once tallied: the votes the tally counted. `voter` is left out when the
    /// host's settings make votes anonymous.
    pub votes: Vec<VoteView>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VoteView {
    pub voter: Option<u16>,
    /// A seat, or `None` for Skip.
    pub choice: Option<u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GameStateView {
    pub me: AgentPubKey,
    pub is_host: bool,
    pub phase: Phase,
    pub code: Option<String>,
    pub player_count: u16,
    pub impostor_count: u16,
    pub task_target: u32,
    pub players: Vec<PlayerView>,
    pub roles_dealt: bool,
    pub my_seat: Option<u16>,
    pub my_role: Option<u8>,
    pub tasks: Vec<Task>,
    pub tasks_done: u32,
    /// The crew's task count as it stood when the latest meeting opened (0
    /// before any), for a task bar that only updates at meetings.
    pub tasks_done_at_meeting: u32,
    pub my_tasks_done: Vec<u16>,
    pub active_meeting: Option<MeetingView>,
    pub role_reveals: Vec<(u16, u8)>,
    pub result: Option<GameResultView>,
    /// My XP for this game — tasks, survival and the win — once it has ended.
    /// See the "XP" section above: this game's clone is the only place it's
    /// computed; the UI keeps the running total.
    pub my_xp: Option<u32>,
    pub settings: GameSettings,
    /// Bodies still on the map (killed since the latest meeting).
    pub bodies: Vec<BodyView>,
    /// Emergency meetings I can still call.
    pub emergencies_left: u16,
    /// When the emergency button unlocks, ms since the epoch; none before the game starts.
    pub emergency_ready_at: Option<i64>,
    /// When I could kill again if I'm an impostor, ms since the epoch; none before the game starts.
    pub kill_ready_at: Option<i64>,
    /// Sabotaged: the crew's vision shrinks until someone fixes the lights.
    pub lights_out: bool,
    /// When an impostor may next cut the lights, ms since the epoch; none before the game starts.
    pub lights_ready_at: Option<i64>,
    /// Sabotaged: task lists and the task bar go dark until someone fixes comms.
    pub comms_out: bool,
    /// When an impostor may next cut comms, ms since the epoch; none before the game starts.
    pub comms_ready_at: Option<i64>,
    /// Rooms whose doors are shut right now.
    pub doors_closed: Vec<DoorsView>,
    /// When impostors may shut doors next, ms since the epoch; none before the game starts.
    pub doors_ready_at: Option<i64>,
    /// A crisis sabotage under way: stabilise it before it runs out, or the impostors win.
    pub crisis: Option<CrisisView>,
    /// When an impostor may next start a crisis, ms since the epoch; none before the game starts.
    pub crisis_ready_at: Option<i64>,
    /// I joined this lobby but hold no seat: it filled up first.
    pub seat_lost: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GameResultView {
    pub outcome: GameOutcome,
    pub impostors_alive: u32,
    pub crew_alive: u32,
    pub tasks_done: u32,
    pub tasks_total: u32,
    /// Set when the impostors won because a crisis ran out.
    pub meltdown: Option<CrisisKind>,
}

fn result_view(gr: &GameResult) -> ExternResult<GameResultView> {
    Ok(GameResultView {
        outcome: gr.outcome,
        impostors_alive: gr.impostors_alive,
        crew_alive: gr.crew_alive,
        tasks_done: gr.tasks_done,
        tasks_total: gr.tasks_total,
        meltdown: match &gr.meltdown {
            Some(start) => meltdown_kind(start)?,
            None => None,
        },
    })
}

#[hdk_extern]
pub fn get_game_state(_: ()) -> ExternResult<GameStateView> {
    let my_key = me()?;
    let records = all_records()?;

    let lobby = records.iter().find_map(|r| {
        Some((r.action_address().clone(), r.action().author().clone(), app_entry::<Lobby>(r)?))
    });
    let (lobby_hash, host, lobby) = match lobby {
        Some((a, h, l)) => (Some(a), Some(h), Some(l)),
        None => (None, None, None),
    };
    let is_host = host.as_ref() == Some(&my_key);

    let names = display_names(&records);
    let role_commit = records
        .iter()
        .find_map(|r| Some((r.action_address().clone(), app_entry::<RoleCommit>(r)?)));

    let dead = dead_players(&records, role_commit.as_ref().map(|(_, rc)| rc));

    // role reveals visible to everyone
    let mut role_reveals: Vec<(u16, u8)> = Vec::new();
    for r in &records {
        if let Some(rr) = app_entry::<RoleReveal>(r) {
            role_reveals.push((rr.seat, rr.role));
        }
        if let Some(all) = app_entry::<RolesReveal>(r) {
            for (i, role) in all.roles.iter().enumerate() {
                role_reveals.push((i as u16, *role));
            }
        }
    }
    role_reveals.sort_by_key(|(s, _)| *s);
    role_reveals.dedup_by_key(|(s, _)| *s);

    // players
    let seats: Vec<AgentPubKey> = match (&role_commit, &lobby_hash, &host, &lobby) {
        (Some((_, rc)), _, _, _) => rc.seats.clone(),
        (None, Some(lh), Some(h), Some(l)) => seat_keys(&seated_joins(&records, lh, h, l.player_count as usize)),
        _ => vec![],
    };
    // I joined, but someone else got the seat: the last one went to an
    // earlier join, or the game started without me.
    let seat_lost = !seats.contains(&my_key)
        && records.iter().any(|r| {
            r.action().author() == &my_key
                && app_entry::<PlayerJoin>(r).is_some_and(|j| Some(&j.lobby) == lobby_hash.as_ref())
        });
    let my_seat = seats.iter().position(|k| k == &my_key).map(|i| i as u16);
    let revealed_map: std::collections::BTreeMap<u16, u8> = role_reveals.iter().cloned().collect();

    let colors = join_order(&records);
    let players: Vec<PlayerView> = seats
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let seat = if role_commit.is_some() {
                Some(i as u16)
            } else {
                None
            };
            let role = revealed_map.get(&(i as u16)).copied().or_else(|| {
                if Some(i as u16) == my_seat {
                    None // filled from my_role below by the UI if it has the signal
                } else {
                    None
                }
            });
            PlayerView {
                key: k.clone(),
                name: names.get(k).cloned().unwrap_or_else(|| short_key(k)),
                seat,
                dead: dead.contains(k),
                is_host: host.as_ref() == Some(k),
                role,
                color: colors.get(k).copied().unwrap_or(0),
            }
        })
        .collect();

    // tasks — each player has their own list, and completions count per player.
    // Only the host knows who's crew and whose tasks are whose, so this public
    // count takes every recorded completion; the result counts only real ones.
    let task_list = records.iter().find_map(|r| app_entry::<TaskList>(r));
    let tasks = task_list.map(|t| t.tasks).unwrap_or_default();
    let completions = task_completions(&records, |_, _| true);
    let my_tasks_done: Vec<u16> = completions
        .keys()
        .filter(|(k, _)| k == &my_key)
        .map(|(_, id)| *id)
        .collect();
    let tasks_done = completions.len() as u32;
    let last_meeting = records
        .iter()
        .filter(|r| app_entry::<Meeting>(r).is_some())
        .map(|r| r.action().timestamp())
        .max();
    let tasks_done_at_meeting = last_meeting.map_or(0, |at| {
        completions.values().filter(|r| r.action().timestamp() <= at).count() as u32
    });

    let settings = current_settings(host.as_ref())?;

    // meeting: the most recent one — the tie-breaker, once a vote has tied
    let latest_meeting = records
        .iter()
        .filter_map(|r| {
            Some((
                r.action().timestamp(),
                r.action_address().clone(),
                app_entry::<Meeting>(r)?,
            ))
        })
        .max_by_key(|(at, _, _)| *at);
    let active_meeting = latest_meeting.map(|(opened_at, mh, m)| {
        let candidates = m.tie_breaker_for.as_ref().map(|tied| {
            records
                .iter()
                .find(|r| r.action_address() == tied)
                .and_then(|r| match app_entry::<Ejection>(r)?.outcome {
                    TallyOutcome::Tie { candidates } => Some(candidates),
                    _ => None,
                })
                .unwrap_or_default()
        });
        let ejection = records
            .iter()
            .filter_map(|r| app_entry::<Ejection>(r))
            .find(|e| e.meeting == mh);
        let resolved = ejection.as_ref().map(|e| e.outcome.clone());
        // Once tallied, who voted for what: the reveals the tally cited.
        let seat_of = |k: &AgentPubKey| seats.iter().position(|s| s == k).map(|i| i as u16);
        let votes: Vec<VoteView> = ejection
            .map(|e| {
                e.reveals
                    .iter()
                    .filter_map(|h| {
                        let r = records.iter().find(|r| r.action_address() == h)?;
                        let vr = app_entry::<VoteReveal>(r)?;
                        Some(VoteView {
                            voter: if settings.anonymous_votes {
                                None
                            } else {
                                seat_of(r.action().author())
                            },
                            choice: vr.choice.as_ref().and_then(|k| seat_of(k)),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let committed: Vec<AgentPubKey> = records
            .iter()
            .filter_map(|r| {
                let vc = app_entry::<VoteCommit>(r)?;
                (vc.meeting == mh).then(|| r.action().author().clone())
            })
            .collect();
        let revealed: Vec<AgentPubKey> = records
            .iter()
            .filter_map(|r| {
                let vr = app_entry::<VoteReveal>(r)?;
                (vr.meeting == mh).then(|| r.action().author().clone())
            })
            .collect();
        MeetingView {
            opened_at_ms: opened_at.as_millis() as i64,
            meeting: mh,
            trigger: m.trigger,
            body: m.body,
            candidates,
            committed,
            revealed,
            resolved,
            votes,
        }
    });

    let result = match records.iter().find_map(|r| app_entry::<GameResult>(r)) {
        Some(gr) => Some(result_view(&gr)?),
        None => None,
    };

    // XP: only once the game has ended, from the same evidence `GameResult`
    // was built from — my own real tasks, whether I survived, and whether I
    // won. Doesn't need a new entry or link: it's a read over what's already
    // public once `reveal_all` + `check_result` have run.
    let my_xp = match (&result, &role_commit, &lobby) {
        (Some(res), Some((_, rc)), Some(lob)) => records
            .iter()
            .find_map(|r| app_entry::<RolesReveal>(r))
            .and_then(|rr| {
                let seat = rc.seats.iter().position(|k| k == &my_key)?;
                let counts = real_tasks(&records, lob, rc, &rr.roles, &rr.salt);
                let my_tasks = task_completions(&records, |k, t| k == &my_key && counts(k, t)).len() as u32;
                let survived = !dead.contains(&my_key);
                let won = (rr.roles.get(seat).copied() == Some(ROLE_IMPOSTOR))
                    == matches!(res.outcome, GameOutcome::ImpostorsWin);
                Some(xp_for(my_tasks, survived, won))
            }),
        _ => None,
    };

    let (lights_out, lights_ready_at) = match (&host, &role_commit) {
        (Some(h), Some((_, rc))) => {
            let (out, ready_at) = lights_state(&records, h, rc)?;
            (out, Some(ready_at))
        }
        _ => (false, None),
    };
    let (comms_out, comms_ready_at) = match (&host, &role_commit) {
        (Some(h), Some((_, rc))) => {
            let (out, ready_at) = comms_state(&records, h, rc)?;
            (out, Some(ready_at))
        }
        _ => (false, None),
    };
    let (crisis, crisis_ready_at) = match (&host, &role_commit, &result) {
        (Some(h), Some((_, rc)), None) => {
            let state = crisis_state(&records, h, rc, now_ms()?)?;
            (state.active, Some(state.ready_at))
        }
        _ => (None, None),
    };
    let (doors_closed, doors_ready_at) = match (&host, &role_commit) {
        (Some(h), Some(_)) => {
            let (shut, ready_at) = doors_state(h, now_ms()?)?;
            (shut, Some(ready_at))
        }
        _ => (vec![], None),
    };

    // bodies still on the map, and the emergency button
    let marks = body_marks()?;
    let bodies: Vec<BodyView> = live_bodies(&records)
        .into_iter()
        .map(|(key, _)| BodyView {
            at: marks.get(&key).copied(),
            key,
        })
        .collect();
    let emergencies_left = (settings.emergency_meetings as usize)
        .saturating_sub(emergencies_used(&records, &my_key)) as u16;
    let emergency_ready_at = role_commit
        .as_ref()
        .and_then(|(rc_hash, _)| records.iter().find(|r| r.action_address() == rc_hash))
        .map(|r| emergency_unlocks_at(&records, r.action().timestamp()));
    let kill_ready_at = role_commit
        .as_ref()
        .and_then(|(rc_hash, _)| records.iter().find(|r| r.action_address() == rc_hash))
        .map(|r| kill_unlocks_at(&records, r.action().timestamp(), &my_key, kill_cooldown_ms(&settings)));

    let phase = if lobby.is_none() || role_commit.is_none() {
        Phase::Lobby
    } else if result.is_some() {
        Phase::Ended
    } else if active_meeting
        .as_ref()
        // a tied vote is followed straight away by its tie-breaker
        .is_some_and(|m| matches!(m.resolved, None | Some(TallyOutcome::Tie { .. })))
    {
        Phase::Meeting
    } else {
        Phase::Playing
    };

    let (player_count, impostor_count_v, task_target, code) = match &lobby {
        Some(l) => (
            l.player_count,
            l.impostor_count,
            l.task_target,
            Some(l.code.clone()),
        ),
        None => (0, 0, 0, None),
    };

    Ok(GameStateView {
        me: my_key,
        is_host,
        phase,
        code,
        player_count,
        impostor_count: impostor_count_v,
        task_target,
        players,
        roles_dealt: role_commit.is_some(),
        my_seat,
        my_role: my_seat.and_then(|s| revealed_map.get(&s).copied()),
        tasks,
        tasks_done,
        tasks_done_at_meeting,
        my_tasks_done,
        active_meeting,
        role_reveals,
        result,
        my_xp,
        settings,
        bodies,
        emergencies_left,
        emergency_ready_at,
        kill_ready_at,
        lights_out,
        lights_ready_at,
        comms_out,
        comms_ready_at,
        doors_closed,
        doors_ready_at,
        crisis,
        crisis_ready_at,
        seat_lost,
    })
}

fn short_key(k: &AgentPubKey) -> String {
    let b = k.get_raw_39();
    format!("player-{:02x}{:02x}", b[b.len() - 2], b[b.len() - 1])
}
