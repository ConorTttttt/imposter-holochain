//! The role commitment: a Merkle tree over the role of every player in a lobby.
//!
//! A direct adaptation of the blackjack `blackjack-core::merkle` shoe
//! commitment — the leaf is a single role byte instead of a `(rank, suit)`
//! card, everything else (64 fixed leaves, depth 6, the byte layout, the
//! salt-derivation scheme) is the same, so a root built here matches one built
//! by any other honest implementation for the same role vector and salt.
//!
//! The host publishes only the root before the game starts. Each player is then
//! handed *only their own* leaf plus a proof that opens it against the root
//! (over a remote signal, never on the DHT), so a player can check on the spot
//! that the role they were told is the one the host sealed. The full role
//! vector plus the master salt is revealed at game end, which is when a
//! swapped role or an out-of-range vector is caught.
//!
//! What a per-leaf proof does NOT establish: that the host assigned impostors
//! fairly. The host chose the vector; a proof only binds them to it. The
//! blinding contributed by the other players' keys (see `roles::assign`)
//! de-correlates the sealed order from who ends up an impostor.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A lobby is capped at this many players — one Merkle leaf each, the rest pad.
pub const MAX_PLAYERS: usize = 64;
const LEAF_COUNT: usize = 64;
pub const TREE_DEPTH: usize = 6;

const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;
const LEAF_TAG: &[u8] = b"imposter:role:v1";
const SALT_TAG: &[u8] = b"imposter:rolesalt:v1";
const PAD_TAG: &[u8] = b"imposter:pad:v1";

pub type Hash = [u8; 32];

/// 0 = crewmate, 1 = impostor. A plain byte so the leaf layout is fixed.
pub const ROLE_CREW: u8 = 0;
pub const ROLE_IMPOSTOR: u8 = 1;

/// The proof opening one player's role leaf against the commitment root.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct RoleProof {
    /// The 16-byte per-player salt for this leaf.
    pub role_salt: [u8; 16],
    /// Sibling hashes from the leaf up to the root, leaf-first (length 6).
    pub path: Vec<Hash>,
}

fn sha256(parts: &[&[u8]]) -> Hash {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    let digest = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn u16be(n: u16) -> [u8; 2] {
    n.to_be_bytes()
}

fn pad_leaf() -> Hash {
    sha256(&[&[LEAF_PREFIX], PAD_TAG])
}

/// The 16-byte salt for one player position, derived from the master salt so
/// the host keeps only that one value. Without it, two players with the same
/// role would hash to the same leaf and a player could confirm guesses about
/// other players' roles from the sealed leaves alone.
pub fn derive_role_salt(master_salt: &[u8; 32], index: u16) -> [u8; 16] {
    let full = sha256(&[SALT_TAG, master_salt, &u16be(index)]);
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// SHA-256(0x00 ‖ tag ‖ index ‖ role ‖ role_salt).
fn leaf_hash(index: u16, role: u8, role_salt: &[u8; 16]) -> Hash {
    sha256(&[
        &[LEAF_PREFIX],
        LEAF_TAG,
        &u16be(index),
        &[role],
        role_salt,
    ])
}

fn node_hash(left: &Hash, right: &Hash) -> Hash {
    sha256(&[&[NODE_PREFIX], left, right])
}

/// All tree layers: `layers[0]` are the 64 leaves; `layers[TREE_DEPTH]` is the
/// single root.
pub fn build_layers(roles: &[u8], salt: &[u8; 32]) -> Vec<Vec<Hash>> {
    let pad = pad_leaf();
    let mut leaves = Vec::with_capacity(LEAF_COUNT);
    for i in 0..LEAF_COUNT {
        if i < roles.len() {
            leaves.push(leaf_hash(i as u16, roles[i], &derive_role_salt(salt, i as u16)));
        } else {
            leaves.push(pad);
        }
    }
    let mut layers = vec![leaves];
    while layers.last().map(|l| l.len()).unwrap_or(0) > 1 {
        let below = layers.last().unwrap();
        let mut up = Vec::with_capacity(below.len() / 2);
        let mut i = 0;
        while i < below.len() {
            up.push(node_hash(&below[i], &below[i + 1]));
            i += 2;
        }
        layers.push(up);
    }
    layers
}

/// The committed root for a role vector and salt.
pub fn commitment_root(roles: &[u8], salt: &[u8; 32]) -> Hash {
    build_layers(roles, salt)
        .last()
        .and_then(|top| top.first().copied())
        .unwrap_or([0u8; 32])
}

/// The proof opening the role at `index`.
pub fn role_proof(layers: &[Vec<Hash>], salt: &[u8; 32], index: u16) -> RoleProof {
    let mut idx = index as usize;
    let mut path = Vec::with_capacity(TREE_DEPTH);
    for level in layers.iter().take(TREE_DEPTH) {
        path.push(level[idx ^ 1]);
        idx >>= 1;
    }
    RoleProof {
        role_salt: derive_role_salt(salt, index),
        path,
    }
}

/// Recompute the root from `role` + its proof and check it against `root`.
pub fn verify_role_proof(root: &Hash, index: u16, role: u8, proof: &RoleProof) -> bool {
    if index as usize >= MAX_PLAYERS {
        return false;
    }
    if role != ROLE_CREW && role != ROLE_IMPOSTOR {
        return false;
    }
    if proof.path.len() != TREE_DEPTH {
        return false;
    }
    let mut idx = index as usize;
    let mut cursor = leaf_hash(index, role, &proof.role_salt);
    for sibling in &proof.path {
        cursor = if idx & 1 == 1 {
            node_hash(sibling, &cursor)
        } else {
            node_hash(&cursor, sibling)
        };
        idx >>= 1;
    }
    &cursor == root
}

/// Rebuild the root from a full reveal and confirm it. `roles` is the whole
/// lobby's vector in seat order; only its declared length is committed, so a
/// reveal of a different length cannot match.
pub fn reveal_matches_root(roles: &[u8], salt: &[u8; 32], root: &Hash) -> bool {
    if roles.is_empty() || roles.len() > MAX_PLAYERS {
        return false;
    }
    if roles.iter().any(|&r| r != ROLE_CREW && r != ROLE_IMPOSTOR) {
        return false;
    }
    &commitment_root(roles, salt) == root
}
