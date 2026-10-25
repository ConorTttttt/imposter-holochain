//! Deterministic role assignment for a lobby.
//!
//! Given the lobby size, the impostor count, and a 32-byte seed, this produces
//! the role vector in seat order. It is a pure function of its inputs — the
//! same trick as the blackjack `shuffle_with_seed` shoe shuffle — so the host
//! coordinator, the integrity zome's `RolesReveal` check, and `cargo test` all
//! agree on the outcome for a given seed.
//!
//! The seed the host actually uses is `host_entropy XOR sha256(sorted player
//! keys)` (built in the coordinator): the host cannot pick the final vector
//! alone, because it does not control the other players' keys, and the players
//! can recompute the key half at reveal time.

use sha2::{Digest, Sha256};

use crate::merkle::{ROLE_CREW, ROLE_IMPOSTOR};

/// A keystream of 64-bit words: `SHA-256(seed ‖ counter)`, first 8 bytes.
struct SeedRng {
    seed: [u8; 32],
    counter: u64,
}

impl SeedRng {
    fn new(seed: &[u8; 32]) -> Self {
        SeedRng {
            seed: *seed,
            counter: 0,
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut h = Sha256::new();
        h.update(self.seed);
        h.update(self.counter.to_be_bytes());
        self.counter += 1;
        let d = h.finalize();
        let mut first8 = [0u8; 8];
        first8.copy_from_slice(&d[..8]);
        u64::from_be_bytes(first8)
    }
}

/// The role vector for a lobby, in seat order. `Err` on a nonsensical
/// configuration; the integrity zome rejects those on the `Lobby` entry, so
/// this is belt-and-braces.
pub fn assign(player_count: usize, impostor_count: usize, seed: &[u8; 32]) -> Result<Vec<u8>, &'static str> {
    if player_count < 3 {
        return Err("a lobby needs at least 3 players");
    }
    if player_count > crate::merkle::MAX_PLAYERS {
        return Err("too many players for one lobby");
    }
    if impostor_count == 0 || impostor_count >= player_count {
        return Err("impostor count must be in 1..player_count");
    }

    let mut roles = vec![ROLE_IMPOSTOR; impostor_count];
    roles.resize(player_count, ROLE_CREW);

    // Fisher–Yates with the seeded keystream — identical structure to
    // `blackjack_core::deck::shuffle_with_seed`.
    let mut rng = SeedRng::new(seed);
    for i in (1..roles.len()).rev() {
        let j = (rng.next_u64() % (i as u64 + 1)) as usize;
        roles.swap(i, j);
    }
    Ok(roles)
}

/// How many impostors are in a role vector.
pub fn impostor_count(roles: &[u8]) -> usize {
    roles.iter().filter(|&&r| r == ROLE_IMPOSTOR).count()
}

/// Combine the host's private entropy with a hash of every player's key, so the
/// host cannot choose the final assignment alone (it does not control the other
/// keys) and any player can recompute the key half at reveal time.
///
/// `seat_keys` must be in the same order the caller will use for the role
/// vector (the sorted seat order).
pub fn mix_seed(host_entropy: &[u8; 32], seat_keys: &[Vec<u8>]) -> [u8; 32] {
    let mut h = Sha256::new();
    for k in seat_keys {
        h.update(k);
    }
    let key_half = h.finalize();
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = host_entropy[i] ^ key_half[i];
    }
    out
}
