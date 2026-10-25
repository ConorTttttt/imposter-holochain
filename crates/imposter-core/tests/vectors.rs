//! Known-answer tests for the pure core — mirrors `blackjack-core/tests/vectors.rs`.

use imposter_core::{
    assign, commitment_root, impostor_count, outcome, reveal_matches_root, role_proof, tally,
    tally_tie_breaker, verify_role_proof, Outcome, TallyOutcome, Vote, ROLE_CREW, ROLE_IMPOSTOR,
};
use imposter_core::merkle::build_layers;

fn seed(byte: u8) -> [u8; 32] {
    [byte; 32]
}

#[test]
fn assignment_is_deterministic_and_has_the_right_counts() {
    let a = assign(6, 2, &seed(7)).unwrap();
    let b = assign(6, 2, &seed(7)).unwrap();
    assert_eq!(a, b, "same seed -> same vector");
    assert_eq!(a.len(), 6);
    assert_eq!(impostor_count(&a), 2);

    let c = assign(6, 2, &seed(8)).unwrap();
    assert_ne!(a, c, "different seed -> (almost certainly) different vector");
}

#[test]
fn assignment_rejects_bad_configs() {
    assert!(assign(2, 1, &seed(1)).is_err(), "too few players");
    assert!(assign(6, 0, &seed(1)).is_err(), "no impostors");
    assert!(assign(6, 6, &seed(1)).is_err(), "all impostors");
    assert!(assign(65, 2, &seed(1)).is_err(), "over the cap");
}

#[test]
fn every_leaf_proof_opens_the_committed_root() {
    let roles = assign(8, 2, &seed(42)).unwrap();
    let salt = seed(99);
    let root = commitment_root(&roles, &salt);
    let layers = build_layers(&roles, &salt);

    for (i, &role) in roles.iter().enumerate() {
        let proof = role_proof(&layers, &salt, i as u16);
        assert!(
            verify_role_proof(&root, i as u16, role, &proof),
            "seat {i} proof must open the root"
        );
        // A player told the wrong role for their seat must fail the check.
        let lie = if role == ROLE_IMPOSTOR { ROLE_CREW } else { ROLE_IMPOSTOR };
        assert!(
            !verify_role_proof(&root, i as u16, lie, &proof),
            "seat {i} must not verify a swapped role"
        );
    }
}

#[test]
fn full_reveal_rebuilds_the_root_and_catches_tampering() {
    let roles = assign(5, 1, &seed(3)).unwrap();
    let salt = seed(4);
    let root = commitment_root(&roles, &salt);

    assert!(reveal_matches_root(&roles, &salt, &root));

    let mut swapped = roles.clone();
    swapped.swap(0, 4);
    if swapped != roles {
        assert!(
            !reveal_matches_root(&swapped, &salt, &root),
            "a reordered reveal must not match"
        );
    }

    let mut longer = roles.clone();
    longer.push(ROLE_CREW);
    assert!(
        !reveal_matches_root(&longer, &salt, &root),
        "a reveal of a different length must not match"
    );
}

/// Votes as (voter seat, choice), each with its own salt.
fn votes(v: &[(u16, Option<u16>)]) -> Vec<Vote> {
    v.iter()
        .map(|&(voter, choice)| Vote {
            voter,
            choice,
            salt: seed(voter as u8),
        })
        .collect()
}

#[test]
fn tally_plurality_and_ties() {
    // seats 0..5
    let ejected = tally(&votes(&[
        (0, Some(3)),
        (1, Some(3)),
        (2, Some(3)),
        (3, None),
        (4, Some(1)),
    ]));
    assert_eq!(ejected, TallyOutcome::Ejected { seat: 3 });

    let tie_players = tally(&votes(&[(0, Some(1)), (1, Some(1)), (2, Some(2)), (3, Some(2))]));
    assert_eq!(
        tie_players,
        TallyOutcome::Tie { candidates: vec![Some(1), Some(2)] },
        "player/player tie -> tie breaker"
    );

    let skip_ties = tally(&votes(&[(0, Some(1)), (1, None)]));
    assert_eq!(
        skip_ties,
        TallyOutcome::Tie { candidates: vec![None, Some(1)] },
        "skip tie -> tie breaker"
    );

    let all_skip = tally(&votes(&[(0, None), (1, None)]));
    assert_eq!(all_skip, TallyOutcome::NoEjection);
}

#[test]
fn tie_breaker_always_decides() {
    let candidates = [Some(1), Some(2)];

    let majority = tally_tie_breaker(&votes(&[(0, Some(2)), (1, Some(2)), (2, Some(1))]), &candidates);
    assert_eq!(majority, TallyOutcome::Ejected { seat: 2 });

    // tied again: the draw picks one of the tied seats, the same way every time
    let tied = votes(&[(0, Some(1)), (1, Some(2)), (2, None)]);
    let drawn = tally_tie_breaker(&tied, &candidates);
    assert!(matches!(drawn, TallyOutcome::Ejected { seat: 1 | 2 }), "{drawn:?}");
    assert_eq!(tally_tie_breaker(&tied, &candidates), drawn);
}

#[test]
fn win_check() {
    assert_eq!(outcome(0, 3, 0, 10), Some(Outcome::CrewWin), "no impostors left");
    assert_eq!(outcome(1, 5, 10, 10), Some(Outcome::CrewWin), "all tasks done");
    assert_eq!(outcome(2, 2, 3, 10), Some(Outcome::ImpostorsWin), "parity");
    assert_eq!(outcome(1, 3, 3, 10), None, "game continues");
    // crew win takes precedence at simultaneous parity + last impostor ejected
    assert_eq!(outcome(0, 1, 2, 10), Some(Outcome::CrewWin));
}
