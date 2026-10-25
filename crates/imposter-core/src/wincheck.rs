//! The win condition.
//!
//! Pure and deterministic so a claimed `GameResult` entry can be re-checked in
//! `validate` against counts recomputed from the referenced entries.

/// Who has won, if anyone.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    CrewWin,
    ImpostorsWin,
}

/// Evaluate the win condition from live counts and task progress.
///
/// - Crew win: every impostor is gone, or every task is done.
/// - Impostors win: impostors are at least as many as the remaining crew (they
///   can no longer be out-voted).
/// - Otherwise the game is still going (`None`).
///
/// Crew win is checked first: ejecting the last impostor on the same meeting
/// that would bring parity should still be a crew win.
pub fn outcome(
    impostors_alive: u32,
    crew_alive: u32,
    tasks_done: u32,
    tasks_total: u32,
) -> Option<Outcome> {
    if impostors_alive == 0 || (tasks_total > 0 && tasks_done >= tasks_total) {
        return Some(Outcome::CrewWin);
    }
    if impostors_alive >= crew_alive {
        return Some(Outcome::ImpostorsWin);
    }
    None
}
