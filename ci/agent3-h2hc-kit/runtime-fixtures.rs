//! Reproducible, synthetic, non-deployable 0.7 action/Ed25519 network fixture.
//! The output contains private TEST keys. Never upload fixtures.json as an artifact.
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use holo_hash::{ActionHash, AgentPubKey, DnaHash, HashableContentExtSync};
use holochain_types::prelude::{
    Action, ActionData, ActionHeader, ChainOp, DhtOp, DnaData, Signature, SignedAction, Timestamp,
};
fn main() {
    let dna = DnaHash::from_raw_32(vec![5; 32]);
    let other_dna = DnaHash::from_raw_32(vec![6; 32]);
    let encode = |op: &DhtOp| {
        base64::engine::general_purpose::STANDARD
            .encode(holochain_serialized_bytes::encode(op).expect("encode op"))
    };
    let mut agents = Vec::new();
    for (label, seed) in [("A", 27u8), ("B", 28u8), ("C-unauthorized", 29u8)] {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let author = AgentPubKey::from_raw_32(key.verifying_key().to_bytes().to_vec());
        let action = Action {
            header: ActionHeader {
                author: author.clone(),
                timestamp: Timestamp::from_micros(100),
                action_seq: 0,
                prev_action: None,
            },
            data: ActionData::Dna(DnaData { dna_hash: dna.clone() }),
        };
        let signature = key.sign(&holochain_serialized_bytes::encode(&action).expect("encode action"));
        let signed = SignedAction::new(action.clone(), Signature::from(signature.to_bytes()));
        let op = DhtOp::from(ChainOp::AgentActivity(signed));
        let wrapper = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        let attacker = SigningKey::from_bytes(&[43; 32]);
        let fake_signature = attacker.sign(&holochain_serialized_bytes::encode(&action).expect("encode"));
        let fake_signed = SignedAction::new(action.clone(), Signature::from(fake_signature.to_bytes()));
        let forged_op = DhtOp::from(ChainOp::AgentActivity(fake_signed));
        agents.push(serde_json::json!({
            "label": label,
            "agent": author.to_string(),
            "seed_hex": hex::encode([seed; 32]),
            "action_hash": ActionHash::with_data_sync(&action).to_string(),
            "op": { "op_data": encode(&op), "signature": wrapper },
            "forged": {
                "op_data": encode(&forged_op),
                "signature": base64::engine::general_purpose::STANDARD.encode(fake_signature.to_bytes()),
            },
        }));
    }
    println!("{}", serde_json::json!({
        "dna": dna.to_string(),
        "other_dna": other_dna.to_string(),
        "agents": agents,
        "fixture_only": true
    }));
}
