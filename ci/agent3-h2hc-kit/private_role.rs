//! Restricted, ephemeral and ciphertext-only role relay. No zome execution.
use crate::agent_proxy::WsSender;
use crate::auth::Capability;
use crate::service::AppState;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use holochain_types::prelude::{ActionHash, AgentPubKey, DnaHash};
use serde::{Deserialize, Serialize};
use std::convert::TryFrom;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_FRAME_BYTES: usize = 8192;
const MAX_CIPHERTEXT_BYTES: usize = 4096;
const MAX_LIFETIME_MS: u64 = 60_000;
const FUTURE_SKEW_MS: u64 = 30_000;
const DOMAIN: &str = "imposter.h2hc.private-role.v1";
const SIGN_PREFIX: &[u8] = b"IMPOSTER-H2HC-ROLE-SIGNED\0\x01";
const AAD_PREFIX: &[u8] = b"IMPOSTER-H2HC-ROLE-AAD\0\x01";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleOperation {
    Request,
    Delivery,
}
impl RoleOperation {
    pub fn capability(self) -> Capability {
        match self {
            Self::Request => Capability::GameRoleRequest,
            Self::Delivery => Capability::GameRoleDeliver,
        }
    }
    fn byte(self) -> u8 {
        match self { Self::Request => 1, Self::Delivery => 2 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleEnvelope {
    pub version: u8,
    pub domain: String,
    pub dna_hash: String,
    pub sender_agent: String,
    pub recipient_agent: String,
    pub role_commit: String,
    pub seat: u16,
    pub recipient_key_id: String,
    pub message_id: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    pub hpke_enc: String,
    pub ciphertext: String,
}

pub struct VerifiedRole {
    pub dna: DnaHash,
    pub sender: AgentPubKey,
    pub recipient: AgentPubKey,
}

fn raw_hash(s: &str) -> Result<[u8; 39], &'static str> {
    let data = s.strip_prefix('u').ok_or("hash_encoding")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data).map_err(|_| "hash_encoding")?;
    bytes.try_into().map_err(|_| "hash_size")
}
fn hex16(s: &str) -> Result<[u8; 16], &'static str> {
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("invalid_identifier");
    }
    let b = hex::decode(s).map_err(|_| "invalid_identifier")?;
    b.try_into().map_err(|_| "invalid_identifier")
}
fn b64(s: &str, min: usize, max: usize) -> Result<Vec<u8>, &'static str> {
    if s.len() > max.div_ceil(3) * 4 + 4 {
        return Err("payload_size");
    }
    let decoded = base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| "base64")?;
    if decoded.len() < min || decoded.len() > max
        || base64::engine::general_purpose::STANDARD.encode(&decoded) != s {
        return Err("payload_size");
    }
    Ok(decoded)
}
fn now_ms() -> Result<u64, &'static str> {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "clock")?.as_millis();
    u64::try_from(ms).map_err(|_| "clock")
}

impl RoleEnvelope {
    // Fixed-length, typed, byte-for-byte canonical header. Never sign JSON.
    fn header(&self, op: RoleOperation) -> Result<Vec<u8>, &'static str> {
        if self.version != 1 || self.domain != DOMAIN { return Err("version_or_domain"); }
        let dna = DnaHash::try_from(self.dna_hash.as_str()).map_err(|_| "dna_hash")?;
        let sender = AgentPubKey::try_from(self.sender_agent.as_str()).map_err(|_| "sender_agent")?;
        let recipient = AgentPubKey::try_from(self.recipient_agent.as_str()).map_err(|_| "recipient_agent")?;
        let commit = ActionHash::try_from(self.role_commit.as_str()).map_err(|_| "role_commit")?;
        if dna.to_string() != self.dna_hash || sender.to_string() != self.sender_agent
            || recipient.to_string() != self.recipient_agent || commit.to_string() != self.role_commit {
            return Err("noncanonical_hash");
        }
        let mut out = Vec::with_capacity(250);
        out.push(op.byte());
        out.extend_from_slice(&raw_hash(&self.dna_hash)?);
        out.extend_from_slice(&raw_hash(&self.sender_agent)?);
        out.extend_from_slice(&raw_hash(&self.recipient_agent)?);
        out.extend_from_slice(&raw_hash(&self.role_commit)?);
        out.extend_from_slice(&self.seat.to_be_bytes());
        out.extend_from_slice(&hex16(&self.recipient_key_id)?);
        out.extend_from_slice(&hex16(&self.message_id)?);
        out.extend_from_slice(&self.created_at_ms.to_be_bytes());
        out.extend_from_slice(&self.expires_at_ms.to_be_bytes());
        match &self.in_reply_to {
            None => out.push(0),
            Some(id) => { out.push(1); out.extend_from_slice(&hex16(id)?); }
        }
        Ok(out)
    }
    pub fn aad_bytes(&self, op: RoleOperation) -> Result<Vec<u8>, &'static str> {
        let mut b = AAD_PREFIX.to_vec();
        b.extend_from_slice(&self.header(op)?);
        Ok(b)
    }
    pub fn signed_bytes(&self, op: RoleOperation) -> Result<Vec<u8>, &'static str> {
        let mut b = SIGN_PREFIX.to_vec();
        b.extend_from_slice(&self.header(op)?);
        b.extend_from_slice(&b64(&self.hpke_enc, 32, 32)?);
        let ciphertext = b64(&self.ciphertext, 16, MAX_CIPHERTEXT_BYTES)?;
        b.extend_from_slice(&u32::try_from(ciphertext.len()).map_err(|_| "payload_size")?.to_be_bytes());
        b.extend_from_slice(&ciphertext);
        Ok(b)
    }
    pub fn verify(&self, op: RoleOperation, sig_b64: &str) -> Result<VerifiedRole, &'static str> {
        let now = now_ms()?;
        if self.created_at_ms > now.saturating_add(FUTURE_SKEW_MS)
            || self.expires_at_ms <= now
            || self.expires_at_ms <= self.created_at_ms
            || self.expires_at_ms - self.created_at_ms > MAX_LIFETIME_MS {
            return Err("expired_or_invalid_time");
        }
        let dna = DnaHash::try_from(self.dna_hash.as_str()).map_err(|_| "dna_hash")?;
        let sender = AgentPubKey::try_from(self.sender_agent.as_str()).map_err(|_| "sender_agent")?;
        let recipient = AgentPubKey::try_from(self.recipient_agent.as_str()).map_err(|_| "recipient_agent")?;
        let sig = Signature::from_slice(&b64(sig_b64, 64, 64)?).map_err(|_| "signature")?;
        let key = VerifyingKey::from_bytes(sender.get_raw_32().try_into().map_err(|_| "sender_key")?)
            .map_err(|_| "sender_key")?;
        key.verify(&self.signed_bytes(op)?, &sig).map_err(|_| "signature")?;
        Ok(VerifiedRole { dna, sender, recipient })
    }
}

pub async fn queue_role(
    app: &AppState,
    socket_agent: Option<&AgentPubKey>,
    socket_token: Option<&str>,
    socket_sender: &WsSender,
    registrations: &[(DnaHash, AgentPubKey)],
    envelope: RoleEnvelope,
    signature: String,
    op: RoleOperation,
) -> Result<String, &'static str> {
    // Production authentication is mandatory even when the service runs in dev mode.
    let store = app.auth_store.as_ref().ok_or("authentication_required")?;
    let verified = envelope.verify(op, &signature)?;
    if socket_agent != Some(&verified.sender)
        || !registrations.contains(&(verified.dna.clone(), verified.sender.clone())) {
        return Err("sender_cell");
    }
    let token = socket_token.ok_or("authentication_required")?;
    let sender = store.validate_session(token).await.ok_or("sender_session")?;
    if sender.agent_pubkey != verified.sender || !sender.has_dna(&verified.dna)
        || !sender.has_capability(op.capability()) { return Err("sender_permission"); }
    if !store.is_agent_allowed(&verified.sender).await
        || !store.is_agent_allowed(&verified.recipient).await {
        return Err("revoked_or_unknown_agent");
    }
    if !app.agent_proxy.is_registered(&verified.dna, &verified.recipient).await {
        return Err("recipient_offline");
    }
    let id = envelope.message_id.clone();
    let message = match op {
        RoleOperation::Request => super::websocket::ServerMessage::RoleRequestV1 {
            envelope, signature, origin_token: token.to_string(),
            origin_wire: socket_sender.clone(),
        },
        RoleOperation::Delivery => super::websocket::ServerMessage::RoleDeliveryV1 {
            envelope, signature, origin_token: token.to_string(),
            origin_wire: socket_sender.clone(),
        },
    };
    if !app.agent_proxy.send_signal(&verified.dna, &verified.recipient, message).await {
        return Err("recipient_unavailable");
    }
    Ok(id) // queued, NOT delivered, decrypted, applied or persisted
}

pub async fn can_dispatch(
    app: &AppState,
    recipient_token: &str,
    recipient_wire: &WsSender,
    origin_token: &str,
    origin_wire: &WsSender,
    envelope: &RoleEnvelope,
    op: RoleOperation,
) -> bool {
    let Some(store) = &app.auth_store else { return false };
    let Ok(dna) = DnaHash::try_from(envelope.dna_hash.as_str()) else { return false };
    let Ok(sender) = AgentPubKey::try_from(envelope.sender_agent.as_str()) else { return false };
    let Ok(recipient) = AgentPubKey::try_from(envelope.recipient_agent.as_str()) else { return false };
    let (Some(origin), Some(target)) = (
        store.validate_session(origin_token).await,
        store.validate_session(recipient_token).await
    ) else { return false };
    if origin.agent_pubkey != sender || target.agent_pubkey != recipient
        || !origin.has_dna(&dna) || !target.has_dna(&dna)
        || !origin.has_capability(op.capability())
        || !store.is_agent_allowed(&sender).await || !store.is_agent_allowed(&recipient).await
        || !app.agent_proxy.is_current_sender(&dna, &recipient, recipient_wire).await
        || !app.agent_proxy.is_current_sender(&dna, &sender, origin_wire).await { 
        return false;
    }
    now_ms().is_ok_and(|ms| ms < envelope.expires_at_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_bytes_are_domain_separated() {
        assert_ne!(SIGN_PREFIX, AAD_PREFIX);
        assert_ne!(RoleOperation::Request.byte(), RoleOperation::Delivery.byte());
    }
    #[test]
    fn bad_hash_or_size_rejected() {
        assert!(raw_hash("uAAAA").is_err());
        assert!(hex16("ABCDEF0123456789ABCDEF0123456789").is_err());
        assert!(b64("AA==",16,4096).is_err());
        assert!(b64("not_base64",32,32).is_err());
    }

    #[tokio::test]
    async fn pending_revocation_drops_stale_role_and_keeps_third_identity() {
        use crate::agent_proxy::AgentProxyManager;
        use crate::auth::{AllowedAgent, AuthStore};
        use crate::config::Configuration;
        use crate::routes::kitsune::KitsuneState;
        use std::collections::HashSet;
        use std::sync::Arc;
        use tokio::sync::mpsc;

        let dna = DnaHash::from_raw_32(vec![5; 32]);
        let a = AgentPubKey::from_raw_32(vec![27; 32]);
        let b = AgentPubKey::from_raw_32(vec![28; 32]);
        let c = AgentPubKey::from_raw_32(vec![29; 32]);
        let auth = AuthStore::new();
        for (agent, caps) in [
            (a.clone(), vec![Capability::GameRoleDeliver]),
            (b.clone(), vec![Capability::GameRoleRequest]),
            (c.clone(), vec![Capability::GameRoleRequest]),
        ] {
            auth.add_agent(AllowedAgent {
                agent_pubkey: agent, capabilities: caps.into_iter().collect::<HashSet<_>>(),
                label: None,
            }).await;
        }
        let old_a = auth.create_session(&a).await.unwrap();
        let token_b = auth.create_session(&b).await.unwrap();
        let token_c = auth.create_session(&c).await.unwrap();
        for agent in [&a, &b, &c] {
            auth.register_dna_for_agent(agent, &dna).await;
        }
        let proxy = AgentProxyManager::new();
        let (recipient_tx, _recipient_rx) = mpsc::channel(8);
        proxy.register(dna.clone(), b.clone(), recipient_tx.clone()).await;
        let (origin_tx, _origin_rx) = mpsc::channel(8);
        proxy.register(dna.clone(), a.clone(), origin_tx.clone()).await;
        let app = AppState {
            configuration: Configuration::default(),
            agent_proxy: proxy, gateway_kitsune: None,
            kitsune_state: Arc::new(KitsuneState {
                enabled: false, bootstrap_url: None, relay_url: None, kitsune: None,
            }),
            app_conn: None, temp_op_store: None, dht_query: None,
            auth_store: Some(auth.clone()),
        };
        let now = now_ms().unwrap();
        let env = RoleEnvelope {
            version: 1, domain: DOMAIN.into(),
            dna_hash: dna.to_string(), sender_agent: a.to_string(),
            recipient_agent: b.to_string(),
            role_commit: ActionHash::from_raw_32(vec![88; 32]).to_string(),
            seat: 1, recipient_key_id: "11".repeat(16),
            message_id: "22".repeat(16),
            created_at_ms: now, expires_at_ms: now + 30_000,
            in_reply_to: None, hpke_enc: "AA==".into(), ciphertext: "AA==".into(),
        };
        assert!(can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&env,RoleOperation::Delivery).await);
        assert!(!can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&env,RoleOperation::Request).await);
        let mut wrong_dna = env.clone();
        wrong_dna.dna_hash = DnaHash::from_raw_32(vec![6;32]).to_string();
        assert!(!can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&wrong_dna,RoleOperation::Delivery).await);
        let mut wrong_recipient = env.clone();
        wrong_recipient.recipient_agent = c.to_string();
        assert!(!can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&wrong_recipient,RoleOperation::Delivery).await);

        // Connection replacement is NOT a license to deliver an older frame,
        // even while the original bearer still validates.
        let (replacement_tx, _replacement_rx) = mpsc::channel(8);
        app.agent_proxy.register(dna.clone(), a.clone(), replacement_tx).await;
        assert!(!can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&env,RoleOperation::Delivery).await);
        app.agent_proxy.register(dna.clone(), a.clone(), origin_tx.clone()).await;

        // Deterministic race: an in-flight private dispatch holds exactly the
        // same gate as administrative revocation. No old lease survives release.
        let hold = auth.role_dispatch_gate().lock_owned().await;
        let revoker = {
            let store = auth.clone();
            let target = a.clone();
            tokio::spawn(async move { store.remove_agent(&target).await })
        };
        tokio::task::yield_now().await;
        assert!(!revoker.is_finished(), "revocation must serialize after the pending send");
        drop(hold);
        assert!(revoker.await.unwrap());
        assert!(!can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&env,RoleOperation::Delivery).await);
        assert!(auth.validate_session(token_b.as_str()).await.is_some());
        assert!(auth.validate_session(token_c.as_str()).await.is_some());

        auth.add_agent(AllowedAgent {
            agent_pubkey: a.clone(),
            capabilities: HashSet::from([Capability::GameRoleDeliver]),
            label: None,
        }).await;
        let fresh_a = auth.create_session(&a).await.unwrap();
        auth.register_dna_for_agent(&a, &dna).await;
        assert!(!can_dispatch(&app,token_b.as_str(),&recipient_tx,old_a.as_str(),&origin_tx,&env,RoleOperation::Delivery).await);
        assert!(can_dispatch(&app,token_b.as_str(),&recipient_tx,fresh_a.as_str(),&origin_tx,&env,RoleOperation::Delivery).await);
    }
}
