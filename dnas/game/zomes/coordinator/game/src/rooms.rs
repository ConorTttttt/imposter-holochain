use super::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct PublishRoomPointer {
    pub room_code: String,
    pub game_seed: String,
    pub round: u32,
    pub previous: Option<ActionHash>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PointerView {
    pub action: ActionHash,
    pub pointer: RoomPointer,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RoomResolution {
    NotFound,
    Unavailable,
    Conflict,
    Found { current: PointerView },
}

fn registry_only() -> ExternResult<()> {
    if !dna_info()?.modifiers.network_seed.is_empty() {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "room registry requires the base game cell".into()
        )));
    }
    Ok(())
}

/// Local chain query recovers an entry whose indexing link failed. Exact retry
/// uses the same action; a different seed in the same round is refused locally.
#[hdk_extern]
pub fn publish_room_pointer(input: PublishRoomPointer) -> ExternResult<PointerView> {
    registry_only()?;
    let p = RoomPointer {
        version: 1,
        room_code_hash: room_code_hash(&input.room_code)
            .map_err(|e| wasm_error!(WasmErrorInner::Guest(e)))?,
        game_seed: input.game_seed,
        host: me()?,
        round: input.round,
        previous: input.previous,
    };
    check_pointer(&p, &p.host).map_err(|e| wasm_error!(WasmErrorInner::Guest(e)))?;
    let mut existing = None;
    for r in query(ChainQueryFilter::new().include_entries(true))? {
        if let Some(old) = pointer_from_record(&r)? {
            if old.room_code_hash == p.room_code_hash && old.round == p.round {
                if old != p {
                    return Err(wasm_error!(WasmErrorInner::Guest(
                        "this room round already references a different game".into()
                    )));
                }
                existing = Some(r.action_address().clone());
            }
        }
    }
    let action = match existing {
        Some(h) => h,
        None => create_entry(EntryTypes::RoomPointer(p.clone()))?,
    };
    let base = room_anchor(&p.room_code_hash)?;
    let links = get_links(
        LinkQuery::try_new(base.clone(), LinkTypes::RoomToPointer)?,
        GetStrategy::Network,
    )?;
    if !links
        .iter()
        .any(|l| l.target == AnyLinkableHash::from(action.clone()))
    {
        create_link(base, action.clone(), LinkTypes::RoomToPointer, ())?;
    }
    Ok(PointerView { action, pointer: p })
}

/// Deterministic for a given visible record set. No timestamp or link order is
/// authoritative. Any host collision or fork of the round chain fails closed.
fn resolve_records(mut records: Vec<PointerView>) -> RoomResolution {
    records.sort_by(|a, b| a.action.cmp(&b.action));
    records.dedup_by(|a, b| a.action == b.action);
    if records.is_empty() {
        return RoomResolution::NotFound;
    }
    let host = &records[0].pointer.host;
    if records.iter().any(|r| &r.pointer.host != host) {
        return RoomResolution::Conflict;
    }
    records.sort_by_key(|r| r.pointer.round);
    if records
        .windows(2)
        .any(|pair| pair[0].pointer.round == pair[1].pointer.round)
    {
        return RoomResolution::Conflict;
    }
    // A temporarily missing index for a predecessor must not select an older game.
    let mut previous: Option<ActionHash> = None;
    let mut round = 0;
    for r in &records {
        if r.pointer.round != round + 1 || r.pointer.previous != previous {
            return RoomResolution::Unavailable;
        }
        previous = Some(r.action.clone());
        round = r.pointer.round;
    }
    RoomResolution::Found {
        current: records.pop().unwrap(),
    }
}

#[hdk_extern]
pub fn resolve_room_pointer(code: String) -> ExternResult<RoomResolution> {
    registry_only()?;
    let hash = room_code_hash(&code).map_err(|e| wasm_error!(WasmErrorInner::Guest(e)))?;
    let links = get_links(
        LinkQuery::try_new(room_anchor(&hash)?, LinkTypes::RoomToPointer)?,
        GetStrategy::Network,
    )?;
    let mut records = Vec::new();
    let mut missing = false;
    for l in links {
        let Some(action) = l.target.into_action_hash() else {
            return Ok(RoomResolution::Unavailable);
        };
        let Some(r) = get(action.clone(), GetOptions::network())? else {
            missing = true;
            continue;
        };
        let Some(pointer) = pointer_from_record(&r)? else {
            return Ok(RoomResolution::Unavailable);
        };
        if pointer.room_code_hash != hash || check_pointer(&pointer, r.action().author()).is_err() {
            return Ok(RoomResolution::Unavailable);
        }
        records.push(PointerView { action, pointer });
    }
    if missing {
        return Ok(RoomResolution::Unavailable);
    }
    Ok(resolve_records(records))
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_room_pointer(p: RoomPointer) -> ExternResult<ActionHash> {
    create_entry(EntryTypes::RoomPointer(p))
}

#[cfg(feature = "forge")]
#[derive(Serialize, Deserialize, Debug)]
pub struct ForgeRoomLink {
    pub base: AnyLinkableHash,
    pub target: AnyLinkableHash,
    pub tag: Vec<u8>,
}
#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_room_link(input: ForgeRoomLink) -> ExternResult<ActionHash> {
    create_link(
        input.base,
        input.target,
        LinkTypes::RoomToPointer,
        LinkTag::new(input.tag),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn view(host: u8, round: u32, previous: Option<ActionHash>) -> PointerView {
        PointerView {
            action: ActionHash::from_raw_32(vec![round as u8 + host; 32]),
            pointer: RoomPointer {
                version: 1,
                room_code_hash: [1; 32],
                game_seed: format!("seed-{round}"),
                host: AgentPubKey::from_raw_32(vec![host; 32]),
                round,
                previous,
            },
        }
    }
    #[test]
    fn resolution_is_order_independent_and_fails_closed() {
        let a = view(1, 1, None);
        let b = view(1, 2, Some(a.action.clone()));
        for rows in [
            vec![a.clone(), b.clone()],
            vec![b.clone(), a.clone(), a.clone()],
        ] {
            let RoomResolution::Found { current } = resolve_records(rows) else {
                panic!("not resolved")
            };
            assert_eq!(current.action, b.action);
        }
        assert!(matches!(resolve_records(vec![]), RoomResolution::NotFound));
        assert!(matches!(
            resolve_records(vec![b.clone()]),
            RoomResolution::Unavailable
        ));
        assert!(matches!(
            resolve_records(vec![a.clone(), view(2, 1, None)]),
            RoomResolution::Conflict
        ));
        let mut fork = b.clone();
        fork.action = ActionHash::from_raw_32(vec![99; 32]);
        assert!(matches!(
            resolve_records(vec![a, b, fork]),
            RoomResolution::Conflict
        ));
    }
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_agent_action(_: ()) -> ExternResult<ActionHash> {
    query(ChainQueryFilter::new())?.into_iter().find_map(|r| {
        matches!(&r.action().data, ActionData::Create(c) if c.entry_type == EntryType::AgentPubKey)
            .then(|| r.action_address().clone())
    }).ok_or_else(|| wasm_error!(WasmErrorInner::Guest("agent entry missing".into())))
}
#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_delete_entry(hash: ActionHash) -> ExternResult<ActionHash> {
    delete_entry(hash)
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_raw_room_pointer(bytes: Vec<u8>) -> ExternResult<ActionHash> {
    let scoped: ScopedEntryDefIndex = UnitEntryTypes::RoomPointer.try_into()?;
    let entry = Entry::App(AppEntryBytes::try_from(SerializedBytes::from(
        UnsafeBytes::from(bytes),
    )).map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))?);
    create(CreateInput::new(
        EntryDefLocation::app(scoped.zome_index, scoped.zome_type),
        EntryVisibility::Public,
        entry,
        ChainTopOrdering::default(),
    ))
}

#[cfg(feature = "forge")]
#[hdk_extern]
pub fn forge_unindexed_lobby(lobby: Lobby) -> ExternResult<ActionHash> {
    create_entry(EntryTypes::Lobby(lobby))
}
