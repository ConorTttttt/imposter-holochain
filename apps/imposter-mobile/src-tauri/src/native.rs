//! Narrow, deny-by-default Tauri boundary to the phone conductor.
//! All identity material and H2HC linker configuration stay behind this API.
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

const NOT_READY: &str = "native H2HC conductor not started; Android cannot join games";
pub(crate) type BoxTask<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

#[derive(Serialize)]
pub(crate) struct MobileStatus {
    phase: &'static str,
    reason: String,
}

pub(crate) trait ConductorBackend: Send + Sync {
    fn app_info(&self) -> BoxTask<serde_json::Value>;
    fn create_clone(&self, seed: String) -> BoxTask<serde_json::Value>;
    fn disable_clone(&self, id: String) -> BoxTask<()>;
    fn call_zome(&self, role: String, function: String, payload: Vec<u8>) -> BoxTask<Vec<u8>>;
}

#[derive(Default)]
pub(crate) struct NativeConductorState {
    backend: RwLock<Option<Arc<dyn ConductorBackend>>>,
}

impl NativeConductorState {
    /// Called only by native startup after verifying the H2HC linker and
    /// installing or resuming the Imposter hApp. Never exported to WebView.
    #[allow(dead_code)]
    pub(crate) fn attach(&self, backend: Arc<dyn ConductorBackend>) -> Result<(), String> {
        let mut guard = self.backend.write().map_err(|_| "native runtime lock poisoned")?;
        if guard.is_some() { return Err("conductor already attached".into()); }
        *guard = Some(backend);
        Ok(())
    }

    fn current(&self) -> Result<Arc<dyn ConductorBackend>, String> {
        self.backend.read()
            .map_err(|_| "native runtime lock poisoned".to_string())?
            .as_ref().cloned()
            .ok_or_else(|| NOT_READY.into())
    }

    fn status(&self) -> MobileStatus {
        match self.current() {
            Ok(_) => MobileStatus { phase: "ready", reason: String::new() },
            Err(error) => MobileStatus { phase: "unavailable", reason: error },
        }
    }

    async fn app_info(&self) -> Result<serde_json::Value, String> {
        self.current()?.app_info().await
    }
    async fn create_clone(&self, seed: String) -> Result<serde_json::Value, String> {
        if !valid_seed(&seed) { return Err("invalid Imposter game network seed".into()); }
        self.current()?.create_clone(seed).await
    }
    async fn disable_clone(&self, id: String) -> Result<(), String> {
        if !valid_clone_id(&id) { return Err("invalid Imposter clone ID".into()); }
        self.current()?.disable_clone(id).await
    }
    async fn call_zome(&self, role: String, zome: String, function: String, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
        if !valid_role(&role) || zome != "game" || !allowed_fn(&function) {
            return Err("unsupported Imposter zome call".into());
        }
        if bytes.len() > 256 * 1024 { return Err("zome call payload exceeds 256 KiB".into()); }
        self.current()?.call_zome(role, function, bytes).await
    }
}

fn valid_seed(seed: &str) -> bool {
    seed.len() <= 256
        && !seed.is_empty()
        && (seed.starts_with("g1.") || seed.starts_with("room1."))
        && seed.bytes().all(|c| c.is_ascii_graphic())
}

fn valid_clone_id(id: &str) -> bool {
    id.strip_prefix("game.").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.len() <= 12
            && suffix.bytes().all(|c| c.is_ascii_digit())
    })
}

fn allowed_fn(name: &str) -> bool {
    matches!(
        name,
        "resolve_room_pointer" | "publish_room_pointer" | "get_game_state"
            | "create_lobby" | "join_lobby" | "set_settings"
            | "deal_roles" | "publish_tasks" | "my_tasks"
            | "request_role" | "host_online" | "get_relay" | "share_relay"
            | "try_finish" | "complete_task" | "scan_role" | "kill"
            | "mark_body" | "report_body" | "press_emergency"
            | "commit_vote" | "reveal_vote" | "resolve_meeting"
            | "cut_lights" | "cut_comms" | "close_doors"
            | "start_crisis" | "fix_lights" | "fix_comms"
            | "fix_crisis" | "use_vent" | "reveal_all" | "check_result"
    )
}

fn valid_role(role: &str) -> bool {
    role == "game" || valid_clone_id(role)
}

#[tauri::command]
pub(crate) fn mobile_status(state: tauri::State<'_, NativeConductorState>) -> MobileStatus {
    state.status()
}
#[tauri::command]
pub(crate) async fn mobile_app_info(state: tauri::State<'_, NativeConductorState>) -> Result<serde_json::Value, String> {
    state.app_info().await
}
#[tauri::command]
pub(crate) async fn mobile_create_clone(state: tauri::State<'_, NativeConductorState>, network_seed: String) -> Result<serde_json::Value, String> {
    state.create_clone(network_seed).await
}
#[tauri::command]
pub(crate) async fn mobile_disable_clone(state: tauri::State<'_, NativeConductorState>, clone_id: String) -> Result<(), String> {
    state.disable_clone(clone_id).await
}
#[tauri::command]
pub(crate) async fn mobile_call_zome(
    state: tauri::State<'_, NativeConductorState>,
    role_name: String,
    zome_name: String,
    fn_name: String,
    payload_bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    state.call_zome(role_name, zome_name, fn_name, payload_bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn validates_seeds_clone_ids_and_function_names() {
        assert!(valid_seed("room1.ABCD"));
        assert!(valid_seed("g1.uhCAkHi_foo.123abc"));
        assert!(!valid_seed("room1.hello world"));
        assert!(!valid_seed("other.seed"));
        assert!(valid_role("game"));
        assert!(valid_role("game.0"));
        assert!(!valid_role("other.0"));
        assert!(!valid_role("game.xyz"));
        assert!(allowed_fn("get_game_state"));
        assert!(!allowed_fn("debug_forge"));
    }

    #[test]
    fn uninitialized_conductor_fails_closed() {
        let runtime = NativeConductorState::default();
        assert_eq!(runtime.status().phase, "unavailable");
        tauri::async_runtime::block_on(async {
            assert!(runtime.app_info().await.is_err());
            assert!(runtime.create_clone("room1.ABCD".into()).await.is_err());
            assert!(runtime.disable_clone("game.0".into()).await.is_err());
            assert!(runtime.call_zome("game".into(), "game".into(), "get_game_state".into(), vec![0xc0]).await.is_err());
        });
    }

    struct FakeBackend(Arc<AtomicUsize>);
    impl ConductorBackend for FakeBackend {
        fn app_info(&self) -> BoxTask<serde_json::Value> {
            Box::pin(async { Ok(serde_json::json!({"agent_pub_key":[1,2,3],"clones":[]})) })
        }
        fn create_clone(&self, seed: String) -> BoxTask<serde_json::Value> {
            Box::pin(async move { Ok(serde_json::json!({"clone_id":"game.0","network_seed":seed,"enabled":true})) })
        }
        fn disable_clone(&self, _: String) -> BoxTask<()> {
            Box::pin(async { Ok(()) })
        }
        fn call_zome(&self, _: String, _: String, bytes: Vec<u8>) -> BoxTask<Vec<u8>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(bytes) })
        }
    }

    #[test]
    fn attached_backend_handles_valid_calls_but_never_bypasses_allowlist() {
        let state = NativeConductorState::default();
        let calls = Arc::new(AtomicUsize::new(0));
        state.attach(Arc::new(FakeBackend(calls.clone()))).unwrap();
        assert!(state.attach(Arc::new(FakeBackend(calls.clone()))).is_err());
        assert_eq!(state.status().phase, "ready");
        tauri::async_runtime::block_on(async {
            assert_eq!(state.app_info().await.unwrap()["agent_pub_key"], serde_json::json!([1,2,3]));
            assert_eq!(state.create_clone("room1.ABCD".into()).await.unwrap()["network_seed"], "room1.ABCD");
            assert!(state.create_clone("anything-else".into()).await.is_err());
            assert_eq!(state.call_zome("game".into(), "game".into(), "get_game_state".into(), vec![0xc0]).await.unwrap(), vec![0xc0]);
            assert!(state.call_zome("game".into(), "game".into(), "forge".into(), vec![]).await.is_err());
            assert!(state.call_zome("game".into(), "game".into(), "get_game_state".into(), vec![0; 256 * 1024 + 1]).await.is_err());
            assert!(state.disable_clone("other.0".into()).await.is_err());
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
