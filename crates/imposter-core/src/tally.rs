//! Meeting vote tally.
//!
//! A pure, deterministic count so the integrity zome can re-run it over the
//! `VoteReveal` entries a claimed `Ejection` references and confirm the claimed
//! result — the same "re-validate a single-author claim by replay" shape as the
//! blackjack `SettleClaim`.
//!
//! Players are identified by **seat index** (their position in the lobby's
//! sorted player list, which is also the order of the role vector). A vote's
//! `choice` is `Some(seat)` to vote a player out or `None` to vote Skip. The
//! caller is responsible for deduplicating to one vote per voter before
//! calling.
//!
//! A meeting is decided in at most two votes:
//!
//! 1. [`tally`]: the option with the most votes wins — that player is voted
//!    off, or nobody if it is Skip. A tie for the lead (between players, or
//!    between a player and Skip) is a [`TallyOutcome::Tie`].
//! 2. [`tally_tie_breaker`]: a second vote with only the tied options on the
//!    ballot. The most votes wins again; if it ties too, a draw seeded by the
//!    voters' reveal salts picks one of the tied options, so a tie-breaker
//!    always decides.

use sha2::{Digest, Sha256};

const DRAW_TAG: &[u8] = b"imposter:tiebreak:v1";

/// One revealed vote.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Vote {
    /// The voter's seat.
    pub voter: u16,
    /// `Some(seat)` to vote that player off, `None` for Skip.
    pub choice: Option<u16>,
    /// The salt that opened the voter's commitment; seeds a tie-breaker draw.
    pub salt: [u8; 32],
}

/// The result of a vote.
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TallyOutcome {
    /// This seat is voted off.
    Ejected { seat: u16 },
    /// Nobody is voted off: Skip won, or nobody voted.
    NoEjection,
    /// These options (`None` = Skip) tied for the most votes, in canonical
    /// order (Skip first, then by seat). They go to a tie-breaker vote.
    Tie { candidates: Vec<Option<u16>> },
}

/// Decide a meeting's first vote.
pub fn tally(votes: &[Vote]) -> TallyOutcome {
    match leaders(votes).as_slice() {
        [] => TallyOutcome::NoEjection,
        [only] => decided(*only),
        tied => TallyOutcome::Tie {
            candidates: tied.to_vec(),
        },
    }
}

/// Decide a tie-breaker vote over `candidates` (the options of a `Tie`). Votes
/// for anything else are ignored. Never returns `Tie`: a repeat tie is settled
/// by a draw over the counted votes' salts. With no counted votes, nobody is
/// voted off.
///
/// The draw is only as unpredictable as the salts: the last voter to reveal
/// can compute it in advance and choose to withhold their reveal.
pub fn tally_tie_breaker(votes: &[Vote], candidates: &[Option<u16>]) -> TallyOutcome {
    let counted: Vec<Vote> = votes
        .iter()
        .filter(|v| candidates.contains(&v.choice))
        .copied()
        .collect();
    match leaders(&counted).as_slice() {
        [] => TallyOutcome::NoEjection,
        [only] => decided(*only),
        tied => decided(tied[draw(&counted, tied.len())]),
    }
}

fn decided(choice: Option<u16>) -> TallyOutcome {
    match choice {
        Some(seat) => TallyOutcome::Ejected { seat },
        None => TallyOutcome::NoEjection,
    }
}

/// The options tied for the most votes, in canonical order. Empty if nobody
/// voted.
fn leaders(votes: &[Vote]) -> Vec<Option<u16>> {
    // (choice, count); small lobbies, a linear scan is fine.
    let mut counts: Vec<(Option<u16>, u32)> = Vec::new();
    for v in votes {
        match counts.iter_mut().find(|(c, _)| *c == v.choice) {
            Some(entry) => entry.1 += 1,
            None => counts.push((v.choice, 1)),
        }
    }
    let top = counts.iter().map(|(_, n)| *n).max().unwrap_or(0);
    let mut out: Vec<Option<u16>> = counts
        .into_iter()
        .filter(|(_, n)| *n == top)
        .map(|(c, _)| c)
        .collect();
    out.sort(); // `None` (Skip) sorts before every seat
    out
}

/// An index in `0..n` derived from the votes' salts, independent of vote order.
fn draw(votes: &[Vote], n: usize) -> usize {
    let mut keyed: Vec<(u16, [u8; 32])> = votes.iter().map(|v| (v.voter, v.salt)).collect();
    keyed.sort();
    let mut h = Sha256::new();
    h.update(DRAW_TAG);
    for (voter, salt) in &keyed {
        h.update(voter.to_be_bytes());
        h.update(salt);
    }
    let d = h.finalize();
    let mut x = [0u8; 8];
    x.copy_from_slice(&d[..8]);
    (u64::from_be_bytes(x) % n as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(voter: u16, choice: Option<u16>) -> Vote {
        Vote {
            voter,
            choice,
            salt: [voter as u8 + 1; 32],
        }
    }

    #[test]
    fn most_votes_is_voted_off() {
        let votes = [v(0, Some(2)), v(1, Some(2)), v(2, Some(1)), v(3, None)];
        assert_eq!(tally(&votes), TallyOutcome::Ejected { seat: 2 });
    }

    #[test]
    fn skip_with_most_votes_ejects_nobody() {
        let votes = [v(0, None), v(1, None), v(2, Some(1))];
        assert_eq!(tally(&votes), TallyOutcome::NoEjection);
    }

    #[test]
    fn no_votes_ejects_nobody() {
        assert_eq!(tally(&[]), TallyOutcome::NoEjection);
        assert_eq!(
            tally_tie_breaker(&[], &[Some(0), Some(1)]),
            TallyOutcome::NoEjection
        );
    }

    #[test]
    fn a_tie_between_players_goes_to_a_tie_breaker() {
        let votes = [v(0, Some(3)), v(1, Some(1)), v(2, Some(3)), v(3, Some(1))];
        assert_eq!(
            tally(&votes),
            TallyOutcome::Tie {
                candidates: vec![Some(1), Some(3)]
            }
        );
    }

    #[test]
    fn a_tie_with_skip_goes_to_a_tie_breaker() {
        let votes = [v(0, Some(2)), v(1, Some(2)), v(2, None), v(3, None)];
        assert_eq!(
            tally(&votes),
            TallyOutcome::Tie {
                candidates: vec![None, Some(2)]
            }
        );
    }

    #[test]
    fn tie_breaker_majority_wins() {
        let votes = [v(0, Some(1)), v(1, Some(3)), v(2, Some(3))];
        assert_eq!(
            tally_tie_breaker(&votes, &[Some(1), Some(3)]),
            TallyOutcome::Ejected { seat: 3 }
        );
    }

    #[test]
    fn tie_breaker_ignores_off_ballot_votes() {
        let votes = [v(0, Some(1)), v(1, None), v(2, Some(0)), v(3, Some(0))];
        assert_eq!(
            tally_tie_breaker(&votes, &[Some(1), Some(3)]),
            TallyOutcome::Ejected { seat: 1 }
        );
    }

    #[test]
    fn a_tied_tie_breaker_is_settled_by_a_draw() {
        let candidates = [Some(1), Some(3)];
        let votes = [v(0, Some(1)), v(1, Some(3))];
        let out = tally_tie_breaker(&votes, &candidates);
        assert!(
            matches!(out, TallyOutcome::Ejected { seat: 1 | 3 }),
            "{out:?}"
        );
        let reversed = [votes[1], votes[0]];
        assert_eq!(
            tally_tie_breaker(&reversed, &candidates),
            out,
            "the draw ignores vote order"
        );
    }

    #[test]
    fn the_draw_depends_on_the_salts() {
        let candidates = [Some(1), Some(3)];
        let mut seen = Vec::new();
        for s in 0..32u8 {
            let votes = [
                Vote { voter: 0, choice: Some(1), salt: [s; 32] },
                Vote { voter: 1, choice: Some(3), salt: [!s; 32] },
            ];
            let out = tally_tie_breaker(&votes, &candidates);
            if !seen.contains(&out) {
                seen.push(out);
            }
        }
        assert_eq!(seen.len(), 2, "both tied options can win the draw");
    }

    #[test]
    fn serializes_as_the_ui_expects() {
        let cases = [
            (
                TallyOutcome::Ejected { seat: 2 },
                serde_json::json!({ "kind": "ejected", "seat": 2 }),
            ),
            (
                TallyOutcome::NoEjection,
                serde_json::json!({ "kind": "no_ejection" }),
            ),
            (
                TallyOutcome::Tie { candidates: vec![None, Some(2)] },
                serde_json::json!({ "kind": "tie", "candidates": [null, 2] }),
            ),
        ];
        for (outcome, json) in cases {
            assert_eq!(serde_json::to_value(&outcome).unwrap(), json);
            assert_eq!(serde_json::from_value::<TallyOutcome>(json).unwrap(), outcome);
        }
    }
}
