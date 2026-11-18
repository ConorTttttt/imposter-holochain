//! Pure Imposter rules: the role Merkle commitment, deterministic role
//! assignment, the meeting vote tally, and the win check.
//!
//! No Holochain, no I/O, no randomness beyond an explicit seed — everything
//! here is a deterministic function so it can run unchanged inside the `game`
//! integrity zome's `validate` callback and in ordinary `cargo test`.
//!
//! Adapted from `blackjack-core`: `merkle` is the shoe commitment with a role
//! byte for a leaf; `roles::assign` reuses the `shuffle_with_seed` keystream.

pub mod crisis;
pub mod merkle;
pub mod role_auth;
pub mod roles;
pub mod tally;
pub mod vote;
pub mod wincheck;

pub use crisis::{CrisisKind, CrisisTag};
pub use merkle::{
    build_layers, commitment_root, derive_role_salt, reveal_matches_root, role_proof,
    verify_role_proof, Hash, RoleProof, MAX_PLAYERS, ROLE_CREW, ROLE_IMPOSTOR, TREE_DEPTH,
};
pub use roles::{assign, impostor_count, mix_seed};
pub use tally::{tally, tally_tie_breaker, TallyOutcome, Vote};
pub use vote::commitment as vote_commitment;
pub use wincheck::{outcome, Outcome};
