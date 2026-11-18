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
            "other_dna": DnaHash::from_raw_32(vec![6; 32]).to_string(),
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
        assert_eq!(case["hpke_info_hex"].as_str().unwrap(), hex::encode(b"imposter.h2hc.private-role/hpke-v1"));
        assert_eq!(case["hpke_enc_hex"].as_str().unwrap(), hex::encode(base64::engine::general_purpose::STANDARD.decode(env.hpke_enc.as_str()).unwrap()));
        assert_eq!(case["ciphertext_hex"].as_str().unwrap(), hex::encode(base64::engine::general_purpose::STANDARD.decode(env.ciphertext.as_str()).unwrap()));
        assert!(env.recipient_key_epoch > 0);
        let sender = key(expected_seed);
        assert_eq!(env.sender_agent, sender.to_string());
        let signature = base64::engine::general_purpose::STANDARD
            .decode(case["signature_b64"].as_str().unwrap()).unwrap();
        assert_eq!(hex::encode(&signature), case["signature_hex"].as_str().unwrap());
        let signature = ed25519_dalek::Signature::from_slice(&signature).unwrap();
        let verifying_key = VerifyingKey::from_bytes(
            sender.get_raw_32().try_into().expect("Holochain agent core")
        ).unwrap();
        verifying_key.verify(&transcript, &signature).expect("native Holochain 0.7 verification");
        let mut changed_epoch = env.clone();
        changed_epoch.recipient_key_epoch += 1;
        assert!(verifying_key.verify(&changed_epoch.signed_bytes(op).unwrap(), &signature).is_err(),
            "signed key rotation epoch may not be rewritten");
        let mut changed_recipient = env.clone();
        changed_recipient.recipient_agent = key(29).to_string();
        assert!(verifying_key.verify(&changed_recipient.signed_bytes(op).unwrap(), &signature).is_err(),
            "recipient is bound to sender signature");
        let mut changed_dna = env.clone();
        changed_dna.dna_hash = DnaHash::from_raw_32(vec![6; 32]).to_string();
        assert!(verifying_key.verify(&changed_dna.signed_bytes(op).unwrap(), &signature).is_err(),
            "DNA is bound to sender signature");
        let mut changed_expiry = env.clone();
        changed_expiry.expires_at_ms -= 1;
        assert!(verifying_key.verify(&changed_expiry.signed_bytes(op).unwrap(), &signature).is_err(),
            "expiration is bound to signature");
        if op == RoleOperation::Request {
            let mut invalid_request = env.clone();
            invalid_request.in_reply_to = Some("77".repeat(16));
            assert!(invalid_request.signed_bytes(op).is_err(), "request cannot claim to reply");
        } else {
            let mut bad_reply = env.clone();
            bad_reply.in_reply_to = Some("88".repeat(16));
            assert!(verifying_key.verify(&bad_reply.signed_bytes(op).unwrap(), &signature).is_err(),
                "signed reply reference cannot be mutated");
        }
        assert!(verifying_key.verify(&env.signed_bytes(if op == RoleOperation::Request {
            RoleOperation::Delivery
        } else { RoleOperation::Request }).unwrap(), &signature).is_err(),
            "operation must be cryptographically bound");
    }
    let attestations = file["key_attestations"].as_array().expect("signed key attestations");
    assert_eq!(attestations.len(), 2, "recipient A and recipient B keys");
    for (i, att) in attestations.iter().enumerate() {
        let expected = if i == 0 { key(27) } else { key(28) };
        let dna = DnaHash::from_raw_32(vec![5;32]);
        assert_eq!(att["agent"].as_str().unwrap(), expected.to_string());
        assert_eq!(att["dna_hash"].as_str().unwrap(), dna.to_string());
        assert_eq!(att["epoch"].as_u64().unwrap(), cases[i]["envelope"]["recipient_key_epoch"].as_u64().unwrap());
        let att_bytes = hex::decode(att["signed_bytes_hex"].as_str().unwrap()).unwrap();
        let mut canonical = b"IMPOSTER-H2HC-ROLE-KEY\0\x01".to_vec();
        for h in [dna.to_string(), expected.to_string()] {
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&h[1..]).unwrap();
            assert_eq!(raw.len(),39);
            canonical.extend_from_slice(&raw);
        }
        canonical.extend_from_slice(&hex::decode(att["key_id"].as_str().unwrap()).unwrap());
        canonical.extend_from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(att["x25519_public_key_b64"].as_str().unwrap()).unwrap());
        canonical.extend_from_slice(&att["epoch"].as_u64().unwrap().to_be_bytes());
        canonical.extend_from_slice(&att["not_before_ms"].as_u64().unwrap().to_be_bytes());
        canonical.extend_from_slice(&att["not_after_ms"].as_u64().unwrap().to_be_bytes());
        assert_eq!(att_bytes, canonical, "key attestation field-order and cell binding");
        let sig = base64::engine::general_purpose::STANDARD
            .decode(att["signature_b64"].as_str().unwrap()).unwrap();
        let sig = ed25519_dalek::Signature::from_slice(&sig).unwrap();
        let verify_key = VerifyingKey::from_bytes(
            expected.get_raw_32().try_into().expect("32-byte native Holochain agent key")
        ).unwrap();
        verify_key.verify(&att_bytes,&sig).expect("native Holochain key attestation verifier");
        let wrong = if i == 0 { key(28) } else { key(27) };
        let wrong_verify = VerifyingKey::from_bytes(wrong.get_raw_32().try_into().unwrap()).unwrap();
        assert!(wrong_verify.verify(&att_bytes,&sig).is_err(),"foreign agent key signature denied");
    }
    println!("NATIVE_HOLOCHAIN_KEY_ATTESTATIONS=PASS; cases=2");
    println!("NATIVE_HOLOCHAIN_ROLE_VECTORS=PASS; cases=2; no private fixture keys exported");
}
