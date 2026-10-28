//! Initial in-process H2HC bootstrap, based on the pinned Holochain-mobile
//! conductor (0.7.1). Feature-gated until its patched crate tree is ready.
//!
//! This module deliberately only provides bootstrap/install/resume. No web
//! command attaches this as a READY backend until clone, zome and signal
//! contracts have been validated against Imposter on a real H2HC network.
#![cfg(feature = "h2hc-runtime")]

use base64::Engine;
use h2hc_conductor::{build_phone_conductor, Connector, H2hcOptions};
use h2hc_protocol::LinkerId;
use holochain::conductor::config::{ConductorConfig, KeystoreConfig, WasmBackend};
use holochain::conductor::ConductorHandle;
use holochain::prelude::*;
use holochain_conductor_api::CellInfo;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const APP_ID: &str = "imposter";

pub(crate) struct H2hcStartup {
    pub data_root: PathBuf,
    pub app_bundle: PathBuf,
    pub linker_url: String,
    pub linker_public_key_b64: String,
    /// Caller supplies non-demo app-private material from an Android keystore.
    pub keystore_passphrase: Vec<u8>,
}

pub(crate) struct H2hcStarted {
    pub conductor: ConductorHandle,
    pub agent: AgentPubKey,
    pub provisioned_cell: CellId,
}

impl H2hcStartup {
    pub(crate) async fn open(self) -> Result<H2hcStarted, String> {
        // Production must use authenticated wss and a pinned linker key.
        // Plain ws is only supported on loopback for local integration tests.
        if !(self.linker_url.starts_with("wss://")
            || self.linker_url.starts_with("ws://127.0.0.1:")
            || self.linker_url.starts_with("ws://[::1]:"))
        {
            return Err("H2HC requires WSS (or local-loopback test URL)".into());
        }
        let raw = base64::engine::general_purpose::STANDARD
            .decode(self.linker_public_key_b64)
            .map_err(|_| "invalid linker public key encoding")?;
        let key: [u8; 32] = raw.try_into()
            .map_err(|_| "linker public key must be 32 bytes")?;
        if self.keystore_passphrase.len() < 32 {
            return Err("missing secure keystore unlock material".into());
        }
        let bytes = std::fs::read(&self.app_bundle).map_err(|e| format!("missing Imposter hApp: {e}"))?;
        std::fs::create_dir_all(&self.data_root).map_err(|e| e.to_string())?;
        let config = ConductorConfig {
            data_root_path: Some(self.data_root.into()),
            keystore: KeystoreConfig::LairServerInProc { lair_root: None },
            wasm_backend: Some(WasmBackend::Wasmi),
            ..Default::default()
        };
        let passphrase = Arc::new(Mutex::new(sodoken::LockedArray::from(self.keystore_passphrase)));
        let linker_url = self.linker_url;
        let connector: Connector = Arc::new(move || {
            let url = linker_url.clone();
            Box::pin(async move {
                h2hc_p2p::ws::connect(&url, Arc::new(h2hc_p2p::ws::WsCounters::default())).await
            })
        });
        let conductor = build_phone_conductor(
            config, passphrase, connector,
            H2hcOptions { expected_linker: Some(LinkerId(key)), ..Default::default() },
        ).await.map_err(|e| e.to_string())?;

        // Enabling is idempotent. If the same private data root is reopened,
        // reuse its agent instead of installing another app with a new key.
        if conductor.get_app_info(&APP_ID.to_string()).await.map_err(|e| e.to_string())?.is_none() {
            conductor.clone().install_app_bundle(InstallAppPayload {
                source: AppBundleSource::Bytes(bytes.into()),
                agent_key: None,
                installed_app_id: Some(APP_ID.into()),
                network_seed: None,
                roles_settings: None,
                ignore_genesis_failure: false,
                restore_from_dht: false,
            }).await.map_err(|e| e.to_string())?;
        }
        conductor.clone().enable_app(APP_ID.into()).await.map_err(|e| e.to_string())?;
        let info = conductor.get_app_info(&APP_ID.to_string())
            .await.map_err(|e| e.to_string())?
            .ok_or("Imposter installation is missing after enable")?;
        let base = info.cell_info.get("game").ok_or("Imposter hApp has no game role")?
            .iter().find_map(|cell| match cell {
                CellInfo::Provisioned(p) => Some(p.cell_id.clone()),
                _ => None,
            }).ok_or("Imposter has no provisioned game cell")?;
        Ok(H2hcStarted { conductor, agent: info.agent_pub_key, provisioned_cell: base })
    }
}
