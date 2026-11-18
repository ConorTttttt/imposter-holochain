//! The DHT is an authenticated discovery channel, never a freshness oracle.
//! Lair signs the immutable revision-2 transcript for the ACTUAL cell author.
use super::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct EnrollRecipientKey {
    pub key_id: [u8; 16],
    pub x25519_public_key: [u8; 32],
    pub epoch: u64,
    pub not_before_ms: u64,
    pub not_after_ms: u64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RecipientKeyView {
    pub action: ActionHash,
    pub attestation: RecipientKeyAttestation,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LookupRecipientKey {
    pub recipient: AgentPubKey,
    /// A durable, previously authenticated HWC floor; omit BOTH for unpinned discovery.
    pub min_epoch: Option<u64>,
    pub min_key_id: Option<[u8; 16]>,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RecipientKeyLookup {
    NotFound,
    Unavailable,
    Conflict,
    BelowTrustedFloor,
    /// This candidate is signature/native-validated but NOT proven globally newest.
    Observed { current_unproven: bool, view: RecipientKeyView },
}
fn enrollment_error(why: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(why.to_string()))
}
fn same_identity(a: &RecipientKeyAttestation, b: &RecipientKeyAttestation) -> bool {
    a.key_id == b.key_id && a.x25519_public_key == b.x25519_public_key
}
fn own_history() -> ExternResult<Vec<RecipientKeyView>> {
    let author = me()?;
    let mut history = Vec::new();
    for record in query(ChainQueryFilter::new().include_entries(true))? {
        if let Some(a) = attestation_from_record(&record)? {
            if a.agent == author {
                history.push(RecipientKeyView {
                    action: record.action_address().clone(), attestation: a,
                });
            }
        }
    }
    Ok(history)
}
fn ensure_own_sequence(a: &RecipientKeyAttestation, history: &[RecipientKeyView])
    -> ExternResult<Option<ActionHash>> {
    let max = history.iter().map(|v| v.attestation.epoch).max().unwrap_or(0);
    if max == 0 && a.epoch != 1 ||
       max > 0 && (a.epoch < max || a.epoch > max.saturating_add(1)) {
        return Err(enrollment_error("enrollment must begin at epoch 1 and never roll back or skip"));
    }
    if a.epoch > max {
        if history.iter().any(|v| v.attestation.key_id == a.key_id ||
                                   v.attestation.x25519_public_key == a.x25519_public_key) {
            return Err(enrollment_error("key rotation requires a fresh key and identifier"));
        }
        return Ok(None);
    }
    let same_epoch: Vec<_> = history.iter().filter(|v| v.attestation.epoch == max).collect();
    if same_epoch.iter().any(|v| !same_identity(&v.attestation, a)) {
        return Err(enrollment_error("one epoch cannot attest different encryption keys"));
    }
    if let Some(exact) = same_epoch.iter().find(|v| {
        recipient_key_transcript(&v.attestation) == recipient_key_transcript(a)
    }) {
        return Ok(Some(exact.action.clone())); // idempotent, recovers a missing link
    }
    if same_epoch.iter().any(|v| a.not_after_ms <= v.attestation.not_after_ms ||
                                a.not_before_ms < v.attestation.not_before_ms) {
        return Err(enrollment_error("same-key renewal must extend expiry without rewinding start"));
    }
    Ok(None)
}
/// Accepts an independently Lair-signed record; cannot publish for another agent.
/// The native integrity validator repeats author/DNA/raw-signature verification.
#[hdk_extern]
pub fn publish_signed_recipient_key_attestation(a: RecipientKeyAttestation)
    -> ExternResult<RecipientKeyView> {
    let author = me()?;
    if a.agent != author || a.dna != dna_info()?.hash ||
       !verify_signature_raw(author.clone(), a.signature.clone(), recipient_key_transcript(&a))? {
        return Err(enrollment_error("foreign cell or invalid Lair attestation"));
    }
    let history = own_history()?;
    let action = match ensure_own_sequence(&a, &history)? {
        Some(action) => action,
        None => create_entry(EntryTypes::RecipientKeyAttestation(a.clone()))?,
    };
    let base = AnyLinkableHash::from(author);
    let links = get_links(LinkQuery::try_new(base.clone(), LinkTypes::RecipientKeyByAgent)?,
                          GetStrategy::Network)?;
    if !links.iter().any(|l| l.target == AnyLinkableHash::from(action.clone())) {
        create_link(base, action.clone(), LinkTypes::RecipientKeyByAgent, ())?;
    }
    Ok(RecipientKeyView { action, attestation: a })
}
/// Installed-cell Lair signs directly. HWC retains the X25519 secret; never pass it here.
#[hdk_extern]
pub fn enroll_recipient_key(input: EnrollRecipientKey) -> ExternResult<RecipientKeyView> {
    let agent = me()?;
    let mut a = RecipientKeyAttestation {
        dna: dna_info()?.hash, agent: agent.clone(), key_id: input.key_id,
        x25519_public_key: input.x25519_public_key, epoch: input.epoch,
        not_before_ms: input.not_before_ms, not_after_ms: input.not_after_ms,
        signature: Signature([0; 64]),
    };
    a.signature = sign_raw(agent, recipient_key_transcript(&a))?;
    publish_signed_recipient_key_attestation(a)
}
/// Independent host lookup: strict action type, native valid record, author,
/// DNA, signer and validity. Missing links/records or equivocation fail closed.
#[hdk_extern]
pub fn lookup_recipient_key(input: LookupRecipientKey) -> ExternResult<RecipientKeyLookup> {
    if input.min_epoch.is_some() != input.min_key_id.is_some() {
        return Ok(RecipientKeyLookup::Unavailable);
    }
    let dna = dna_info()?.hash;
    let links = get_links(
        LinkQuery::try_new(AnyLinkableHash::from(input.recipient.clone()),
                           LinkTypes::RecipientKeyByAgent)?, GetStrategy::Network)?;
    if links.is_empty() { return Ok(RecipientKeyLookup::NotFound); }
    let mut seen = std::collections::BTreeSet::new();
    let mut found: Vec<RecipientKeyView> = Vec::new();
    for link in links {
        let Some(action) = link.target.into_action_hash() else {
            return Ok(RecipientKeyLookup::Unavailable);
        };
        if !seen.insert(action.clone()) { continue; }
        // A raw untyped network GET alone is not native validation evidence.
        let Ok(record) = must_get_valid_record(action.clone()) else {
            return Ok(RecipientKeyLookup::Unavailable);
        };
        let Some(a) = attestation_from_record(&record)? else {
            return Ok(RecipientKeyLookup::Unavailable);
        };
        if record.action().author() != &input.recipient || a.agent != input.recipient ||
           a.dna != dna || a.epoch == 0 ||
           !verify_signature_raw(a.agent.clone(), a.signature.clone(),
                                  recipient_key_transcript(&a))? {
            return Ok(RecipientKeyLookup::Unavailable);
        }
        found.push(RecipientKeyView { action, attestation: a });
    }
    found.sort_by(|a,b| a.attestation.epoch.cmp(&b.attestation.epoch)
        .then(a.attestation.not_after_ms.cmp(&b.attestation.not_after_ms))
        .then(a.action.cmp(&b.action)));
    let mut previous_epoch = 0u64;
    let mut seen_key_ids = std::collections::BTreeSet::new();
    let mut seen_public_keys = std::collections::BTreeSet::new();
    let mut current: Option<&RecipientKeyView> = None;
    for item in &found {
        let a = &item.attestation;
        if a.epoch > previous_epoch {
            if a.epoch != previous_epoch + 1 ||
               !seen_key_ids.insert(a.key_id) ||
               !seen_public_keys.insert(a.x25519_public_key) {
                return Ok(RecipientKeyLookup::Unavailable);
            }
            previous_epoch = a.epoch;
        } else if current.is_some_and(|c| !same_identity(&c.attestation, a)) {
            return Ok(RecipientKeyLookup::Conflict);
        }
        if current.is_some_and(|c| c.attestation.epoch == a.epoch &&
                (a.not_before_ms < c.attestation.not_before_ms ||
                 a.not_after_ms < c.attestation.not_after_ms)) {
            return Ok(RecipientKeyLookup::Conflict);
        }
        current = Some(item);
    }
    let Some(candidate) = current else { return Ok(RecipientKeyLookup::NotFound) };
    let at = sys_time()?.as_millis();
    if at < 0 || candidate.attestation.not_before_ms > at as u64 ||
       candidate.attestation.not_after_ms <= at as u64 {
        return Ok(RecipientKeyLookup::Unavailable);
    }
    if let (Some(epoch), Some(key_id)) = (input.min_epoch, input.min_key_id) {
        if candidate.attestation.epoch < epoch ||
           (candidate.attestation.epoch == epoch && candidate.attestation.key_id != key_id) {
            return Ok(RecipientKeyLookup::BelowTrustedFloor);
        }
    }
    Ok(RecipientKeyLookup::Observed { current_unproven: true, view: candidate.clone() })
}
