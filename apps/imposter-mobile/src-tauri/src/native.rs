//! Minimal, deny-by-default IPC surface for Imposter's eventual H2HC runtime.
//! The phone conductor, signer, linker identity, and tokens are native-only.
//! Nothing here ever falls back to a desktop conductor or remote signing service.
use serde::Serialize;

const NOT_READY: &str =
    "native H2HC conductor not installed yet; Android shell cannot join games";

#[derive(Serialize)]
pub(crate) struct MobileStatus {
    phase: &'static str,
    reason: &'static str,
}

fn valid_seed(seed: &str) -> bool {
    // Game seeds are either host-owned (g1.) or room-scoped (room1.).
    // Never let a WebView request arbitrary conductor clones.
    seed.len() <= 256
        && !seed.is_empty()
        && (seed.starts_with("g1.") || seed.starts_with("room1."))
        && seed.bytes().all(|c| c.is_ascii_graphic())
}

fn valid_clone_id(id: &str) -> bool {
    id.strip_prefix("game.")
        .is_some_and(|suffix| !suffix.is_empty()
            && suffix.len() <= 12
            && suffix.bytes().all(|c| c.is_ascii_digit()))
}

fn allowed_fn(name: &str) -> bool {
    matches!(
        name,
        "resolve_room_pointer"
            | "publish_room_pointer"
            | "get_game_state"
            | "create_lobby"
            | "join_lobby"
            | "set_settings"
            | "deal_roles"
            | "publish_tasks"
            | "my_tasks"
            | "request_role"
            | "host_online"
            | "get_relay"
            | "share_relay"
            | "try_finish"
            | "complete_task"
            | "scan_role"
            | "kill"
            | "mark_body"
            | "report_body"
            | "press_emergency"
            | "commit_vote"
            | "reveal_vote"
            | "resolve_meeting"
            | "cut_lights"
            | "cut_comms"
            | "close_doors"
            | "start_crisis"
            | "fix_lights"
            | "fix_comms"
            | "fix_crisis"
            | "use_vent"
            | "reveal_all"
            | "check_result"
    )
}

fn valid_role(role: &str) -> bool {
    role == "game" || valid_clone_id(role)
}

#[tauri::command]
pub(crate) fn mobile_status() -> MobileStatus {
    MobileStatus {
        phase: "unavailable",
        reason: NOT_READY,
    }
}

// These are typed boundaries for the H2HC conductor adapter. They explicitly
// reject requests until native initialization and durable identity are wired.
// No keystore secret, access token or arbitrary call route is exposed.
#[tauri::command]
pub(crate) fn mobile_app_info() -> Result<serde_json::Value, String> {
    Err(NOT_READY.into())
}

#[tauri::command]
pub(crate) fn mobile_create_clone(network_seed: String) -> Result<serde_json::Value, String> {
    if !valid_seed(&network_seed) {
        return Err("invalid Imposter game network seed".into());
    }
    Err(NOT_READY.into())
}

#[tauri::command]
pub(crate) fn mobile_disable_clone(clone_id: String) -> Result<(), String> {
    if !valid_clone_id(&clone_id) {
        return Err("invalid Imposter clone ID".into());
    }
    Err(NOT_READY.into())
}

#[tauri::command]
pub(crate) fn mobile_call_zome(
    role_name: String,
    zome_name: String,
    fn_name: String,
    payload_bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    if !valid_role(&role_name) || zome_name != "game" || !allowed_fn(&fn_name) {
        return Err("unsupported Imposter zome call".into());
    }
    if payload_bytes.len() > 256 * 1024 {
        return Err("zome call payload exceeds 256 KiB".into());
    }
    Err(NOT_READY.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_game_seeds_are_accepted() {
        assert!(valid_seed("room1.ABCD"));
        assert!(valid_seed("g1.uhCAkHi_foo.123abc"));
        for s in ["", "other.seed", "room1.hello world", "room1.\n", "x"] {
            assert!(!valid_seed(s));
        }
    }

    #[test]
    fn clone_id_is_limited_to_game_role() {
        assert!(valid_role("game"));
        assert!(valid_role("game.0"));
        assert!(!valid_role("other.0"));
        assert!(!valid_role("game.xyz"));
        assert!(!valid_role("game."));
    }

    #[test]
    fn whitelist_is_explicit() {
        assert!(allowed_fn("get_game_state"));
        assert!(allowed_fn("resolve_room_pointer"));
        assert!(!allowed_fn("debug_forge"));
        assert!(!allowed_fn("install_app"));
    }

    #[test]
    fn all_uninitialized_calls_fail_closed() {
        assert!(mobile_app_info().is_err());
        assert!(mobile_create_clone("room1.ABCD".into()).is_err());
        assert!(mobile_disable_clone("game.0".into()).is_err());
        assert!(mobile_call_zome(
            "game".into(), "game".into(), "get_game_state".into(), vec![0xc0],
        ).is_err());
    }
}
