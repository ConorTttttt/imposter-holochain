//! Public, revision-2 H2HC recipient encryption-key attestations.
//! Signature transcript is frozen by Agent 2/3; entry serialization is NOT signed.
use super::*;

#[hdk_entry_helper]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct RecipientKeyAttestation {
    pub dna: DnaHash,
    pub agent: AgentPubKey,
    pub key_id: [u8; 16],
    pub x25519_public_key: [u8; 32],
    pub epoch: u64,
    pub not_before_ms: u64,
    pub not_after_ms: u64,
    pub signature: Signature,
}

/// EXACT candidate rev-2 attestation transcript. DO NOT sign serialized entries.
pub fn recipient_key_transcript(a: &RecipientKeyAttestation) -> Vec<u8> {
    let mut bytes = b"IMPOSTER-H2HC-ROLE-KEY\x00\x01".to_vec();
    bytes.extend_from_slice(a.dna.get_raw_39());
    bytes.extend_from_slice(a.agent.get_raw_39());
    bytes.extend_from_slice(&a.key_id);
    bytes.extend_from_slice(&a.x25519_public_key);
    bytes.extend_from_slice(&a.epoch.to_be_bytes());
    bytes.extend_from_slice(&a.not_before_ms.to_be_bytes());
    bytes.extend_from_slice(&a.not_after_ms.to_be_bytes());
    bytes
}

/// Never mistake arbitrary deserializable DHT bytes for an entry of our type.
pub fn attestation_from_record(r: &Record) -> ExternResult<Option<RecipientKeyAttestation>> {
    let ActionData::Create(c) = &r.action().data else { return Ok(None) };
    let EntryType::App(def) = &c.entry_type else { return Ok(None) };
    let Some(entry) = r.entry().as_option() else { return Ok(None) };
    Ok(match EntryTypes::deserialize_from_type(def.zome_index, def.entry_index, entry)? {
        Some(EntryTypes::RecipientKeyAttestation(a)) => Some(a),
        _ => None,
    })
}

pub fn validate_recipient_key(
    a: RecipientKeyAttestation, author: &AgentPubKey, at: Timestamp
) -> ExternResult<ValidateCallbackResult> {
    if a.agent != *author { return invalid("recipient key author must be the attested agent"); }
    if a.dna != dna_info()?.hash { return invalid("recipient key DNA differs from installed DNA"); }
    if a.epoch == 0 || a.key_id == [0; 16] || a.x25519_public_key == [0; 32] {
        return invalid("invalid key identifier, epoch or X25519 key");
    }
    const MAX_LIFETIME_MS: u64 = 30 * 24 * 60 * 60 * 1000;
    if a.not_after_ms <= a.not_before_ms ||
       a.not_after_ms - a.not_before_ms > MAX_LIFETIME_MS {
        return invalid("invalid recipient key validity interval");
    }
    let created = at.as_millis();
    if created < 0 || a.not_after_ms <= created as u64 ||
       a.not_before_ms > (created as u64).saturating_add(30_000) {
        return invalid("recipient key validity is not current at creation");
    }
    if !verify_signature_raw(a.agent.clone(), a.signature.clone(), recipient_key_transcript(&a))? {
        return invalid("bad Lair Ed25519 recipient key signature");
    }
    valid()
}

pub fn validate_recipient_key_link(
    action: &TypedAction<CreateLinkData>
) -> ExternResult<ValidateCallbackResult> {
    if action.base_address != AnyLinkableHash::from(action.author().clone()) ||
       !action.tag.clone().into_inner().is_empty() {
        return invalid("recipient key index must be from its author with an empty tag");
    }
    let Some(target) = action.target_address.clone().into_action_hash() else {
        return invalid("recipient key index target must be an action");
    };
    let record = must_get_valid_record(target)?;
    let Some(a) = attestation_from_record(&record)? else {
        return invalid("recipient key index target has wrong native entry type");
    };
    if record.action().author() != action.author() || a.agent != *action.author() {
        return invalid("recipient key index cannot claim another agent");
    }
    validate_recipient_key(a, action.author(), record.action().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcript_has_fixed_raw_hash_offsets_and_be_epoch() {
        let a = RecipientKeyAttestation {
            dna: DnaHash::from_raw_32(vec![5; 32]),
            agent: AgentPubKey::from_raw_32(vec![6; 32]),
            key_id: [7; 16], x25519_public_key: [8; 32],
            epoch: 0x0102_0304_0506_0708, not_before_ms: 9, not_after_ms: 10,
            signature: Signature([0; 64]),
        };
        let b = recipient_key_transcript(&a);
        assert_eq!(&b[..24], b"IMPOSTER-H2HC-ROLE-KEY\x00\x01");
        assert_eq!(&b[24..63], a.dna.get_raw_39());
        assert_eq!(&b[63..102], a.agent.get_raw_39());
        assert_eq!(&b[102..118], &[7;16]);
        assert_eq!(&b[118..150], &[8;32]);
        assert_eq!(&b[150..158], &a.epoch.to_be_bytes());
        assert_eq!(b.len(), 174);
    }
}
