#!/usr/bin/env python3
"""CI-only fail-closed revocation hardening of the exact pinned H2HC source.

This deliberately fails on source drift. No upstream pin, wire auth protocol,
HWC source, Imposter integrity validation or production bypass is changed.
"""
import argparse
from pathlib import Path
import subprocess


def one(file: Path, old: str, new: str) -> None:
    src = file.read_text()
    count = src.count(old)
    if count != 1:
        raise RuntimeError(f"{file}: expected one patch anchor, got {count}: {old[:70]!r}")
    file.write_text(src.replace(old, new, 1))


def patch(repo: Path) -> None:
    if subprocess.check_output(
        ["git", "-C", str(repo), "branch", "--show-current"], text=True
    ).strip() != "security/imposter-browser-networking":
        raise RuntimeError("Refusing to patch an unexpected H2HC branch")

    store = repo / "src/auth/store.rs"
    one(store, "use tokio::sync::RwLock;",
        "use tokio::sync::{broadcast, RwLock};")
    one(store,
        "    ws_senders: Arc<RwLock<HashMap<AgentPubKey, Vec<WsSender>>>>,",
        """    ws_senders: Arc<RwLock<HashMap<AgentPubKey, Vec<WsSender>>>>,
    // Every socket subscribes before authentication. Revocation is per agent.
    revocations: broadcast::Sender<AgentPubKey>,""")
    one(store,
        """    pub fn with_store(store: Arc<dyn SessionStore>) -> Self {
        Self {
            store,
            ws_senders: Arc::new(RwLock::new(HashMap::new())),
        }
    }""",
        """    pub fn with_store(store: Arc<dyn SessionStore>) -> Self {
        let (revocations, _) = broadcast::channel(128);
        Self {
            store,
            ws_senders: Arc::new(RwLock::new(HashMap::new())),
            revocations,
        }
    }""")
    one(store,
        """                if removed {
                    let mut ws = self.ws_senders.write().await;
                    ws.remove(agent_pubkey);
                }
                removed""",
        """                if removed {
                    // Remove every registered sender, then notify ALL live
                    // sockets (including ones racing with WS sender register).
                    self.ws_senders.write().await.remove(agent_pubkey);
                    let _ = self.revocations.send(agent_pubkey.clone());
                }
                removed""")
    one(store,
        "    // --- WS connection tracking (always in-memory) ---",
        """    // --- WS connection tracking (always in-memory) ---

    /// Receive per-agent administrative revocations. No bearer is broadcast.
    pub fn subscribe_revocations(&self) -> broadcast::Receiver<AgentPubKey> {
        self.revocations.subscribe()
    }
""")
    one(store,
        """    #[tokio::test]
    async fn test_multiple_ws_connections_per_agent() {""",
        """    #[tokio::test]
    async fn test_revocation_invalidates_every_session_and_notifies_all_sockets() {
        let store = AuthStore::new();
        let a = test_agent(1);
        let b = test_agent(2);
        store.add_agent(test_allowed_agent(1, &[Capability::DhtRead])).await;
        store.add_agent(test_allowed_agent(2, &[Capability::DhtRead])).await;

        let a_old_1 = store.create_session(&a).await.unwrap();
        let a_old_2 = store.create_session(&a).await.unwrap();
        let b_token = store.create_session(&b).await.unwrap();
        let mut socket_a1 = store.subscribe_revocations();
        let mut socket_a2 = store.subscribe_revocations();
        let mut socket_b = store.subscribe_revocations();

        let (tx_a1, _rx_a1) = mpsc::channel(1);
        let (tx_a2, _rx_a2) = mpsc::channel(1);
        let (tx_b, _rx_b) = mpsc::channel(1);
        store.register_ws_sender(&a, tx_a1).await;
        store.register_ws_sender(&a, tx_a2).await;
        store.register_ws_sender(&b, tx_b).await;
        assert_eq!(store.ws_connection_count(&a).await, 2);
        assert_eq!(store.ws_connection_count(&b).await, 1);

        assert!(store.remove_agent(&a).await);
        assert_eq!(socket_a1.try_recv().unwrap(), a);
        assert_eq!(socket_a2.try_recv().unwrap(), a);
        // Another socket can receive the notice but must filter by its own
        // authenticated identity. It remains registered and authorized.
        assert_ne!(socket_b.try_recv().unwrap(), b);
        assert_eq!(store.ws_connection_count(&a).await, 0);
        assert_eq!(store.ws_connection_count(&b).await, 1);
        assert!(store.validate_session(a_old_1.as_str()).await.is_none());
        assert!(store.validate_session(a_old_2.as_str()).await.is_none());
        assert!(store.validate_session(b_token.as_str()).await.is_some());
        assert!(store.create_session(&a).await.is_none());

        store.add_agent(test_allowed_agent(1, &[Capability::DhtRead])).await;
        let a_new = store.create_session(&a).await.unwrap();
        assert!(store.validate_session(a_new.as_str()).await.is_some());
        assert!(store.validate_session(a_old_1.as_str()).await.is_none());
        assert!(store.validate_session(a_old_2.as_str()).await.is_none());
    }

    #[tokio::test]
    async fn test_multiple_ws_connections_per_agent() {""")

    # Prevent a checked-then-written token from reappearing after revocation.
    memory = repo / "src/auth/memory_store.rs"
    one(memory,
        """        let inner = self.inner.read().await;
        let Some(allowed) = inner.allowed_agents.get(agent_pubkey) else {
            return Ok(None);
        };
        let capabilities = allowed.capabilities.clone();
        drop(inner);

        let token = SessionToken::generate();""",
        """        // Hold the same write lock as remove_agent through insertion:
        // a concurrent remove cannot leave a freshly inserted stale bearer.
        let mut inner = self.inner.write().await;
        let Some(allowed) = inner.allowed_agents.get(agent_pubkey) else {
            return Ok(None);
        };
        let capabilities = allowed.capabilities.clone();

        let token = SessionToken::generate();""")
    one(memory,
        """        let mut inner = self.inner.write().await;
        inner.sessions.insert(token.0.clone(), info);""",
        """        inner.sessions.insert(token.0.clone(), info);""")

    websocket = repo / "src/routes/websocket.rs"
    one(websocket, "use tokio::sync::mpsc;",
        "use tokio::sync::{broadcast, mpsc, oneshot};")
    one(websocket, "use std::time::Instant;",
        "use std::time::{Duration, Instant};")
    one(websocket,
        """    // Spawn task to forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {""",
        """    // Subscribe BEFORE the first auth message to avoid missing a revoke
    // that races with challenge verification or sender registration.
    let mut revocation_events = state.auth_store.as_ref()
        .map(|store| store.subscribe_revocations());
    let (close_sender, mut close_receiver) = oneshot::channel::<()>();

    // Only this task owns the WebSocket sender. A revocation asks it to
    // transmit an actual Close frame, not merely drop an mpsc sender clone.
    let mut send_task = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                biased;
                _ = &mut close_receiver => {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
                msg = rx.recv() => msg,
            };
            let Some(msg) = msg else { break; };""")
    one(websocket,
        """    loop {
        tokio::select! {
            // Handle incoming messages""",
        """    let mut revoked = false;
    loop {
        tokio::select! {
            event = async {
                match revocation_events.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            }, if revocation_events.is_some() => {
                let must_close = match event {
                    Ok(agent) => conn_state.authenticated_agent.as_ref() == Some(&agent),
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // A lagged receiver must fail closed if its agent was
                        // revoked, rather than silently skipping a notification.
                        if let (Some(store), Some(agent)) =
                            (&state.auth_store, &conn_state.authenticated_agent)
                        {
                            !store.is_agent_allowed(agent).await
                        } else {
                            false
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => true,
                };
                if must_close {
                    revoked = true;
                    break;
                }
            }
            // Handle incoming messages""")
    one(websocket,
        """    // Cleanup: unregister all agents from the proxy manager""",
        """    if revoked {
        // Close the wire promptly before potentially slow peer cleanup.
        let _ = close_sender.send(());
        if tokio::time::timeout(Duration::from_secs(2), &mut send_task)
            .await.is_err()
        {
            send_task.abort();
        }
    } else {
        send_task.abort();
    }

    // Cleanup: unregister all agents from the proxy manager""")
    one(websocket,
        """    // Wait for send task to complete
    send_task.abort();""",
        """    // The sender task was closed or aborted above, before cleanup.""")

    subprocess.run(["git", "-C", str(repo), "diff", "--check"], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    patch(parser.parse_args().repo.resolve())
