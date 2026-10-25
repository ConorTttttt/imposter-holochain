//! The vote commitment used by the meeting flow.
//!
//! A voter first commits `commitment(choice, salt)` (a `VoteCommit` entry),
//! then later publishes `choice` + `salt` in the clear (a `VoteReveal`). The
//! integrity zome recomputes this and checks it against the commit, so nobody
//! can see the tally forming and change their vote to match — and cannot swap
//! their vote after revealing.
//!
//! `choice` is the raw bytes of the voted agent's key, or `None` for Skip.
//! Both the TypeScript client and the zome build the exact same preimage:
//! `"imposter:vote:v1" ‖ (0x00 | 0x01 ‖ key) ‖ salt`.

use sha2::{Digest, Sha256};

const VOTE_TAG: &[u8] = b"imposter:vote:v1";

/// SHA-256 over the tagged preimage. `salt` is a fresh 32-byte random value per
/// vote.
pub fn commitment(choice: Option<&[u8]>, salt: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(VOTE_TAG);
    match choice {
        None => h.update([0u8]),
        Some(key) => {
            h.update([1u8]);
            h.update(key);
        }
    }
    h.update(salt);
    let d = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&d);
    out
}
