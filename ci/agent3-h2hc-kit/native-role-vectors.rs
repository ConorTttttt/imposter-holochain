//! Native Holochain 0.7 hash construction and independent Ed25519 verification.
//! This fixture's private seeds are deterministic TEST VALUES only; never deploy.
use base64::Engine;
use ed25519_dalek::{SigningKey, Verifier, VerifyingKey};
use h2hc_linker::routes::private_role::{RoleEnvelope, RoleOperation};
use holo_hash::{ActionHash, AgentPubKey, DnaHash};
use std::fs;

fn key(seed: u8) -> AgentPubKey {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    AgentPubKey::from_raw_32(sk.verifying_key().to_bytes().to_vec())
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--hashes") {
        println!("{}", serde_json::json!({
            "dna": DnaHash::from_raw_32(vec![5; 32]).to_string(),
            "agent_a": key(27).to_string(),
            "agent_b": key(28).to_string(),
            "agent_c": key(29).to_string(),
            "commit": ActionHash::from_raw_32(vec![88; 32]).to_string(),
            "fixture_only": true
        }));
        return;
    }
    let path = args.get(1).expect("expected public signed-vector fixture path");
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(path).expect("read fixture")).expect("json");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 2, "exactly the two authorized operations");
    for case in cases {
        let env: RoleEnvelope = serde_json::from_value(case["envelope"].clone()).expect("envelope");
        let (op, expected_seed) = match case["operation"].as_str().unwrap() {
            "role_request_v1" => (RoleOperation::Request, 28),
            "role_delivery_v1" => (RoleOperation::Delivery, 27),
            _ => panic!("unsupported operation"),
        };
        let transcript = env.signed_bytes(op).expect("native canonical signed bytes");
        let aad = env.aad_bytes(op).expect("native canonical AAD bytes");
        assert_eq!(hex::encode(&transcript), case["signed_bytes_hex"].as_str().unwrap());
        assert_eq!(hex::encode(&aad), case["aad_hex"].as_str().unwrap());
        let sender = key(expected_seed);
        assert_eq!(env.sender_agent, sender.to_string());
        let signature = base64::engine::general_purpose::STANDARD
            .decode(case["signature_b64"].as_str().unwrap()).unwrap();
        let signature = ed25519_dalek::Signature::from_slice(&signature).unwrap();
        let verifying_key = VerifyingKey::from_bytes(
            sender.get_raw_32().try_into().expect("Holochain agent core")
        ).unwrap();
        verifying_key.verify(&transcript, &signature).expect("native Holochain 0.7 verification");
        assert!(verifying_key.verify(&env.signed_bytes(if op == RoleOperation::Request {
            RoleOperation::Delivery
        } else { RoleOperation::Request }).unwrap(), &signature).is_err(),
            "operation must be cryptographically bound");
    }
    println!("NATIVE_HOLOCHAIN_ROLE_VECTORS=PASS; cases=2; no private fixture keys exported");
}
