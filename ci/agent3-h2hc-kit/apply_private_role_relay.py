#!/usr/bin/env python3
"""Fail-closed integration of the v1 role-only relay onto the *already patched* H2HC tree.

Applied in CI after security, compiler, regression and revocation patches.
All anchors are single-use assertions; unexpected source drift fails the build.
"""
import argparse
from pathlib import Path
import subprocess


def replace(path, old, new):
    s = path.read_text()
    if s.count(old) != 1:
        raise RuntimeError(f"{path}: expected exactly one anchor, got {s.count(old)}: {old[:80]!r}")
    path.write_text(s.replace(old, new, 1))


def apply(root):
    root = Path(root)
    target = root / "src/routes/private_role.rs"
    if target.exists():
        raise RuntimeError("private_role.rs already exists; refusing double patch")
    target.write_text((Path(__file__).parent / "private_role.rs").read_text())
    replace(root / "src/routes/mod.rs", "pub mod publish;", "pub mod publish;\npub mod private_role;")
    replace(root / "src/auth/types.rs",
        "    /// GET /k2/* endpoints\n    K2,",
        """    /// GET /k2/* endpoints
    K2,
    /// Seated player -> host; operator grants independently of DHT and signals.
    GameRoleRequest,
    /// Host -> one committed-seat recipient; operator grants independently.
    GameRoleDeliver,""")
    agent = root / "src/agent_proxy.rs"
    replace(agent,
        "    /// Find a WebSocket sender for an agent (any DNA).",
        """    /// Require that the recipient is STILL registered to this exact socket,
    /// not another/new socket with the same identity after a reconnect.
    pub async fn is_current_sender(
        &self, dna_hash: &DnaHash, agent_pubkey: &AgentPubKey, sender: &WsSender,
    ) -> bool {
        let key = AgentRegistration {
            dna_hash: dna_hash.clone(), agent_pubkey: agent_pubkey.clone(),
        };
        self.registrations.read().await.get(&key)
            .is_some_and(|active| active.same_channel(sender))
    }

    /// Find a WebSocket sender for an agent (any DNA).""")
    auth = root / "src/auth/store.rs"
    replace(auth, "use tokio::sync::{broadcast, RwLock};",
        "use tokio::sync::{broadcast, Mutex, RwLock};")
    replace(auth,
        "    revocations: broadcast::Sender<AgentPubKey>,",
        """    revocations: broadcast::Sender<AgentPubKey>,
    // Serialize final private dispatch against administrator revocation.
    role_dispatch_gate: Arc<Mutex<()>>,""")
    replace(auth, "            revocations,",
        "            revocations,\n            role_dispatch_gate: Arc::new(Mutex::new(())),")
    replace(auth,
        "    pub async fn remove_agent(&self, agent_pubkey: &AgentPubKey) -> bool {",
        """    pub async fn remove_agent(&self, agent_pubkey: &AgentPubKey) -> bool {
        let _dispatch_gate = self.role_dispatch_gate.lock().await;""")
    replace(auth,
        "    pub async fn revoke_session(&self, token: &str) -> bool {",
        """    pub async fn revoke_session(&self, token: &str) -> bool {
        let _dispatch_gate = self.role_dispatch_gate.lock().await;""")
    replace(auth,
        "    pub async fn revoke_sessions_for_agent(&self, agent_pubkey: &AgentPubKey) -> usize {",
        """    pub async fn revoke_sessions_for_agent(&self, agent_pubkey: &AgentPubKey) -> usize {
        let _dispatch_gate = self.role_dispatch_gate.lock().await;""")
    replace(auth, "    // --- WS connection tracking (always in-memory) ---",
        """    /// Only authenticated in-memory dispatch uses this lock. Never persist queued roles.
    pub fn role_dispatch_gate(&self) -> Arc<Mutex<()>> {
        self.role_dispatch_gate.clone()
    }

    // --- WS connection tracking (always in-memory) ---""")
    ws = root / "src/routes/websocket.rs"
    replace(ws, "use crate::agent_proxy::WsSender;",
        "use crate::agent_proxy::WsSender;\nuse crate::routes::private_role::{self, RoleEnvelope, RoleOperation};")
    replace(ws, "use std::convert::TryFrom;", "use std::convert::TryFrom;\nuse std::sync::Arc;")
    replace(ws, "use tokio::sync::{broadcast, mpsc, oneshot};",
        "use tokio::sync::{broadcast, mpsc, oneshot, RwLock};")
    replace(ws,
        "    /// Send remote signals to target agents via kitsune2.",
        """    /// Restricted, signed and HPKE-encrypted; never a remote zome call.
    RoleRequestV1 {
        envelope: RoleEnvelope,
        signature: String,
    },
    /// Restricted host-to-seat ciphertext only.
    RoleDeliveryV1 {
        envelope: RoleEnvelope,
        signature: String,
    },
    /// Send remote signals to target agents via kitsune2.""")
    replace(ws,
        "    /// Pong response to ping. Includes network peer count.",
        """    /// Queued to an authenticated live socket, not an application receipt.
    RoleQueuedV1 { message_id: String },
    RoleRequestV1 {
        envelope: RoleEnvelope,
        signature: String,
        #[serde(skip_serializing)]
        origin_token: String,
        #[serde(skip_serializing)]
        origin_wire: WsSender,
    },
    RoleDeliveryV1 {
        envelope: RoleEnvelope,
        signature: String,
        #[serde(skip_serializing)]
        origin_token: String,
        #[serde(skip_serializing)]
        origin_wire: WsSender,
    },
    /// Pong response to ping. Includes network peer count.""")
    replace(ws,
        "    authenticated_agent: Option<AgentPubKey>,",
        """    authenticated_agent: Option<AgentPubKey>,
    // Token is NEVER serialized or sent on the recipient's wire.
    session_token: Option<String>,""")
    replace(ws, "            authenticated_agent: None,",
        "            authenticated_agent: None,\n            session_token: None,")
    replace(ws,
        "    // Subscribe BEFORE the first auth message to avoid missing a revoke",
        """    // Current *socket-specific* token; queued relays cannot follow reauth to a new socket.
    let active_session = Arc::new(RwLock::new(None::<String>));
    let active_session_send = active_session.clone();
    let dispatch_app = state.clone();
    let dispatch_sender = tx.clone();

    // Subscribe BEFORE the first auth message to avoid missing a revoke""")
    replace(ws,
        "            let json = match serde_json::to_string(&msg) {",
        """            // For queued private messages, the lock is held THROUGH the actual
            // socket write, so an administrative remove cannot race between
            // permission recheck and the wire send. The token is never serialized.
            let _dispatch_guard = match &msg {
                ServerMessage::RoleRequestV1 { envelope, origin_token, origin_wire, .. }
                | ServerMessage::RoleDeliveryV1 { envelope, origin_token, origin_wire, .. } => {
                    let Some(store) = dispatch_app.auth_store.as_ref() else { continue };
                    let guard = store.role_dispatch_gate().lock_owned().await;
                    let op = if matches!(&msg, ServerMessage::RoleRequestV1 { .. }) {
                        RoleOperation::Request
                    } else { RoleOperation::Delivery };
                    let Some(token) = active_session_send.read().await.clone() else { continue };
                    if !private_role::can_dispatch(
                        &dispatch_app, &token, &dispatch_sender, origin_token, origin_wire, envelope, op,
                    ).await { continue; }
                    Some(guard)
                }
                _ => None,
            };\n            let json = match serde_json::to_string(&msg) {""")
    replace(ws,
        "                    Some(Ok(Message::Text(text))) => {",
        """                    Some(Ok(Message::Text(text))) => {
                        if text.len() > private_role::MAX_FRAME_BYTES {
                            let _ = tx.send(ServerMessage::Error {
                                message: "frame_too_large".into(),
                            }).await;
                            continue;
                        }""")
    replace(ws, '                                tracing::debug!(?client_msg, "Received WebSocket message");',
        '                                tracing::debug!("Received WebSocket message");')
    replace(ws,
        "                                if let Some(resp) = response {",
        """                                // Update only on signed authentication; never use an
                                // unauthenticated client-provided session token.
                                *active_session.write().await = conn_state.session_token.clone();
                                if let Some(resp) = response {""")
    replace(ws,
        "        ClientMessage::Ping => {",
        """        ClientMessage::RoleRequestV1 { envelope, signature } => {
            let result = private_role::queue_role(
                app_state, private_role::RoleSocketContext {
                    agent: state.authenticated_agent.as_ref(),
                    token: state.session_token.as_deref(),
                    wire: sender,
                    registrations: &state.registrations,
                },
                envelope, signature, RoleOperation::Request,
            ).await;
            Some(match result {
                Ok(message_id) => ServerMessage::RoleQueuedV1 { message_id },
                Err(code) => ServerMessage::Error { message: code.into() },
            })
        }

        ClientMessage::RoleDeliveryV1 { envelope, signature } => {
            let result = private_role::queue_role(
                app_state, private_role::RoleSocketContext {
                    agent: state.authenticated_agent.as_ref(),
                    token: state.session_token.as_deref(),
                    wire: sender,
                    registrations: &state.registrations,
                },
                envelope, signature, RoleOperation::Delivery,
            ).await;
            Some(match result {
                Ok(message_id) => ServerMessage::RoleQueuedV1 { message_id },
                Err(code) => ServerMessage::Error { message: code.into() },
            })
        }

        ClientMessage::Ping => {""")
    replace(ws,
        "            if sender.send(Message::Text(json.into())).await.is_err() {",
        """            // A stalled socket cannot hold the administrative revoke lock forever.
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), sender.send(Message::Text(json.into()))).await,
                Ok(Ok(()))
            ) {""")
    replace(ws,
        "    state.authenticated_agent = Some(agent.clone());",
        "    state.authenticated_agent = Some(agent.clone());\n    state.session_token = Some(session_token.as_str().to_string());")
    subprocess.run(["git", "-C", str(root), "diff", "--check"], check=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", type=Path, required=True)
    apply(p.parse_args().repo.resolve())
