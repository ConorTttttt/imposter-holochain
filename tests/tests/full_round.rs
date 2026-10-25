//! Four agents on the `game` DNA play a whole round of Imposter end to end,
//! headless, with `validate` running on every entry:
//!
//!   create lobby → 3 joins → deal roles (host-as-dealer commitment)
//!   → publish tasks → 2 tasks done
//!   → impostor kills a crewmate → body reported → meeting
//!   → all living players commit + reveal a Skip vote → Ejection (no ejection)
//!   → impostor kills the last crewmate (parity)
//!   → host reveals the full role vector → check_result → GameResult
//!
//! Asserts the commit/reveal vote flow tallies correctly, the role reveal opens
//! the commitment, and the final win check returns ImpostorsWin.
//!
//! Mirrors the structure of the blackjack `one_hand.rs` sweettest.

use std::path::PathBuf;

use holochain::prelude::*;
use holochain::sweettest::*;

use imposter_core::{vote_commitment, Outcome, RoleProof, TallyOutcome, ROLE_CREW, ROLE_IMPOSTOR};

const APP_ID: &str = "imposter";
const ROLE: &str = "game";
const ZOME: &str = "game";

// --- zome I/O mirrors (field names must match the coordinator) -------------

#[derive(serde::Serialize, Debug)]
struct CreateLobby {
    code: String,
    player_count: u16,
    impostor_count: u16,
    task_target: u32,
    display_name: String,
}
#[derive(serde::Serialize, Debug)]
struct JoinLobby {
    display_name: String,
}
#[derive(serde::Serialize, Debug)]
struct TaskIn {
    id: u16,
    name: String,
    x: i32,
    y: i32,
}
#[derive(serde::Serialize, Debug)]
struct ReportBody {
    dead: AgentPubKey,
}
#[derive(serde::Serialize, Debug)]
struct CommitVote {
    meeting: ActionHash,
    commitment: [u8; 32],
}
#[derive(serde::Serialize, Debug)]
struct RevealVote {
    meeting: ActionHash,
    choice: Option<AgentPubKey>,
    salt: [u8; 32],
}

#[derive(serde::Deserialize, Debug)]
struct DealResult {
    #[allow(dead_code)]
    role_commit: ActionHash,
    seats: Vec<AgentPubKey>,
    roles: Vec<u8>,
}

#[derive(serde::Deserialize, Debug)]
struct PlayerView {
    key: AgentPubKey,
    seat: Option<u16>,
    dead: bool,
    role: Option<u8>,
    color: u8,
}
#[derive(serde::Deserialize, Debug)]
struct MeetingView {
    meeting: ActionHash,
    candidates: Option<Vec<Option<u16>>>,
    resolved: Option<TallyOutcome>,
    votes: Vec<VoteView>,
}
#[derive(serde::Deserialize, Debug)]
struct VoteView {
    voter: Option<u16>,
    choice: Option<u16>,
}
#[derive(serde::Deserialize, Debug)]
struct GameResultView {
    outcome: Outcome,
    impostors_alive: u32,
    crew_alive: u32,
    tasks_done: u32,
    tasks_total: u32,
    meltdown: Option<String>,
}
#[derive(serde::Deserialize, Debug)]
struct CrisisView {
    kind: String,
    panels: Vec<bool>,
}
#[derive(serde::Deserialize, Debug)]
struct GameStateView {
    phase: String,
    my_role: Option<u8>,
    role_reveals: Vec<(u16, u8)>,
    players: Vec<PlayerView>,
    active_meeting: Option<MeetingView>,
    result: Option<GameResultView>,
    my_xp: Option<u32>,
    settings: GameSettings,
    tasks_done: u32,
    tasks_done_at_meeting: u32,
    my_tasks_done: Vec<u16>,
    bodies: Vec<BodyView>,
    emergencies_left: u16,
    lights_out: bool,
    comms_out: bool,
    doors_closed: Vec<DoorsView>,
    crisis: Option<CrisisView>,
    seat_lost: bool,
}
#[derive(serde::Deserialize, Debug)]
struct DoorsView {
    room: u8,
    #[allow(dead_code)]
    until_ms: i64,
}
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
struct GameSettings {
    crew_vision: u16,
    impostor_vision: u16,
    kill_cooldown_s: u16,
    discussion_s: u16,
    voting_s: u16,
    task_bar: u8,
    emergency_meetings: u8,
    player_speed: u16,
    kill_distance: u8,
    confirm_ejects: bool,
    anonymous_votes: bool,
}

/// Settings that keep the tests quick: no discussion time, no voting limit, a
/// short kill cooldown.
fn test_settings() -> GameSettings {
    GameSettings {
        crew_vision: 170,
        impostor_vision: 250,
        kill_cooldown_s: 10,
        discussion_s: 0,
        voting_s: 0,
        task_bar: 0,
        emergency_meetings: 1,
        player_speed: 100,
        kill_distance: 1,
        confirm_ejects: true,
        anonymous_votes: false,
    }
}
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq)]
struct BodyAt {
    x: i32,
    y: i32,
}
#[derive(serde::Deserialize, Debug)]
struct BodyView {
    key: AgentPubKey,
    at: Option<BodyAt>,
}

// --- harness -------------------------------------------------------------

async fn load_dna() -> DnaFile {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dnas/game/workdir/game.dna");
    SweetDnaFile::from_bundle(&path).await.unwrap()
}

/// The game DNA with a tampered coordinator that can write raw links
/// (`scripts/build-forge-dna.sh`). Same integrity zome, so the same network.
async fn load_forge_dna() -> DnaFile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("forge/game.dna");
    SweetDnaFile::from_bundle(&path).await.unwrap()
}

struct Lobby {
    conductors: SweetConductorBatch,
    cells: Vec<SweetCell>,
    /// The game's network seed, owned by agent 0: the host in every test.
    seed: String,
}

/// 128 bits from the process's random hash keys, as 32 hex digits — enough
/// for a test's game id, with no extra dependency.
fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let half = || std::collections::hash_map::RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", half(), half())
}

/// A game seed `host` owns: `g1.<host key>.<random id>`, as the UI makes them.
fn game_seed(host: &AgentPubKey) -> String {
    format!("g1.{}.{}", AgentPubKeyB64::from(host.clone()), random_id())
}

impl Lobby {
    async fn setup(n: usize) -> Self {
        Self::setup_inner(n, false).await
    }

    /// Like `setup`, but the last agent runs the tampered (`forge`) coordinator.
    async fn setup_with_forger(n: usize) -> Self {
        Self::setup_inner(n, true).await
    }

    async fn setup_inner(n: usize, forger: bool) -> Self {
        let dna = load_dna().await;
        let mut conductors = SweetConductorBatch::standard(n).await;
        let host = if forger {
            let forge = load_forge_dna().await;
            assert_eq!(forge.dna_hash(), dna.dna_hash(), "the forge build must be on the game's network");
            let mut agents = Vec::new();
            for i in 0..n {
                let d = if i == n - 1 { forge.clone() } else { dna.clone() };
                let app = conductors[i].setup_app(APP_ID, [&(ROLE.to_string(), d)]).await.unwrap();
                agents.push(app.agent().clone());
            }
            agents[0].clone()
        } else {
            let role = (ROLE.to_string(), dna);
            let apps = conductors.setup_app(APP_ID, [&role]).await.unwrap();
            apps.into_inner()[0].agent().clone()
        };
        let seed = game_seed(&host);

        let mut cells = Vec::new();
        for i in 0..n {
            let cc = conductors[i]
                .create_clone_cell(
                    &APP_ID.to_string(),
                    CreateCloneCellPayload {
                        role_name: ROLE.into(),
                        modifiers: DnaModifiersOpt::none().with_network_seed(seed.clone()),
                        membrane_proof: None,
                        name: Some(seed.clone()),
                    },
                )
                .await
                .unwrap();
            cells.push(conductors[i].get_sweet_cell(cc.cell_id.clone()).unwrap());
        }
        conductors.exchange_peer_info().await;
        Lobby { conductors, cells, seed }
    }

    async fn sync(&self) {
        let refs: Vec<&SweetCell> = self.cells.iter().collect();
        await_consistency_s(60, refs).await.unwrap();
    }

    async fn call<I, O>(&self, i: usize, fn_name: &str, payload: I) -> O
    where
        I: serde::Serialize + std::fmt::Debug,
        O: serde::de::DeserializeOwned + std::fmt::Debug,
    {
        let z = self.cells[i].zome(ZOME);
        self.conductors[i].call(&z, fn_name, payload).await
    }

    async fn state(&self, i: usize) -> GameStateView {
        self.call(i, "get_game_state", ()).await
    }

    fn index_of(&self, key: &AgentPubKey) -> usize {
        self.cells
            .iter()
            .position(|c| c.agent_pubkey() == key)
            .expect("key belongs to a conductor")
    }
}

fn salt(byte: u8) -> [u8; 32] {
    [byte; 32]
}

/// A relay address one player shares reaches the others, and a newer one
/// (a restarted relay) replaces it. It never shows up as a game entry.
#[tokio::test(flavor = "multi_thread")]
async fn relay_address_is_shared() {
    let lobby = Lobby::setup(2).await;
    let none: Option<String> = lobby.call(1, "get_relay", ()).await;
    assert_eq!(none, None);

    let first = "/ip4/127.0.0.1/udp/40001/webrtc-direct/p2p/first".to_string();
    let _: () = lobby.call(0, "share_relay", first.clone()).await;
    lobby.sync().await;
    let seen: Option<String> = lobby.call(1, "get_relay", ()).await;
    assert_eq!(seen.as_deref(), Some(first.as_str()));

    let second = "/ip4/127.0.0.1/udp/40002/webrtc-direct/p2p/second".to_string();
    let _: () = lobby.call(1, "share_relay", second.clone()).await;
    lobby.sync().await;
    let seen: Option<String> = lobby.call(0, "get_relay", ()).await;
    assert_eq!(seen.as_deref(), Some(second.as_str()));

    let z = lobby.cells[0].zome(ZOME);
    let empty: Result<(), _> = lobby.conductors[0]
        .call_fallible(&z, "share_relay", "  ".to_string())
        .await;
    assert!(empty.is_err(), "an empty relay address was accepted");

    // Relay links hang off their own anchor, so the game itself is untouched.
    let _: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    // Joiners look the lobby up over the network, so let it reach them first.
    lobby.sync().await;
    lobby.sync().await;
    let state = lobby.state(1).await;
    assert_eq!(state.phase, "lobby");
    assert_eq!(state.players.len(), 1);
}

/// The host's settings reach every player through `get_game_state`, and nobody
/// else can change them. Players get colors by join order, host first.
#[tokio::test(flavor = "multi_thread")]
async fn host_sets_settings() {
    let lobby = Lobby::setup(2).await;
    let _: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    // Joiners look the lobby up over the network, so let it reach them first.
    lobby.sync().await;
    let _: Record = lobby
        .call(
            1,
            "join_lobby",
            JoinLobby {
                display_name: "Bob".into(),
            },
        )
        .await;
    lobby.sync().await;
    let bob = lobby.state(1).await;
    assert_eq!(
        bob.settings,
        GameSettings {
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
        },
        "the defaults, before the host picks anything"
    );
    let host_key = lobby.cells[0].agent_pubkey().clone();
    let color_of = |key: &AgentPubKey| bob.players.iter().find(|p| &p.key == key).unwrap().color;
    assert_eq!(color_of(&host_key), 0, "the host joined first");
    assert_eq!(color_of(lobby.cells[1].agent_pubkey()), 1);

    let custom = GameSettings {
        crew_vision: 110,
        impostor_vision: 0,
        kill_cooldown_s: 35,
        discussion_s: 30,
        voting_s: 0,
        task_bar: 2,
        emergency_meetings: 3,
        player_speed: 150,
        kill_distance: 2,
        confirm_ejects: false,
        anonymous_votes: true,
    };
    let _: () = lobby.call(0, "set_settings", custom.clone()).await;
    lobby.sync().await;
    assert_eq!(lobby.state(1).await.settings, custom);

    let z = lobby.cells[1].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[1]
        .call_fallible(&z, "set_settings", test_settings())
        .await;
    assert!(res.is_err(), "a non-host changed the settings");
    lobby.sync().await;
    assert_eq!(lobby.state(0).await.settings, custom);
}

/// Each player gets a secret task list from the host — the same list every time
/// they ask — and completions count per player: a task done again is refused.
#[tokio::test(flavor = "multi_thread")]
async fn tasks_are_per_player() {
    let lobby = Lobby::setup(4).await;
    let _ = seat_four_and_deal(&lobby).await;
    let tasks: Vec<TaskIn> = (0..4u16)
        .map(|id| TaskIn {
            id,
            name: format!("task {id}"),
            x: 0,
            y: 0,
        })
        .collect();
    let _: Record = lobby.call(0, "publish_tasks", tasks).await;
    lobby.sync().await;

    // 4 players with 1 impostor and a target of 4: ceil(4 / 3) = 2 tasks each
    let mut lists: Vec<Vec<u16>> = Vec::new();
    for i in 0..4 {
        let list: Vec<u16> = lobby.call(i, "my_tasks", ()).await;
        assert_eq!(list.len(), 2, "player {i}'s list: {list:?}");
        assert!(list.iter().all(|id| *id < 4), "player {i}'s list: {list:?}");
        let again: Vec<u16> = lobby.call(i, "my_tasks", ()).await;
        assert_eq!(list, again, "player {i}'s list changed");
        lists.push(list);
    }

    let _: Record = lobby.call(1, "complete_task", lists[1][0]).await;
    let _: Record = lobby.call(2, "complete_task", lists[2][0]).await;
    lobby.sync().await;
    let err = call_err(&lobby, 1, "complete_task", lists[1][0]).await;
    assert!(err.contains("already done"), "a task was done twice: {err}");
    let st = lobby.state(1).await;
    assert_eq!(st.tasks_done, 2, "each player's completion counts");
    assert_eq!(st.my_tasks_done, vec![lists[1][0]]);
}

/// Calls `kill`, which must be refused, and returns the error as text.
async fn kill_err(lobby: &Lobby, i: usize, target: AgentPubKey) -> String {
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[i].call_fallible(&z, "kill", target).await;
    format!("{:?}", res.expect_err("kill should have been refused"))
}

/// The live kill path, which `impostor_wins_on_parity` bypasses with
/// `report_own_death`: the impostor calls `kill`, and the victim's
/// `recv_remote_signal` checks the kill rules and commits the `KillReport`.
/// Only the impostor can kill, and only once its cooldown has run out.
#[tokio::test(flavor = "multi_thread")]
async fn kill_is_recorded_via_remote_signal() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crew: Vec<usize> = (0..4).filter(|&i| i != impostor).collect();
    let victim = lobby.cells[crew[0]].agent_pubkey().clone();

    let err = kill_err(&lobby, crew[1], victim.clone()).await;
    assert!(err.contains("only an impostor"), "a crewmate killed: {err}");
    let err = kill_err(&lobby, impostor, victim.clone()).await;
    assert!(err.contains("cooldown"), "killed straight after the deal: {err}");

    // wait out the kill cooldown from `test_settings` (10 s)
    tokio::time::sleep(std::time::Duration::from_millis(11_000)).await;
    let _: () = lobby.call(impostor, "kill", victim.clone()).await;

    let mut dead = false;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if lobby
            .state(crew[0])
            .await
            .players
            .iter()
            .any(|p| p.key == victim && p.dead)
        {
            dead = true;
            break;
        }
    }
    assert!(dead, "victim's KillReport never appeared after `kill`");

    lobby.sync().await;
    let err = kill_err(&lobby, impostor, lobby.cells[crew[1]].agent_pubkey().clone()).await;
    assert!(err.contains("cooldown"), "killed again straight away: {err}");
}

/// Mirror of the coordinator's `GameSignal::Killed`, encoded the way the HDK's
/// `send_remote_signal` encodes it.
#[derive(serde::Serialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum GameSignalOut {
    Killed {
        killer: AgentPubKey,
        at_ms: i64,
        seat: u16,
        proof: RoleProof,
    },
}

/// Calls the victim's `recv_remote_signal` directly, so its error comes back
/// instead of being dropped by fire-and-forget delivery: a `Killed` signal
/// decodes, but a crewmate posing as the killer with a forged role proof is
/// rejected, and nobody dies.
#[tokio::test(flavor = "multi_thread")]
async fn recv_remote_signal_rejects_a_forged_kill() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_seat = deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap();
    let posing_seat = (0..4).find(|&s| s != impostor_seat).unwrap();
    let victim_seat = (0..4).find(|&s| s != impostor_seat && s != posing_seat).unwrap();
    let victim = deal.seats[victim_seat].clone();
    let vi = lobby.index_of(&victim);

    let forged = GameSignalOut::Killed {
        killer: deal.seats[posing_seat].clone(),
        at_ms: 1,
        seat: posing_seat as u16,
        proof: RoleProof {
            role_salt: [0; 16],
            path: vec![[0; 32]; 6],
        },
    };
    let z = lobby.cells[vi].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[vi]
        .call_fallible(&z, "recv_remote_signal", forged)
        .await;
    let err = format!("{:?}", res.expect_err("a forged kill was accepted"));
    assert!(
        err.contains("only an impostor"),
        "rejected, but not by the proof check (did the signal decode?): {err}"
    );
    assert!(
        !lobby.state(vi).await.players.iter().any(|p| p.key == victim && p.dead),
        "the victim died from a forged kill"
    );
}

/// Players can tell when the host has gone: `host_online` is true while the
/// host's conductor runs, and not once it has shut down.
#[tokio::test(flavor = "multi_thread")]
async fn host_online_tracks_the_host() {
    let mut lobby = Lobby::setup(2).await;
    let _: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    // Joiners look the lobby up over the network, so let it reach them first.
    lobby.sync().await;
    let _: Record = lobby
        .call(
            1,
            "join_lobby",
            JoinLobby {
                display_name: "Bob".into(),
            },
        )
        .await;
    lobby.sync().await;
    let online: bool = lobby.call(1, "host_online", ()).await;
    assert!(online, "the host is running");

    lobby.conductors[0].shutdown().await;
    let z = lobby.cells[1].zome(ZOME);
    let res: Result<bool, _> = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        lobby.conductors[1].call_fallible(&z, "host_online", ()),
    )
    .await
    .expect("host_online hung after the host shut down");
    assert!(!matches!(res, Ok(true)), "the host still looks online: {res:?}");
    lobby.conductors[0].startup().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn impostor_wins_on_parity() {
    let lobby = Lobby::setup(4).await;

    // --- lobby ---------------------------------------------------------
    let _: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    // Joiners look the lobby up over the network, so let it reach them first.
    lobby.sync().await;
    for (i, name) in [(1, "Bob"), (2, "Cara"), (3, "Dan")] {
        let _: Record = lobby
            .call(
                i,
                "join_lobby",
                JoinLobby {
                    display_name: name.into(),
                },
            )
            .await;
    }
    lobby.sync().await;

    let _: () = lobby.call(0, "set_settings", test_settings()).await;
    lobby.sync().await;

    // --- deal roles (host learns the vector; others get only their leaf) ---
    let deal: DealResult = lobby.call(0, "deal_roles", ()).await;
    lobby.sync().await;
    assert_eq!(deal.roles.len(), 4);
    assert_eq!(
        deal.roles.iter().filter(|&&r| r == ROLE_IMPOSTOR).count(),
        1,
        "exactly one impostor"
    );

    let impostor_seat = deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap();
    let impostor_key = deal.seats[impostor_seat].clone();
    let impostor_idx = lobby.index_of(&impostor_key);
    let crew_idxs: Vec<usize> = (0..4).filter(|&i| i != impostor_idx).collect();

    // --- tasks -------------------------------------------------------------
    let tasks: Vec<TaskIn> = (0..4)
        .map(|id| TaskIn {
            id,
            name: format!("task {id}"),
            x: (id as i32) * 40,
            y: 0,
        })
        .collect();
    let _: Record = lobby.call(0, "publish_tasks", tasks).await;
    lobby.sync().await;

    // two crewmates each finish one of their own tasks (tasks_done = 2 of 4)
    for &i in &crew_idxs[..2] {
        let mine: Vec<u16> = lobby.call(i, "my_tasks", ()).await;
        let _: Record = lobby.call(i, "complete_task", mine[0]).await;
    }
    // a modified impostor client records a fake task; the result won't count it
    let cover: Vec<u16> = lobby.call(impostor_idx, "my_tasks", ()).await;
    let _: Record = lobby.call(impostor_idx, "complete_task", cover[0]).await;
    lobby.sync().await;

    // --- first kill ------------------------------------------------------
    let victim_a = lobby.cells[crew_idxs[0]].agent_pubkey().clone();
    let _: Record = lobby
        .call(crew_idxs[0], "report_own_death", impostor_key.clone())
        .await;
    lobby.sync().await;

    // --- meeting: body report -----------------------------------------------
    let _: Record = lobby
        .call(
            crew_idxs[1],
            "report_body",
            ReportBody {
                dead: victim_a.clone(),
            },
        )
        .await;
    lobby.sync().await;

    let st = lobby.state(0).await;
    assert_eq!(st.phase, "meeting");
    assert_eq!(st.my_xp, None, "no XP before the game has ended");
    assert_eq!(
        st.tasks_done_at_meeting, 3,
        "the task bar as of the meeting: two real tasks plus the impostor's recorded fake"
    );
    let meeting = st.active_meeting.expect("a meeting is open").meeting;

    // living voters: host (0), impostor, the surviving crewmate — all vote Skip
    let living: Vec<usize> = (0..4).filter(|&i| i != crew_idxs[0]).collect();
    for &i in &living {
        let s = salt(i as u8 + 1);
        let commitment = vote_commitment(None, &s);
        let _: Record = lobby
            .call(
                i,
                "commit_vote",
                CommitVote {
                    meeting: meeting.clone(),
                    commitment,
                },
            )
            .await;
    }
    lobby.sync().await;
    for &i in &living {
        let s = salt(i as u8 + 1);
        let _: Record = lobby
            .call(
                i,
                "reveal_vote",
                RevealVote {
                    meeting: meeting.clone(),
                    choice: None,
                    salt: s,
                },
            )
            .await;
    }
    lobby.sync().await;

    // --- resolve: nobody ejected -----------------------------------------
    let _: Record = lobby.call(0, "resolve_meeting", meeting.clone()).await;
    lobby.sync().await;

    let st = lobby.state(0).await;
    let resolved = st
        .active_meeting
        .and_then(|m| m.resolved)
        .expect("meeting resolved");
    assert_eq!(
        resolved,
        TallyOutcome::NoEjection,
        "a unanimous Skip ejects nobody"
    );
    assert_eq!(lobby.state(0).await.phase, "playing", "back to the game");

    // --- second kill: parity -------------------------------------------
    let _: Record = lobby
        .call(crew_idxs[1], "report_own_death", impostor_key.clone())
        .await;
    lobby.sync().await;

    // --- reveal + result ------------------------------------------------
    let _: Record = lobby.call(0, "reveal_all", ()).await;
    lobby.sync().await;
    let _: Option<Record> = lobby.call(0, "check_result", ()).await;
    lobby.sync().await;

    let st = lobby.state(0).await;
    let result = st.result.expect("a GameResult was published");
    assert_eq!(result.outcome, Outcome::ImpostorsWin);
    assert_eq!(result.impostors_alive, 1);
    assert_eq!(result.crew_alive, 1);
    assert_eq!(result.tasks_done, 2);
    assert_eq!(result.tasks_total, 4);

    // every seat's role is now public and matches what was dealt
    assert_eq!(st.role_reveals.len(), 4);
    let mut revealed = st.role_reveals.clone();
    revealed.sort_by_key(|(s, _)| *s);
    let revealed_vec: Vec<u8> = revealed.iter().map(|(_, r)| *r).collect();
    assert_eq!(revealed_vec, deal.roles, "reveal matches the dealt vector");

    // a crewmate's client can now see its own (revealed) role
    let crew_state = lobby.state(crew_idxs[0]).await;
    assert_eq!(crew_state.my_role, Some(0), "crewmate sees role 0 after reveal");

    // sanity: the impostor really was seated where we think
    let impostor_pv = st
        .players
        .iter()
        .find(|p| p.key == impostor_key)
        .expect("impostor in player list");
    assert_eq!(impostor_pv.seat, Some(impostor_seat as u16));
    assert_eq!(impostor_pv.role, Some(ROLE_IMPOSTOR));
    assert!(impostor_pv.dead == false, "impostor survived to parity");

    // --- XP: tasks + survival + the win, per player -----------------------
    // crew_idxs[2] survived but did none of its own tasks, and lost (crew lost)
    assert_eq!(
        lobby.state(crew_idxs[2]).await.my_xp,
        Some(10),
        "surviving crewmate: 0 tasks + survived (10) + lost (0)"
    );
    // the impostor survived, did no *real* tasks (its cover doesn't count), and won
    assert_eq!(
        lobby.state(impostor_idx).await.my_xp,
        Some(35),
        "impostor: 0 real tasks + survived (10) + won (25)"
    );
    // crew_idxs[0] did one real task, then died, and lost
    assert_eq!(
        lobby.state(crew_idxs[0]).await.my_xp,
        Some(5),
        "dead crewmate: 1 task (5) + died (0) + lost (0)"
    );
}

/// Host creates a 4-player lobby, the other three join, and the host deals,
/// with the quick test settings.
async fn seat_four_and_deal(lobby: &Lobby) -> DealResult {
    seat_four_and_deal_with(lobby, test_settings()).await
}

/// Host creates a 4-player lobby, the other three join, the host applies
/// `settings` and deals.
async fn seat_four_and_deal_with(lobby: &Lobby, settings: GameSettings) -> DealResult {
    let _: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    // Joiners look the lobby up over the network, so let it reach them first.
    lobby.sync().await;
    for (i, name) in [(1, "Bob"), (2, "Cara"), (3, "Dan")] {
        let _: Record = lobby
            .call(
                i,
                "join_lobby",
                JoinLobby {
                    display_name: name.into(),
                },
            )
            .await;
    }
    lobby.sync().await;
    let _: () = lobby.call(0, "set_settings", settings).await;
    lobby.sync().await;
    let deal: DealResult = lobby.call(0, "deal_roles", ()).await;
    lobby.sync().await;
    deal
}

/// Each `(player index, choice)` commits, then each reveals.
async fn vote(lobby: &Lobby, meeting: &ActionHash, ballots: &[(usize, Option<AgentPubKey>)]) {
    for (i, choice) in ballots {
        let commitment = vote_commitment(choice.as_ref().map(|k| k.get_raw_39()), &salt(*i as u8 + 1));
        let _: Record = lobby
            .call(
                *i,
                "commit_vote",
                CommitVote {
                    meeting: meeting.clone(),
                    commitment,
                },
            )
            .await;
    }
    lobby.sync().await;
    for (i, choice) in ballots {
        let _: Record = lobby
            .call(
                *i,
                "reveal_vote",
                RevealVote {
                    meeting: meeting.clone(),
                    choice: choice.clone(),
                    salt: salt(*i as u8 + 1),
                },
            )
            .await;
    }
    lobby.sync().await;
}

/// Calls a zome function that must fail, and returns its error as text.
async fn call_err<I>(lobby: &Lobby, i: usize, fn_name: &str, payload: I) -> String
where
    I: serde::Serialize + std::fmt::Debug,
{
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<Record, _> = lobby.conductors[i].call_fallible(&z, fn_name, payload).await;
    format!("{:?}", res.expect_err(&format!("{fn_name} should have failed")))
}

/// Meetings follow the table rules: the emergency button has a cooldown and one
/// use per player, ghosts can't call meetings, a body lies where its victim
/// marked it (the first mark stands) until a meeting clears it, so it can be
/// reported only once.
#[tokio::test(flavor = "multi_thread")]
async fn meeting_rules() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let crew: Vec<usize> = (0..4)
        .filter(|&i| lobby.cells[i].agent_pubkey() != &impostor)
        .collect();
    // the host (0) tallies, so keep it alive
    let victim = *crew.iter().find(|&&i| i != 0).unwrap();
    let reporter = *crew.iter().find(|&&i| i != victim).unwrap();
    let bystander = (0..4).find(|&i| i != victim && i != reporter).unwrap();
    let victim_key = lobby.cells[victim].agent_pubkey().clone();
    let living: Vec<(usize, Option<AgentPubKey>)> =
        (0..4).filter(|&i| i != victim).map(|i| (i, None)).collect();

    let err = call_err(&lobby, reporter, "press_emergency", ()).await;
    assert!(err.contains("unlocks in"), "button locked right after the deal: {err}");

    // a kill: the victim marks the spot, and a second mark doesn't move the body
    let _: Record = lobby.call(victim, "report_own_death", impostor.clone()).await;
    let _: () = lobby.call(victim, "mark_body", BodyAt { x: 100, y: 200 }).await;
    let _: () = lobby.call(victim, "mark_body", BodyAt { x: 1, y: 1 }).await;
    lobby.sync().await;
    let bodies = lobby.state(bystander).await.bodies;
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0].key, victim_key);
    assert_eq!(bodies[0].at, Some(BodyAt { x: 100, y: 200 }));

    let err = call_err(&lobby, victim, "report_body", ReportBody { dead: victim_key.clone() }).await;
    assert!(err.contains("ghosts"), "a ghost reported: {err}");

    // reported once; the meeting clears the body
    let _: Record = lobby
        .call(reporter, "report_body", ReportBody { dead: victim_key.clone() })
        .await;
    lobby.sync().await;
    let meeting = lobby.state(0).await.active_meeting.expect("a meeting is open").meeting;
    vote(&lobby, &meeting, &living).await;
    let _: Record = lobby.call(0, "resolve_meeting", meeting).await;
    lobby.sync().await;
    assert!(lobby.state(bystander).await.bodies.is_empty(), "the meeting cleared the body");
    let err = call_err(&lobby, bystander, "report_body", ReportBody { dead: victim_key.clone() }).await;
    assert!(err.contains("no body"), "a cleared body was reported: {err}");

    // after the cooldown: an emergency, none while it runs, one per player
    tokio::time::sleep(std::time::Duration::from_millis(16_000)).await;
    let _: Record = lobby.call(reporter, "press_emergency", ()).await;
    lobby.sync().await;
    let err = call_err(&lobby, bystander, "press_emergency", ()).await;
    assert!(err.contains("already running"), "a second meeting opened: {err}");
    let meeting = lobby
        .state(0)
        .await
        .active_meeting
        .expect("the emergency meeting is open")
        .meeting;
    vote(&lobby, &meeting, &living).await;
    let _: Record = lobby.call(0, "resolve_meeting", meeting).await;
    lobby.sync().await;
    let err = call_err(&lobby, reporter, "press_emergency", ()).await;
    assert!(err.contains("used your emergency"), "a second emergency: {err}");
    assert_eq!(lobby.state(reporter).await.emergencies_left, 0);
    assert_eq!(lobby.state(bystander).await.emergencies_left, 1);
}

/// The host's settings can't change once roles are dealt.
#[tokio::test(flavor = "multi_thread")]
async fn settings_lock_once_roles_are_dealt() {
    let lobby = Lobby::setup(4).await;
    let _ = seat_four_and_deal(&lobby).await;
    let z = lobby.cells[0].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[0]
        .call_fallible(
            &z,
            "set_settings",
            GameSettings {
                discussion_s: 90,
                ..test_settings()
            },
        )
        .await;
    let err = format!("{:?}", res.expect_err("the host changed the settings mid-game"));
    assert!(err.contains("fixed once the game has started"), "{err}");
    assert_eq!(lobby.state(1).await.settings, test_settings());
}

/// Calls a zome function taking and returning `()`, which must fail; returns
/// its error as text.
async fn unit_err(lobby: &Lobby, i: usize, fn_name: &str) -> String {
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[i].call_fallible(&z, fn_name, ()).await;
    format!("{:?}", res.expect_err(&format!("{fn_name} should have failed")))
}

/// An impostor cuts the lights (the host writes the cut); crewmates can't. A
/// living player fixes them, and then there's a cooldown before the next cut.
#[tokio::test(flavor = "multi_thread")]
async fn lights_sabotage() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crew: Vec<usize> = (0..4).filter(|&i| i != impostor).collect();

    let err = unit_err(&lobby, crew[0], "cut_lights").await;
    assert!(err.contains("only an impostor"), "a crewmate cut the lights: {err}");
    let err = unit_err(&lobby, crew[1], "fix_lights").await;
    assert!(err.contains("aren't out"), "fixed lights that were on: {err}");

    let _: () = lobby.call(impostor, "cut_lights", ()).await;
    lobby.sync().await;
    assert!(lobby.state(crew[1]).await.lights_out, "the lights didn't go out for the crew");
    let err = unit_err(&lobby, impostor, "cut_lights").await;
    assert!(err.contains("already out"), "cut lights that were out: {err}");

    let _: () = lobby.call(crew[1], "fix_lights", ()).await;
    lobby.sync().await;
    assert!(!lobby.state(impostor).await.lights_out, "the fix didn't take");
    let err = unit_err(&lobby, impostor, "cut_lights").await;
    assert!(err.contains("cooldown"), "cut again straight after a fix: {err}");
}

/// An impostor cuts comms (the host writes the cut), the same shape as the
/// lights: crewmates can't, a living player fixes it, and then there's a
/// cooldown before the next cut.
#[tokio::test(flavor = "multi_thread")]
async fn comms_sabotage() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crew: Vec<usize> = (0..4).filter(|&i| i != impostor).collect();

    let err = unit_err(&lobby, crew[0], "cut_comms").await;
    assert!(err.contains("only an impostor"), "a crewmate cut comms: {err}");
    let err = unit_err(&lobby, crew[1], "fix_comms").await;
    assert!(err.contains("aren't down"), "fixed comms that were up: {err}");

    let _: () = lobby.call(impostor, "cut_comms", ()).await;
    lobby.sync().await;
    assert!(lobby.state(crew[1]).await.comms_out, "comms didn't go down for the crew");
    let err = unit_err(&lobby, impostor, "cut_comms").await;
    assert!(err.contains("already down"), "cut comms that were already down: {err}");

    let _: () = lobby.call(crew[1], "fix_comms", ()).await;
    lobby.sync().await;
    assert!(!lobby.state(impostor).await.comms_out, "the fix didn't take");
    let err = unit_err(&lobby, impostor, "cut_comms").await;
    assert!(err.contains("cooldown"), "cut again straight after a fix: {err}");
}

/// The medbay scan: a crewmate's is public, unforgeable proof of crew (and
/// still counts as a task, like any other); an impostor's would only reveal
/// them for nothing, since it never counts toward the crew's tasks.
#[tokio::test(flavor = "multi_thread")]
async fn medbay_scan_proves_crew() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_seat = deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap();
    let impostor = lobby.index_of(&deal.seats[impostor_seat]);
    let crewmate = (0..4).find(|&i| i != impostor).unwrap();
    let crewmate_seat = deal.seats.iter().position(|k| k == lobby.cells[crewmate].agent_pubkey()).unwrap() as u16;

    let tasks: Vec<TaskIn> = (0..1u16)
        .map(|id| TaskIn {
            id,
            name: "Medbay Scan".into(),
            x: 0,
            y: 0,
        })
        .collect();
    let _: Record = lobby.call(0, "publish_tasks", tasks).await;
    lobby.sync().await;

    // a crewmate's scan: proves crew, and counts like any task
    let _: () = lobby.call(crewmate, "scan_role", 0u16).await;
    lobby.sync().await;
    let st = lobby.state(0).await;
    assert!(
        st.role_reveals.contains(&(crewmate_seat, ROLE_CREW)),
        "the crewmate's scan didn't reveal them as crew: {:?}",
        st.role_reveals
    );
    assert_eq!(st.tasks_done, 1, "the scan didn't count as a completed task");
    let err = unit_err(&lobby, crewmate, "cut_lights").await; // sanity: still just a crewmate
    assert!(err.contains("only an impostor"), "{err}");

    // an impostor's real scan would out them too, for nothing
    let _: () = lobby.conductors[impostor]
        .call_fallible::<_, ()>(&lobby.cells[impostor].zome(ZOME), "scan_role", 0u16)
        .await
        .unwrap();
    lobby.sync().await;
    let st = lobby.state(0).await;
    assert!(
        st.role_reveals.contains(&(impostor_seat as u16, ROLE_IMPOSTOR)),
        "the impostor's own scan should reveal them too: {:?}",
        st.role_reveals
    );

    // scanning twice doesn't double up the reveal or the task completion
    let res: Result<(), _> = lobby.conductors[crewmate]
        .call_fallible(&lobby.cells[crewmate].zome(ZOME), "scan_role", 0u16)
        .await;
    let err = format!("{:?}", res.expect_err("a repeat scan should have failed"));
    assert!(err.contains("already done"), "repeat scan: {err}");
}

/// An impostor shuts a room's doors (the host writes it); crewmates can't, and
/// there's a cooldown before the next doors.
#[tokio::test(flavor = "multi_thread")]
async fn doors_sabotage() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crew: Vec<usize> = (0..4).filter(|&i| i != impostor).collect();

    let z = lobby.cells[crew[0]].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[crew[0]].call_fallible(&z, "close_doors", 2u8).await;
    let err = format!("{:?}", res.expect_err("a crewmate shut doors"));
    assert!(err.contains("only an impostor"), "a crewmate shut doors: {err}");

    let _: () = lobby.call(impostor, "close_doors", 2u8).await;
    lobby.sync().await;
    let shut: Vec<u8> = lobby.state(crew[1]).await.doors_closed.iter().map(|d| d.room).collect();
    assert_eq!(shut, vec![2], "the doors didn't shut for the crew");

    let z = lobby.cells[impostor].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[impostor].call_fallible(&z, "close_doors", 3u8).await;
    let err = format!("{:?}", res.expect_err("shut doors again straight away"));
    assert!(err.contains("cooldown"), "shut doors again straight away: {err}");
}

async fn start_crisis(lobby: &Lobby, i: usize, kind: &str) -> Result<(), String> {
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[i].call_fallible(&z, "start_crisis", kind.to_string()).await;
    res.map_err(|e| format!("{e:?}"))
}

async fn fix_crisis(lobby: &Lobby, i: usize, panel: u8) -> Result<(), String> {
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<(), _> = lobby.conductors[i].call_fallible(&z, "fix_crisis", panel).await;
    res.map_err(|e| format!("{e:?}"))
}

/// A crisis sabotage: only an impostor starts one (the host writes it), one at
/// a time, and it blocks the emergency button. The reactor needs two different
/// players holding its two consoles at once; one player holding one isn't enough.
#[tokio::test(flavor = "multi_thread")]
async fn reactor_crisis_needs_two() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crew: Vec<usize> = (0..4).filter(|&i| i != impostor).collect();
    let err = start_crisis(&lobby, crew[0], "reactor").await.unwrap_err();
    assert!(err.contains("only an impostor"), "a crewmate started a crisis: {err}");
    let err = fix_crisis(&lobby, crew[0], 0).await.unwrap_err();
    assert!(err.contains("no crisis"), "fixed a crisis that wasn't there: {err}");

    start_crisis(&lobby, impostor, "reactor").await.unwrap();
    lobby.sync().await;
    let c = lobby.state(crew[1]).await.crisis.expect("no crisis for the crew");
    assert_eq!((c.kind.as_str(), c.panels.len()), ("reactor", 2));
    let err = start_crisis(&lobby, impostor, "nav_drift").await.unwrap_err();
    assert!(err.contains("already under way"), "two crises at once: {err}");
    let z = lobby.cells[crew[0]].zome(ZOME);
    let res: Result<Record, _> = lobby.conductors[crew[0]].call_fallible(&z, "press_emergency", ()).await;
    let err = format!("{:?}", res.expect_err("an emergency meeting during a crisis"));
    assert!(err.contains("during a crisis"), "{err}");

    // one player can't hold both consoles
    fix_crisis(&lobby, crew[0], 0).await.unwrap();
    fix_crisis(&lobby, crew[0], 1).await.unwrap();
    lobby.sync().await;
    assert!(lobby.state(crew[1]).await.crisis.is_some(), "one player stabilised the reactor alone");

    // two players at once — after the lone holds above have gone stale, so
    // they can't pair up with these
    tokio::time::sleep(std::time::Duration::from_millis(2_500)).await;
    fix_crisis(&lobby, crew[1], 0).await.unwrap();
    fix_crisis(&lobby, crew[2], 1).await.unwrap();
    lobby.sync().await;
    assert!(lobby.state(impostor).await.crisis.is_none(), "two players holding didn't stabilise it");
    let err = start_crisis(&lobby, impostor, "life_support").await.unwrap_err();
    assert!(err.contains("cooldown"), "a new crisis straight after the last: {err}");
}

/// A crisis nobody finishes in time ends the game: the impostors win, and the
/// result says which crisis it was. (Waits out Life Support's 45 s.)
#[tokio::test(flavor = "multi_thread")]
async fn unstabilised_crisis_is_an_impostor_win() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crewmate = (0..4).find(|&i| i != impostor).unwrap();

    let _: () = lobby.call(impostor, "start_crisis", "life_support".to_string()).await;
    lobby.sync().await;
    // only one of the two terminals
    let _: () = lobby.call(crewmate, "fix_crisis", 0u8).await;
    lobby.sync().await;
    let c = lobby.state(0).await.crisis.expect("no crisis");
    assert_eq!(c.panels, vec![true, false]);
    let none: Option<GameResultView> = lobby.call(0, "try_finish", ()).await;
    assert!(none.is_none(), "the game ended before the crisis ran out");

    tokio::time::sleep(std::time::Duration::from_millis(46_000)).await;
    let res: Option<GameResultView> = lobby.call(0, "try_finish", ()).await;
    let res = res.expect("the crisis ran out, but the game went on");
    assert!(matches!(res.outcome, Outcome::ImpostorsWin), "{res:?}");
    assert_eq!(res.meltdown.as_deref(), Some("life_support"));
    lobby.sync().await;
    let st = lobby.state(crewmate).await;
    assert_eq!(st.phase, "ended");
    assert_eq!(st.result.and_then(|r| r.meltdown).as_deref(), Some("life_support"));
}

// --- seat cap ----------------------------------------------------------------

async fn create_lobby_for(lobby: &Lobby, players: u16) {
    let _: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: players,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    lobby.sync().await;
}

async fn try_join(lobby: &Lobby, i: usize) -> Result<Record, String> {
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<Record, _> = lobby.conductors[i]
        .call_fallible(&z, "join_lobby", JoinLobby { display_name: format!("P{i}") })
        .await;
    res.map_err(|e| format!("{e:?}"))
}

fn player_keys(st: &GameStateView) -> Vec<AgentPubKey> {
    let mut keys: Vec<AgentPubKey> = st.players.iter().map(|p| p.key.clone()).collect();
    keys.sort();
    keys
}

/// The zome, not the UI, refuses a join once every seat is taken. Joining
/// again keeps the seat already held, and the deal seats exactly the cap.
#[tokio::test(flavor = "multi_thread")]
async fn join_refused_when_full() {
    let lobby = Lobby::setup(4).await;
    create_lobby_for(&lobby, 3).await;
    try_join(&lobby, 1).await.expect("first join");
    lobby.sync().await;
    try_join(&lobby, 2).await.expect("second join");
    lobby.sync().await;

    let err = try_join(&lobby, 3).await.expect_err("a fourth player joined a 3-seat lobby");
    assert!(err.contains("game full"), "{err}");
    // joining twice is harmless
    try_join(&lobby, 1).await.expect("a repeat join by a seated player");
    lobby.sync().await;

    for i in 0..4 {
        let st = lobby.state(i).await;
        assert_eq!(st.players.len(), 3, "agent {i} sees {} players", st.players.len());
        assert!(!st.seat_lost, "agent {i} lost a seat");
    }
    let deal: DealResult = lobby.call(0, "deal_roles", ()).await;
    assert_eq!(deal.seats.len(), 3);
    assert!(!deal.seats.contains(lobby.cells[3].agent_pubkey()));
    lobby.sync().await;
    let err = try_join(&lobby, 3).await.expect_err("joined a game that had started");
    assert!(err.contains("already started"), "{err}");
}

/// Two players go for the last seat at the same moment. Each zome sees a free
/// seat in its own view, so both joins can land; there's no global lock in
/// Holochain to stop that. Once the joins have gossiped, every node seats the
/// same players (earliest join by timestamp, then hash), the loser's state
/// says `seat_lost`, and the deal seats exactly the cap.
#[tokio::test(flavor = "multi_thread")]
async fn race_for_the_last_seat() {
    let lobby = Lobby::setup(4).await;
    create_lobby_for(&lobby, 3).await;
    try_join(&lobby, 1).await.expect("first join");
    lobby.sync().await;

    let (a, b) = tokio::join!(try_join(&lobby, 2), try_join(&lobby, 3));
    eprintln!(
        "race: agent 2 {}, agent 3 {}",
        a.as_ref().map_or_else(|e| format!("refused ({e})"), |_| "joined".into()),
        b.as_ref().map_or_else(|e| format!("refused ({e})"), |_| "joined".into()),
    );
    assert!(a.is_ok() || b.is_ok(), "nobody got the last seat");
    lobby.sync().await;

    let views: Vec<GameStateView> = futures_join(&lobby).await;
    let seated = player_keys(&views[0]);
    assert_eq!(seated.len(), 3, "{seated:?}");
    for (i, v) in views.iter().enumerate() {
        assert_eq!(player_keys(v), seated, "agent {i} seats different players");
    }
    let losers: Vec<usize> = [2, 3].into_iter().filter(|&i| views[i].seat_lost).collect();
    let both_joined = a.is_ok() && b.is_ok();
    assert_eq!(losers.len(), usize::from(both_joined), "seat_lost: {losers:?}");
    for (i, joined) in [(2, a.is_ok()), (3, b.is_ok())] {
        let holds = seated.contains(lobby.cells[i].agent_pubkey());
        if joined {
            assert_eq!(views[i].seat_lost, !holds, "agent {i}: seat_lost disagrees with the seating");
        } else {
            assert!(!holds && !views[i].seat_lost, "agent {i} was refused, so has no seat to lose");
        }
    }

    let deal: DealResult = lobby.call(0, "deal_roles", ()).await;
    let mut dealt = deal.seats.clone();
    dealt.sort();
    assert_eq!(dealt, seated, "the deal seated someone the lobby didn't");
}

async fn futures_join(lobby: &Lobby) -> Vec<GameStateView> {
    let mut out = Vec::new();
    for i in 0..lobby.cells.len() {
        out.push(lobby.state(i).await);
    }
    out
}

// --- link validation -----------------------------------------------------

#[derive(serde::Serialize, Debug)]
struct ForgeLink {
    anchor: String,
    target: AnyLinkableHash,
    tag: Vec<u8>,
}

async fn forge(lobby: &Lobby, i: usize, anchor: &str, target: AnyLinkableHash, tag: Vec<u8>) -> Result<ActionHash, String> {
    let z = lobby.cells[i].zome(ZOME);
    let res: Result<ActionHash, _> = lobby.conductors[i]
        .call_fallible(&z, "forge_link", ForgeLink { anchor: anchor.into(), target, tag })
        .await;
    res.map_err(|e| format!("{e:?}"))
}

fn msgpack<T: serde::Serialize + std::fmt::Debug>(v: &T) -> Vec<u8> {
    holochain_serialized_bytes::encode(v).unwrap()
}

/// A tampered client can't write links an honest one never would: pointing at
/// someone else, indexing someone else's entry, off an unknown anchor, with a
/// malformed or oversized tag. A well-formed link in its own name still
/// validates, and readers ignore it where only the host's count.
#[tokio::test(flavor = "multi_thread")]
async fn forged_links_are_rejected() {
    let lobby = Lobby::setup_with_forger(2).await;
    let host = lobby.cells[0].agent_pubkey().clone();
    let me = lobby.cells[1].agent_pubkey().clone();
    let lobby_record: Record = lobby
        .call(
            0,
            "create_lobby",
            CreateLobby {
                code: lobby.seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Alice".into(),
            },
        )
        .await;
    lobby.sync().await;
    let host_t = AnyLinkableHash::from(host.clone());
    let me_t = AnyLinkableHash::from(me.clone());

    let cases: Vec<(&str, AnyLinkableHash, Vec<u8>, &str)> = vec![
        ("lights", host_t.clone(), msgpack(&game_integrity::LightsSwitch::Cut), "must point at its author"),
        ("game", AnyLinkableHash::from(lobby_record.action_address().clone()), vec![], "own entries"),
        ("game", me_t.clone(), vec![], "must point at an action"),
        ("treasure", me_t.clone(), vec![], "the game's anchors"),
        ("doors", me_t.clone(), msgpack(&99u8), "malformed"),
        ("crisis", me_t.clone(), msgpack(&imposter_core::CrisisTag::Fix { kind: imposter_core::CrisisKind::Reactor, panel: 7 }), "malformed"),
        ("relay", me_t.clone(), vec![b'a'; 600], "too long"),
        ("bodies", me_t.clone(), b"not a body".to_vec(), "malformed"),
    ];
    for (anchor, target, tag, why) in cases {
        let err = forge(&lobby, 1, anchor, target, tag).await.expect_err(&format!("a forged {anchor} link validated"));
        assert!(err.contains(why), "{anchor}: expected {why:?}, got {err}");
    }

    // Well formed and in its own name: valid, but the host's settings are the
    // only ones anyone reads.
    let mut settings = test_settings();
    settings.kill_cooldown_s = 99;
    forge(&lobby, 1, "settings", me_t.clone(), msgpack(&settings)).await.expect("a well-formed link in my own name");
    lobby.sync().await;
    assert_ne!(lobby.state(0).await.settings.kill_cooldown_s, 99, "a non-host's settings were read");
}

/// Nothing in the game deletes a link, so validation refuses every delete:
/// someone else's link, and your own.
#[tokio::test(flavor = "multi_thread")]
async fn links_cannot_be_deleted() {
    let lobby = Lobby::setup_with_forger(2).await;
    let addr = "/ip4/127.0.0.1/udp/40001/webrtc-direct/p2p/host".to_string();
    let _: () = lobby.call(0, "share_relay", addr.clone()).await;
    let mine = forge(&lobby, 1, "relay", lobby.cells[1].agent_pubkey().clone().into(), b"/ip4/127.0.0.1/udp/1/x".to_vec())
        .await
        .expect("a legitimate relay link");
    lobby.sync().await;

    let z = lobby.cells[1].zome(ZOME);
    let res: Result<ActionHash, _> = lobby.conductors[1].call_fallible(&z, "forge_delete_link", mine).await;
    let err = format!("{:?}", res.expect_err("deleted a link"));
    assert!(err.contains("append-only"), "{err}");

    let host_links: Vec<ActionHash> = lobby.call(1, "forge_list_links", "relay".to_string()).await;
    assert!(!host_links.is_empty());
    for l in host_links {
        let res: Result<ActionHash, _> = lobby.conductors[1].call_fallible(&z, "forge_delete_link", l).await;
        let err = format!("{:?}", res.expect_err("deleted someone else's link"));
        assert!(err.contains("append-only"), "{err}");
    }
    lobby.sync().await;
    let seen: Option<String> = lobby.call(0, "get_relay", ()).await;
    assert!(seen.is_some(), "the relay address vanished");
}

// --- host-owned game identity ---------------------------------------------

/// Two agents with the game installed and no game yet: each identity test
/// opens its own clones, in seeds of its choosing.
async fn two_agents() -> (SweetConductorBatch, Vec<AgentPubKey>) {
    let dna = load_dna().await;
    let mut conductors = SweetConductorBatch::standard(2).await;
    let apps = conductors.setup_app(APP_ID, [&(ROLE.to_string(), dna)]).await.unwrap();
    let agents = apps.into_inner().iter().map(|a| a.agent().clone()).collect();
    (conductors, agents)
}

/// Agent `i` opens a clone in `seed` and tries to create a lobby there.
async fn create_in(conductors: &mut SweetConductorBatch, i: usize, seed: &str) -> Result<Record, String> {
    let cc = conductors[i]
        .create_clone_cell(
            &APP_ID.to_string(),
            CreateCloneCellPayload {
                role_name: ROLE.into(),
                modifiers: DnaModifiersOpt::none().with_network_seed(seed.to_string()),
                membrane_proof: None,
                name: Some(format!("seed {seed}")),
            },
        )
        .await
        .map_err(|e| format!("clone: {e:?}"))?;
    let cell = conductors[i].get_sweet_cell(cc.cell_id.clone()).unwrap();
    let res: Result<Record, _> = conductors[i]
        .call_fallible(
            &cell.zome(ZOME),
            "create_lobby",
            CreateLobby {
                code: seed.to_string(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
                display_name: "Host".into(),
            },
        )
        .await;
    res.map_err(|e| format!("{e:?}"))
}

/// A host opens a lobby in its own seed, as many as it likes, each in a seed
/// of its own; nobody else can open one in that host's name.
#[tokio::test(flavor = "multi_thread")]
async fn only_the_seeds_host_opens_its_lobby() {
    let (mut conductors, agents) = two_agents().await;
    let (a, b) = (&agents[0], &agents[1]);

    // A: its own seed, twice — two games, two distinct seeds
    let first = game_seed(a);
    let second = game_seed(a);
    assert_ne!(first, second, "two games from one host got the same seed");
    create_in(&mut conductors, 0, &first).await.expect("the host's own seed");
    create_in(&mut conductors, 0, &second).await.expect("a second game from the same host");

    // B: a seed naming A, fresh or already in use
    for seed in [game_seed(a), first.clone()] {
        let err = create_in(&mut conductors, 1, &seed).await.expect_err("B opened a lobby in A's name");
        assert!(err.contains("game seed host does not match lobby author"), "{seed}: {err}");
    }
    // …and B's own seed is fine
    create_in(&mut conductors, 1, &game_seed(b)).await.expect("B's own seed");
}

/// A lobby in anything but a well-formed game seed (or a legacy room seed) is
/// refused, with a reason that says what's wrong.
#[tokio::test(flavor = "multi_thread")]
async fn malformed_seeds_are_refused() {
    let (mut conductors, agents) = two_agents().await;
    let key = AgentPubKeyB64::from(agents[0].clone()).to_string();
    let id = random_id();
    let dna_key = DnaHashB64::from(DnaHash::from_raw_32(vec![7; 32])).to_string();
    let cases = [
        ("g1".to_string(), "expected g1"),
        ("g1.foo".to_string(), "expected g1"),
        ("not-a-game-seed".to_string(), "expected g1"),
        (format!("g2.{key}.{id}"), "unsupported game seed version"),
        (format!("g1.not-a-key.{id}"), "isn't an agent key"),
        (format!("g1.{dna_key}.{id}"), "isn't an agent key"),
        (format!("g1.{key}.not-hex"), "random id"),
        (format!("g1.{key}.{id}.extra"), "expected g1"),
        ("room1.".to_string(), "room code"),
    ];
    for (seed, why) in cases {
        let err = create_in(&mut conductors, 0, &seed).await.expect_err(&format!("a lobby in {seed:?}"));
        assert!(err.contains(why), "{seed}: expected {why:?}, got {err}");
    }
    // The UI's room-code games still work, for now, by anyone.
    create_in(&mut conductors, 1, "room1.LOBBY-DEMO").await.expect("a legacy room seed");
}

/// Ghosts keep doing their tasks: a killed crewmate's own tasks
/// still count, so the crew can still win on tasks after a death.
#[tokio::test(flavor = "multi_thread")]
async fn ghosts_finish_their_tasks() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await; // target 4, 3 crew: 2 tasks each
    let impostor_key = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let impostor = lobby.index_of(&impostor_key);
    let crew: Vec<usize> = (0..4).filter(|&i| i != impostor).collect();
    let tasks: Vec<TaskIn> = (0..4u16)
        .map(|id| TaskIn {
            id,
            name: format!("task {id}"),
            x: 0,
            y: 0,
        })
        .collect();
    let _: Record = lobby.call(0, "publish_tasks", tasks).await;
    lobby.sync().await;

    // crew[0] is killed, then finishes both tasks as a ghost; crew[1] finishes theirs
    let _: Record = lobby.call(crew[0], "report_own_death", impostor_key.clone()).await;
    lobby.sync().await;
    for &i in &crew[..2] {
        let mine: Vec<u16> = lobby.call(i, "my_tasks", ()).await;
        for id in mine {
            let _: Record = lobby.call(i, "complete_task", id).await;
        }
    }
    lobby.sync().await;

    let result: Option<GameResultView> = lobby.call(0, "try_finish", ()).await;
    let result = result.expect("four real tasks, two done by a ghost, should end the game");
    assert_eq!(result.outcome, Outcome::CrewWin);
    assert_eq!(result.tasks_done, 4);
    assert_eq!(result.crew_alive, 2);
}

/// Votes wait for the discussion time: a vote committed as the meeting opens is
/// refused, and accepted once the time is up.
#[tokio::test(flavor = "multi_thread")]
async fn discussion_holds_votes() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal_with(
        &lobby,
        GameSettings {
            discussion_s: 10,
            ..test_settings()
        },
    )
    .await;
    let impostor = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();
    let crew: Vec<usize> = (0..4)
        .filter(|&i| lobby.cells[i].agent_pubkey() != &impostor)
        .collect();
    let victim = lobby.cells[crew[0]].agent_pubkey().clone();
    let _: Record = lobby.call(crew[0], "report_own_death", impostor.clone()).await;
    lobby.sync().await;
    let _: Record = lobby
        .call(crew[1], "report_body", ReportBody { dead: victim })
        .await;
    lobby.sync().await;
    let meeting = lobby.state(0).await.active_meeting.expect("a meeting is open").meeting;

    let err = call_err(
        &lobby,
        crew[1],
        "commit_vote",
        CommitVote {
            meeting: meeting.clone(),
            commitment: vote_commitment(None, &salt(9)),
        },
    )
    .await;
    assert!(err.contains("discussion"), "voted during the discussion: {err}");

    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    let _: Record = lobby
        .call(
            crew[1],
            "commit_vote",
            CommitVote {
                meeting,
                commitment: vote_commitment(None, &salt(9)),
            },
        )
        .await;
}

/// A 2–2 vote is a tie: the host's tally opens a tie-breaker with only the two
/// tied players on the ballot, an off-ballot vote cannot be revealed, and the
/// tie-breaker's majority is voted off.
#[tokio::test(flavor = "multi_thread")]
async fn tie_goes_to_a_tie_breaker() {
    let lobby = Lobby::setup(4).await;
    let deal = seat_four_and_deal(&lobby).await;

    let (a, b) = (deal.seats[0].clone(), deal.seats[1].clone());
    let (ia, ib) = (lobby.index_of(&a), lobby.index_of(&b));
    let others: Vec<usize> = (0..4).filter(|&i| i != ia && i != ib).collect();

    // the emergency button unlocks 15 s after the deal
    tokio::time::sleep(std::time::Duration::from_millis(16_000)).await;
    let _: Record = lobby.call(0, "press_emergency", ()).await;
    lobby.sync().await;
    let meeting = lobby
        .state(0)
        .await
        .active_meeting
        .expect("a meeting is open")
        .meeting;

    // --- first vote: 2–2 between seats 0 and 1 ----------------------------
    vote(
        &lobby,
        &meeting,
        &[
            (ia, Some(b.clone())),
            (ib, Some(a.clone())),
            (others[0], Some(a.clone())),
            (others[1], Some(b.clone())),
        ],
    )
    .await;
    let _: Record = lobby.call(0, "resolve_meeting", meeting.clone()).await;
    lobby.sync().await;

    let st = lobby.state(0).await;
    assert_eq!(st.phase, "meeting", "a tie keeps the meeting going");
    let tie_breaker = st.active_meeting.expect("the tie-breaker is open");
    assert_ne!(tie_breaker.meeting, meeting, "the tie-breaker is its own meeting");
    assert_eq!(
        tie_breaker.candidates,
        Some(vec![Some(0), Some(1)]),
        "only the tied players are on the ballot"
    );
    assert_eq!(tie_breaker.resolved, None);
    let tb = tie_breaker.meeting;

    // --- an off-ballot vote (Skip) commits, but cannot be revealed -----------
    let s = salt(99);
    let _: Record = lobby
        .call(
            others[0],
            "commit_vote",
            CommitVote {
                meeting: tb.clone(),
                commitment: vote_commitment(None, &s),
            },
        )
        .await;
    let z = lobby.cells[others[0]].zome(ZOME);
    let res: Result<Record, _> = lobby.conductors[others[0]]
        .call_fallible(
            &z,
            "reveal_vote",
            RevealVote {
                meeting: tb.clone(),
                choice: None,
                salt: s,
            },
        )
        .await;
    assert!(res.is_err(), "a vote for an option that was not tied must not reveal");

    // --- tie-breaker: seat 0 wins 2–1 -------------------------------------
    vote(
        &lobby,
        &tb,
        &[
            (ia, Some(b.clone())),
            (ib, Some(a.clone())),
            (others[1], Some(a.clone())),
        ],
    )
    .await;
    let _: Record = lobby.call(0, "resolve_meeting", tb.clone()).await;
    lobby.sync().await;

    let st = lobby.state(0).await;
    assert_eq!(
        st.active_meeting.and_then(|m| m.resolved),
        Some(TallyOutcome::Ejected { seat: 0 })
    );
    assert_eq!(st.phase, "playing", "back to the game");
    assert!(
        st.players.iter().any(|p| p.key == a && p.dead),
        "the tie-breaker's winner was voted off"
    );
    assert!(
        st.role_reveals.contains(&(0, deal.roles[0])),
        "the host opened the voted-off player's role"
    );

    // the tally shows who voted for whom
    let seat = |i: usize| {
        deal.seats
            .iter()
            .position(|k| k == lobby.cells[i].agent_pubkey())
            .map(|s| s as u16)
    };
    let mut votes: Vec<(Option<u16>, Option<u16>)> = lobby
        .state(0)
        .await
        .active_meeting
        .expect("the tie-breaker is still shown")
        .votes
        .into_iter()
        .map(|v| (v.voter, v.choice))
        .collect();
    votes.sort();
    let mut expected = vec![
        (seat(ia), Some(1)),
        (seat(ib), Some(0)),
        (seat(others[1]), Some(0)),
    ];
    expected.sort();
    assert_eq!(votes, expected);
}

/// The host's settings can keep a voted-off player's role secret until the end
/// (confirm ejects off), hide who voted for whom (anonymous votes), and take
/// the emergency button away (no emergency meetings).
#[tokio::test(flavor = "multi_thread")]
async fn secret_ejects_and_anonymous_votes() {
    let lobby = Lobby::setup(4).await;
    let settings = GameSettings {
        emergency_meetings: 0,
        confirm_ejects: false,
        anonymous_votes: true,
        ..test_settings()
    };
    let deal = seat_four_and_deal_with(&lobby, settings).await;
    let impostor = deal.seats[deal.roles.iter().position(|&r| r == ROLE_IMPOSTOR).unwrap()].clone();

    let err = call_err(&lobby, 0, "press_emergency", ()).await;
    assert!(err.contains("no emergency meetings"), "an emergency with none allowed: {err}");
    assert_eq!(lobby.state(0).await.emergencies_left, 0);

    // a crewmate other than the host (who tallies) is killed, and reported
    let victim = (1..4)
        .find(|&i| lobby.cells[i].agent_pubkey() != &impostor)
        .unwrap();
    let victim_key = lobby.cells[victim].agent_pubkey().clone();
    let _: Record = lobby.call(victim, "report_own_death", impostor.clone()).await;
    lobby.sync().await;
    let living: Vec<usize> = (0..4).filter(|&i| i != victim).collect();
    let _: Record = lobby
        .call(living[1], "report_body", ReportBody { dead: victim_key })
        .await;
    lobby.sync().await;
    let meeting = lobby
        .state(0)
        .await
        .active_meeting
        .expect("a meeting is open")
        .meeting;

    // everyone votes off the last living player, never the host
    let target = *living.last().unwrap();
    let target_key = lobby.cells[target].agent_pubkey().clone();
    let target_seat = deal.seats.iter().position(|k| k == &target_key).unwrap() as u16;
    let ballots: Vec<(usize, Option<AgentPubKey>)> = living
        .iter()
        .map(|&i| (i, Some(target_key.clone())))
        .collect();
    vote(&lobby, &meeting, &ballots).await;
    let _: Record = lobby.call(0, "resolve_meeting", meeting).await;
    lobby.sync().await;

    let st = lobby.state(1).await;
    let shown = st.active_meeting.expect("the result is still shown");
    assert_eq!(shown.resolved, Some(TallyOutcome::Ejected { seat: target_seat }));
    assert!(
        st.players.iter().any(|p| p.key == target_key && p.dead),
        "the target was voted off"
    );
    assert!(st.role_reveals.is_empty(), "confirm ejects is off: no role opened");
    assert_eq!(shown.votes.len(), 3);
    assert!(
        shown
            .votes
            .iter()
            .all(|v| v.voter.is_none() && v.choice == Some(target_seat)),
        "anonymous: what was voted for, but not by whom: {:?}",
        shown.votes
    );

    let _: Record = lobby.call(0, "reveal_all", ()).await;
    lobby.sync().await;
    assert_eq!(
        lobby.state(1).await.role_reveals.len(),
        4,
        "the end still opens every role"
    );
}

// --- private room registry (base cell, no clone needed for lookup) ---------
#[derive(serde::Serialize, Debug)]
struct PublishPointer {
    room_code: String,
    game_seed: String,
    round: u32,
    previous: Option<ActionHash>,
}
#[derive(serde::Deserialize, Debug, Clone)]
struct PointerView {
    action: ActionHash,
    pointer: game_integrity::RoomPointer,
}
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
enum RoomResolution {
    NotFound,
    Unavailable,
    Conflict,
    Found { current: PointerView },
}
#[derive(serde::Serialize, Debug)]
struct ForgeRoomLink {
    base: AnyLinkableHash,
    target: AnyLinkableHash,
    tag: Vec<u8>,
}

async fn registry_agents() -> (SweetConductorBatch, Vec<SweetCell>) {
    let dna = load_forge_dna().await;
    let mut conductors = SweetConductorBatch::standard(2).await;
    let apps = conductors
        .setup_app(APP_ID, [&(ROLE.to_string(), dna)])
        .await
        .unwrap();
    let cells = apps
        .into_inner()
        .into_iter()
        .map(|a| a.into_cells().remove(0))
        .collect();
    conductors.exchange_peer_info().await;
    (conductors, cells)
}
async fn registry_sync(cells: &[SweetCell]) {
    await_consistency_s(60, cells.iter().collect::<Vec<_>>())
        .await
        .unwrap();
}
async fn publish_pointer(
    c: &SweetConductor,
    cell: &SweetCell,
    code: &str,
    seed: &str,
    round: u32,
    previous: Option<ActionHash>,
) -> PointerView {
    c.call(
        &cell.zome(ZOME),
        "publish_room_pointer",
        PublishPointer {
            room_code: code.into(),
            game_seed: seed.into(),
            round,
            previous,
        },
    )
    .await
}
async fn resolve_pointer(c: &SweetConductor, cell: &SweetCell, code: &str) -> RoomResolution {
    c.call(&cell.zome(ZOME), "resolve_room_pointer", code.to_string())
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn room_pointer_create_resolve_join_and_update() {
    let (mut conductors, base) = registry_agents().await;
    assert!(matches!(
        resolve_pointer(&conductors[1], &base[1], "MISSING").await,
        RoomResolution::NotFound
    ));
    let seed = game_seed(base[0].agent_pubkey());
    create_in(&mut conductors, 0, &seed).await.unwrap();
    let p = publish_pointer(&conductors[0], &base[0], "  private-a ", &seed, 1, None).await;
    let retry = publish_pointer(&conductors[0], &base[0], "PRIVATE-A", &seed, 1, None).await;
    assert_eq!(
        p.action, retry.action,
        "publish retry created another record"
    );
    registry_sync(&base).await;
    let RoomResolution::Found { current } =
        resolve_pointer(&conductors[1], &base[1], "private-a").await
    else {
        panic!("room missing")
    };
    assert_eq!(current.pointer.game_seed, seed);
    assert_eq!(current.pointer.host, *base[0].agent_pubkey());
    // Only now does B clone the selected game, and take its seat.
    let cc = conductors[1]
        .create_clone_cell(
            &APP_ID.to_string(),
            CreateCloneCellPayload {
                role_name: ROLE.into(),
                modifiers: DnaModifiersOpt::none().with_network_seed(current.pointer.game_seed),
                membrane_proof: None,
                name: None,
            },
        )
        .await
        .unwrap();
    let joiner = conductors[1].get_sweet_cell(cc.cell_id.clone()).unwrap();
    let host_cell = conductors[0]
        .get_sweet_cell(CellId::new(
            joiner.dna_hash().clone(),
            base[0].agent_pubkey().clone(),
        ))
        .unwrap();
    conductors.exchange_peer_info().await;
    registry_sync(&[host_cell.clone(), joiner.clone()]).await;
    let _: Record = conductors[1]
        .call(
            &joiner.zome(ZOME),
            "join_lobby",
            JoinLobby {
                display_name: "B".into(),
            },
        )
        .await;
    registry_sync(&[host_cell.clone(), joiner.clone()]).await;
    let state: GameStateView = conductors[0]
        .call(&host_cell.zome(ZOME), "get_game_state", ())
        .await;
    assert_eq!(state.players.len(), 2);
    // A second independent room from the same host has another random seed.
    let other_seed = game_seed(base[0].agent_pubkey());
    create_in(&mut conductors, 0, &other_seed).await.unwrap();
    publish_pointer(&conductors[0], &base[0], "PRIVATE-B", &other_seed, 1, None).await;
    // Underlying round update API: ready lobby, then signed next pointer.
    let next_seed = game_seed(base[0].agent_pubkey());
    create_in(&mut conductors, 0, &next_seed).await.unwrap();
    let next = publish_pointer(
        &conductors[0],
        &base[0],
        "PRIVATE-A",
        &next_seed,
        2,
        Some(p.action),
    )
    .await;
    registry_sync(&base).await;
    let RoomResolution::Found { current } =
        resolve_pointer(&conductors[1], &base[1], "PRIVATE-A").await
    else {
        panic!("next pointer missing")
    };
    assert_eq!(current.action, next.action);
    assert_eq!(current.pointer.round, 2);
    let RoomResolution::Found { current } =
        resolve_pointer(&conductors[1], &base[1], "PRIVATE-B").await
    else {
        panic!("second room missing")
    };
    assert_eq!(current.pointer.game_seed, other_seed);
}

#[tokio::test(flavor = "multi_thread")]
async fn conflicting_room_hosts_and_round_forks_fail_closed() {
    let (conductors, base) = registry_agents().await;
    let a = game_seed(base[0].agent_pubkey());
    let b = game_seed(base[1].agent_pubkey());
    publish_pointer(&conductors[0], &base[0], "COLLISION", &a, 1, None).await;
    publish_pointer(&conductors[1], &base[1], "COLLISION", &b, 1, None).await;
    registry_sync(&base).await;
    for i in 0..2 {
        assert!(matches!(
            resolve_pointer(&conductors[i], &base[i], "COLLISION").await,
            RoomResolution::Conflict
        ));
    }
    let root = publish_pointer(&conductors[0], &base[0], "FORK-ROOM", &a, 1, None).await;
    let seed = game_seed(base[0].agent_pubkey());
    publish_pointer(
        &conductors[0],
        &base[0],
        "FORK-ROOM",
        &seed,
        2,
        Some(root.action.clone()),
    )
    .await;
    let fork = game_integrity::RoomPointer {
        version: 1,
        room_code_hash: root.pointer.room_code_hash,
        game_seed: game_seed(base[0].agent_pubkey()),
        host: base[0].agent_pubkey().clone(),
        round: 2,
        previous: Some(root.action),
    };
    let action: ActionHash = conductors[0]
        .call(&base[0].zome(ZOME), "forge_room_pointer", fork.clone())
        .await;
    let _: ActionHash = conductors[0]
        .call(
            &base[0].zome(ZOME),
            "forge_room_link",
            ForgeRoomLink {
                base: game_integrity::room_anchor(&fork.room_code_hash).unwrap(),
                target: action.into(),
                tag: vec![],
            },
        )
        .await;
    registry_sync(&base).await;
    for i in 0..2 {
        assert!(matches!(
            resolve_pointer(&conductors[i], &base[i], "FORK-ROOM").await,
            RoomResolution::Conflict
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_room_pointers_and_unauthorized_authors_are_rejected() {
    let (conductors, base) = registry_agents().await;
    let host = base[0].agent_pubkey().clone();
    let p = game_integrity::RoomPointer {
        version: 1,
        room_code_hash: [1; 32],
        game_seed: game_seed(&host),
        host: host.clone(),
        round: 1,
        previous: None,
    };
    // B bypasses the honest coordinator and writes A's pointer directly.
    let res: Result<ActionHash, _> = conductors[1]
        .call_fallible(&base[1].zome(ZOME), "forge_room_pointer", p.clone())
        .await;
    assert!(format!("{:?}", res.unwrap_err()).contains("game seed host"));
    let mut cases = Vec::new();
    for seed in [
        "room1.PRIVATE".to_string(),
        "g1.invalid.abc".into(),
        "x".repeat(151),
        game_seed(base[1].agent_pubkey()),
    ] {
        let mut bad = p.clone();
        bad.game_seed = seed;
        cases.push(bad);
    }
    let mut bad = p.clone();
    bad.version = 2;
    cases.push(bad);
    let mut bad = p.clone();
    bad.room_code_hash = [0; 32];
    cases.push(bad);
    let mut bad = p.clone();
    bad.round = 0;
    cases.push(bad);
    let mut bad = p.clone();
    bad.round = 2;
    cases.push(bad);
    for bad in cases {
        let res: Result<ActionHash, _> = conductors[0]
            .call_fallible(&base[0].zome(ZOME), "forge_room_pointer", bad)
            .await;
        assert!(res.is_err(), "malformed pointer accepted");
    }
    let res: Result<RoomResolution, _> = conductors[1]
        .call_fallible(
            &base[1].zome(ZOME),
            "resolve_room_pointer",
            "BAD#ROOM".to_string(),
        )
        .await;
    assert!(res.is_err());
    #[derive(serde::Serialize, Debug)]
    struct ExtraMetadata<'a> {
        #[serde(flatten)]
        pointer: &'a game_integrity::RoomPointer,
        metadata: String,
    }
    let unknown = msgpack(&ExtraMetadata {
        pointer: &p,
        metadata: "x".repeat(4096),
    });
    #[derive(serde::Serialize, Debug)]
    struct BadHash<'a> {
        version: u8,
        room_code_hash: Vec<u8>,
        game_seed: &'a str,
        host: &'a AgentPubKey,
        round: u32,
        previous: Option<ActionHash>,
    }
    let short_hash = msgpack(&BadHash {
        version: 1,
        room_code_hash: vec![1; 31],
        game_seed: &p.game_seed,
        host: &p.host,
        round: 1,
        previous: None,
    });
    for bytes in [unknown, short_hash, vec![0xc1]] {
        let res: Result<ActionHash, _> = conductors[0]
            .call_fallible(&base[0].zome(ZOME), "forge_raw_room_pointer", bytes)
            .await;
        assert!(res.is_err(), "malformed/oversized raw record accepted");
    }
    let action: ActionHash = conductors[0]
        .call(&base[0].zome(ZOME), "forge_room_pointer", p.clone())
        .await;
    registry_sync(&base).await;
    for variant in 0..4 {
        let mut bad = p.clone();
        bad.round = 2;
        bad.previous = Some(action.clone());
        match variant {
            0 => bad.room_code_hash = [2; 32],
            1 => bad.round = 3,
            2 => {} // same game seed is not a subsequent game
            _ => {
                bad.host = base[1].agent_pubkey().clone();
                bad.game_seed = game_seed(&bad.host);
            }
        }
        let i = if variant == 3 { 1 } else { 0 };
        let res: Result<ActionHash, _> = conductors[i]
            .call_fallible(&base[i].zome(ZOME), "forge_room_pointer", bad)
            .await;
        assert!(res.is_err(), "invalid predecessor accepted");
    }
    let anchor = game_integrity::room_anchor(&p.room_code_hash).unwrap();
    let mut links = vec![
        ForgeRoomLink {
            base: anchor.clone(),
            target: host.clone().into(),
            tag: vec![],
        },
        ForgeRoomLink {
            base: anchor.clone(),
            target: action.clone().into(),
            tag: vec![1],
        },
        ForgeRoomLink {
            base: anchor.clone(),
            target: action.clone().into(),
            tag: vec![1; 1024],
        },
        ForgeRoomLink {
            base: game_integrity::room_anchor(&[2; 32]).unwrap(),
            target: action.clone().into(),
            tag: vec![],
        },
    ];
    for l in links.drain(..) {
        let res: Result<ActionHash, _> = conductors[0]
            .call_fallible(&base[0].zome(ZOME), "forge_room_link", l)
            .await;
        assert!(res.is_err(), "bad pointer index accepted");
    }
    let res: Result<ActionHash, _> = conductors[1]
        .call_fallible(
            &base[1].zome(ZOME),
            "forge_room_link",
            ForgeRoomLink {
                base: anchor.clone(),
                target: action.clone().into(),
                tag: vec![],
            },
        )
        .await;
    assert!(res.is_err(), "another author indexed the pointer");
    // A lobby record is not a valid registry target, even with its own author.
    // Agent actions are also the wrong record type.
    let agent_record: ActionHash = conductors[0]
        .call(&base[0].zome(ZOME), "forge_agent_action", ())
        .await;
    let res: Result<ActionHash, _> = conductors[0]
        .call_fallible(
            &base[0].zome(ZOME),
            "forge_room_link",
            ForgeRoomLink {
                base: anchor.clone(),
                target: agent_record.into(),
                tag: vec![],
            },
        )
        .await;
    assert!(res.is_err());
    let res: Result<ActionHash, _> = conductors[1]
        .call_fallible(&base[1].zome(ZOME), "forge_delete_entry", action.clone())
        .await;
    assert!(res.is_err(), "another host deleted the pointer entry");
    let link: ActionHash = conductors[0]
        .call(
            &base[0].zome(ZOME),
            "forge_room_link",
            ForgeRoomLink {
                base: anchor,
                target: action.into(),
                tag: vec![],
            },
        )
        .await;
    for i in 0..2 {
        let res: Result<ActionHash, _> = conductors[i]
            .call_fallible(&base[i].zome(ZOME), "forge_delete_link", link.clone())
            .await;
        assert!(res.is_err(), "pointer link deleted");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn room_creation_recovers_unindexed_records() {
    let (mut conductors, base) = registry_agents().await;
    let seed = game_seed(base[0].agent_pubkey());
    let cc = conductors[0]
        .create_clone_cell(
            &APP_ID.to_string(),
            CreateCloneCellPayload {
                role_name: ROLE.into(),
                modifiers: DnaModifiersOpt::none().with_network_seed(seed.clone()),
                membrane_proof: None,
                name: None,
            },
        )
        .await
        .unwrap();
    let game = conductors[0].get_sweet_cell(cc.cell_id).unwrap();
    let hash: ActionHash = conductors[0]
        .call(
            &game.zome(ZOME),
            "forge_unindexed_lobby",
            game_integrity::Lobby {
                code: seed.clone(),
                player_count: 4,
                impostor_count: 1,
                task_target: 4,
            },
        )
        .await;
    let create = || CreateLobby {
        code: seed.clone(),
        player_count: 4,
        impostor_count: 1,
        task_target: 4,
        display_name: "Host".into(),
    };
    for _ in 0..2 {
        let record: Record = conductors[0]
            .call(&game.zome(ZOME), "create_lobby", create())
            .await;
        assert_eq!(
            record.action_address(),
            &hash,
            "retry created another lobby"
        );
    }
    let state: GameStateView = conductors[0]
        .call(&game.zome(ZOME), "get_game_state", ())
        .await;
    assert_eq!(state.players.len(), 1);
    let p = game_integrity::RoomPointer {
        version: 1,
        room_code_hash: game_integrity::room_code_hash("RECOVERY").unwrap(),
        game_seed: seed.clone(),
        host: base[0].agent_pubkey().clone(),
        round: 1,
        previous: None,
    };
    let hash: ActionHash = conductors[0]
        .call(&base[0].zome(ZOME), "forge_room_pointer", p.clone())
        .await;
    assert!(matches!(
        resolve_pointer(&conductors[0], &base[0], "RECOVERY").await,
        RoomResolution::NotFound
    ));
    let repaired = publish_pointer(&conductors[0], &base[0], "RECOVERY", &seed, 1, None).await;
    assert_eq!(repaired.action, hash, "retry created another pointer");
    registry_sync(&base).await;
    assert!(matches!(
        resolve_pointer(&conductors[1], &base[1], "RECOVERY").await,
        RoomResolution::Found { .. }
    ));
    let res: Result<ActionHash, _> = conductors[0]
        .call_fallible(&game.zome(ZOME), "forge_room_pointer", p)
        .await;
    assert!(format!("{:?}", res.unwrap_err()).contains("base game cell"));
}
