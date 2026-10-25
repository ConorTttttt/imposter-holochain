//! Private room registry. No plaintext codes, advertisements, or global index.
use super::*;
use sha2::{Digest, Sha256};

#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoomPointer {
    pub version: u8,
    pub room_code_hash: [u8; 32],
    pub game_seed: String,
    pub host: AgentPubKey,
    pub round: u32,
    pub previous: Option<ActionHash>,
}

pub fn normalize_room_code(code: &str) -> Result<String, String> {
    let code = code
        .trim_matches(|c: char| matches!(c, '\t'..='\r' | ' '))
        .to_ascii_uppercase();
    if !(4..=32).contains(&code.len())
        || !code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        || !code.bytes().any(|b| b.is_ascii_alphanumeric())
    {
        return Err("Invalid room code. Use 4–32 letters, numbers or hyphens.".into());
    }
    Ok(code)
}

pub fn room_code_hash(code: &str) -> Result<[u8; 32], String> {
    let code = normalize_room_code(code)?;
    Ok(Sha256::digest(format!("imposter/private-room/v1:{code}").as_bytes()).into())
}

pub fn room_anchor(hash: &[u8; 32]) -> ExternResult<AnyLinkableHash> {
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    anchor_hash(&format!("private-room-v1.{hex}"))
}

pub fn check_pointer(p: &RoomPointer, author: &AgentPubKey) -> Result<(), String> {
    if p.version != 1 || p.room_code_hash == [0; 32] || p.round == 0 || p.round > 1_000_000 {
        return Err("invalid room pointer identifier, version or round".into());
    }
    if p.game_seed.len() > 150 {
        return Err("room pointer seed is too long".into());
    }
    match parse_game_seed(&p.game_seed)? {
        SeedOwner::Host(host) if host == p.host && host == *author => {}
        _ => return Err("room pointer author must be the game seed host".into()),
    }
    if (p.round == 1) != p.previous.is_none() {
        return Err("room pointer must cite its previous round".into());
    }
    Ok(())
}

/// Check the actual entry type, not just whether bytes deserialize as a pointer.
pub fn pointer_from_record(r: &Record) -> ExternResult<Option<RoomPointer>> {
    let ActionData::Create(c) = &r.action().data else {
        return Ok(None);
    };
    let EntryType::App(def) = &c.entry_type else {
        return Ok(None);
    };
    let Some(entry) = r.entry().as_option() else {
        return Ok(None);
    };
    Ok(
        match EntryTypes::deserialize_from_type(def.zome_index, def.entry_index, entry)? {
            Some(EntryTypes::RoomPointer(p)) => Some(p),
            _ => None,
        },
    )
}

pub fn validate_pointer(
    p: RoomPointer,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if !dna_info()?.modifiers.network_seed.is_empty() {
        return invalid("room pointers belong in the base game cell");
    }
    if let Err(why) = check_pointer(&p, author) {
        return invalid(why);
    }
    if let Some(previous) = &p.previous {
        let r = must_get_valid_record(previous.clone())?;
        let Some(old) = pointer_from_record(&r)? else {
            return invalid("previous round must be a room pointer");
        };
        if old.host != p.host
            || old.room_code_hash != p.room_code_hash
            || old.round + 1 != p.round
            || old.game_seed == p.game_seed
            || r.action().author() != author
        {
            return invalid("previous room pointer has wrong host, room, round or seed");
        }
    }
    valid()
}

pub fn validate_pointer_link(
    a: &TypedAction<CreateLinkData>,
) -> ExternResult<ValidateCallbackResult> {
    if !dna_info()?.modifiers.network_seed.is_empty() {
        return invalid("room pointers belong in the base game cell");
    }
    if !a.tag.clone().into_inner().is_empty() {
        return invalid("room pointer links carry no tag");
    }
    let Some(hash) = a.target_address.clone().into_action_hash() else {
        return invalid("room pointer target must be an action");
    };
    let r = must_get_valid_record(hash)?;
    let Some(p) = pointer_from_record(&r)? else {
        return invalid("room pointer target has wrong entry type");
    };
    if r.action().author() != a.author() || p.host != *a.author() {
        return invalid("only the pointer host may index it");
    }
    if a.base_address != room_anchor(&p.room_code_hash)? {
        return invalid("room pointer base does not match room identifier");
    }
    validate_pointer(p, a.author())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn room_normalization_and_pointer_shapes() {
        assert_eq!(
            room_code_hash("  abcd-12 ").unwrap(),
            room_code_hash("ABCD-12").unwrap()
        );
        for code in [
            "",
            "abc",
            "----",
            "abcd#2",
            "éabc",
            "AB CD",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
        ] {
            assert!(room_code_hash(code).is_err(), "{code}");
        }
        let host = AgentPubKey::from_raw_32(vec![7; 32]);
        let mut p = RoomPointer {
            version: 1,
            room_code_hash: [1; 32],
            game_seed: format!(
                "g1.{}.0123456789abcdef0123456789abcdef",
                AgentPubKeyB64::from(host.clone())
            ),
            host: host.clone(),
            round: 1,
            previous: None,
        };
        assert!(check_pointer(&p, &host).is_ok());
        assert!(check_pointer(&p, &AgentPubKey::from_raw_32(vec![8; 32])).is_err());
        p.game_seed = "room1.ABCD".into();
        assert!(check_pointer(&p, &host).is_err());
        p.game_seed = "x".repeat(151);
        assert!(check_pointer(&p, &host).is_err());
        p.room_code_hash = [0; 32];
        assert!(check_pointer(&p, &host).is_err());
    }
}
