//! Crisis sabotages: the ones that end the game for the impostors if the crew
//! doesn't stabilise them in time.
//!
//! - **Reactor Emergency**: two consoles, which two *different* players must
//!   hold at the same time.
//! - **Life Support**: two terminals on opposite sides of the ship; each needs
//!   one fix.
//! - **Navigation Drift**: three consoles across the Forward zone; each needs
//!   one fix.
//!
//! The durations are tunables, but `validate` re-checks a meltdown result
//! against them, so they live here rather than in a client: change them and
//! the DNA hash changes with them.

/// Which crisis an impostor started.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrisisKind {
    Reactor,
    LifeSupport,
    NavDrift,
}

/// How long the crew has to stabilise a Reactor Emergency.
pub const REACTOR_EMERGENCY_MS: i64 = 45_000;
/// How long the crew has to restore Life Support.
pub const LIFE_SUPPORT_MS: i64 = 45_000;
/// How long the crew has to correct a Navigation Drift.
pub const NAV_DRIFT_MS: i64 = 60_000;
/// How close together the two reactor holds must land to count as one
/// two-person stabilisation. Holding clients re-confirm about once a second.
pub const REACTOR_SYNC_MS: i64 = 1_500;

impl CrisisKind {
    pub const ALL: [CrisisKind; 3] = [CrisisKind::Reactor, CrisisKind::LifeSupport, CrisisKind::NavDrift];

    /// How many consoles this crisis has.
    pub fn panels(self) -> u8 {
        match self {
            CrisisKind::Reactor | CrisisKind::LifeSupport => 2,
            CrisisKind::NavDrift => 3,
        }
    }

    /// How long the crew has before it ends the game.
    pub fn duration_ms(self) -> i64 {
        match self {
            CrisisKind::Reactor => REACTOR_EMERGENCY_MS,
            CrisisKind::LifeSupport => LIFE_SUPPORT_MS,
            CrisisKind::NavDrift => NAV_DRIFT_MS,
        }
    }
}

/// One crisis link, as its tag: the host starting one on an impostor's behalf,
/// or a player fixing (or, at the reactor, still holding) one console.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrisisTag {
    Start { kind: CrisisKind },
    Fix { kind: CrisisKind, panel: u8 },
}

/// A console fix: when (ms since the epoch), which console, and by whom.
#[derive(Clone, Debug, PartialEq)]
pub struct Fix<A> {
    pub at_ms: i64,
    pub panel: u8,
    pub by: A,
}

/// Whether `fixes` (all made since the crisis started) stabilise it.
pub fn resolved<A: PartialEq>(kind: CrisisKind, fixes: &[Fix<A>]) -> bool {
    resolved_at(kind, fixes).is_some()
}

/// When `fixes` stabilised the crisis, if they did: the moment the last
/// console it needed was fixed.
pub fn resolved_at<A: PartialEq>(kind: CrisisKind, fixes: &[Fix<A>]) -> Option<i64> {
    match kind {
        CrisisKind::Reactor => {
            // The earliest pair: one hold on each console, by two different
            // players, close enough together to have been at the same time.
            let mut best: Option<i64> = None;
            for a in fixes.iter().filter(|f| f.panel == 0) {
                for b in fixes.iter().filter(|f| f.panel == 1) {
                    if a.by != b.by && (a.at_ms - b.at_ms).abs() <= REACTOR_SYNC_MS {
                        let at = a.at_ms.max(b.at_ms);
                        best = Some(best.map_or(at, |t| t.min(at)));
                    }
                }
            }
            best
        }
        CrisisKind::LifeSupport | CrisisKind::NavDrift => (0..kind.panels())
            .map(|p| fixes.iter().filter(|f| f.panel == p).map(|f| f.at_ms).min())
            .collect::<Option<Vec<i64>>>()
            .map(|firsts| firsts.into_iter().max().unwrap_or(0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fix(at_ms: i64, panel: u8, by: u8) -> Fix<u8> {
        Fix { at_ms, panel, by }
    }

    #[test]
    fn reactor_needs_two_players_at_once() {
        let k = CrisisKind::Reactor;
        assert!(!resolved(k, &[fix(1000, 0, 1)]));
        // one player can't hold both consoles
        assert!(!resolved(k, &[fix(1000, 0, 1), fix(1200, 1, 1)]));
        // two players, too far apart in time
        assert!(!resolved(k, &[fix(1000, 0, 1), fix(1000 + REACTOR_SYNC_MS + 1, 1, 2)]));
        // two players together
        assert_eq!(resolved_at(k, &[fix(1000, 0, 1), fix(1800, 1, 2)]), Some(1800));
        // the earliest overlapping pair counts
        let holds = [fix(1000, 0, 1), fix(2000, 0, 1), fix(2500, 1, 2), fix(3000, 0, 1)];
        assert_eq!(resolved_at(k, &holds), Some(2500));
    }

    #[test]
    fn life_support_and_nav_drift_need_every_console() {
        assert!(!resolved(CrisisKind::LifeSupport, &[fix(1000, 0, 1), fix(1100, 0, 2)]));
        assert_eq!(resolved_at(CrisisKind::LifeSupport, &[fix(4000, 1, 1), fix(1000, 0, 1)]), Some(4000));
        let nav = [fix(1000, 0, 1), fix(2000, 2, 2)];
        assert!(!resolved(CrisisKind::NavDrift, &nav));
        let nav = [fix(1000, 0, 1), fix(2000, 2, 2), fix(1500, 1, 1), fix(900, 1, 3)];
        assert_eq!(resolved_at(CrisisKind::NavDrift, &nav), Some(2000));
    }
}
