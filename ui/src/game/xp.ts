// A player's XP: each finished game's clone (dnas/game/.../lib.rs, "XP"
// section) answers "how much did I earn in THIS game" from its own public
// data. Nothing durable tracks a running total across games — every game is
// a separate DNA clone (a separate network), and a finished one's clone gets
// disabled once the room moves on (see closeEarlierGames), so nothing could
// read it back afterward anyway. Instead, the moment a game is seen ending,
// its amount is recorded here, once (idempotent — a repeat "ended" observation
// never double-counts), and the running total is just the sum of everything
// recorded so far.
//
// This is a per-device tally, not a durable, cross-agent-readable ledger: it
// lives in this browser's localStorage, so a different device or a cleared
// profile starts over. Making it durable and independently verifiable (so,
// say, the hNFT app's shop could check a claim without trusting the client)
// would need a dedicated, uncloned role other cells could call into — a
// bigger change, not needed just to show a running total in this UI.

const LS_XP = "imposter-xp-v1";

type Ledger = Record<string, number>; // gameKey -> XP earned in that game

function load(): Ledger {
  try {
    const raw = localStorage.getItem(LS_XP);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(ledger: Ledger): void {
  try {
    localStorage.setItem(LS_XP, JSON.stringify(ledger));
  } catch {
    /* storage unavailable (private window, quota) — the total just won't persist */
  }
}

/** `code#round` — a stable id for one game, unique enough for this ledger
 *  (a room's rounds are numbered, and a fresh room needs a fresh code). */
export function gameKey(code: string, round: number): string {
  return `${code}#${round}`;
}

/** Record a finished game's XP, once. A repeat call for the same game (a
 *  reload, polling twice before moving on) is a no-op, so it can be called
 *  freely every time "ended" is observed. */
export function recordGameXp(key: string, xp: number): void {
  const ledger = load();
  if (key in ledger) return;
  ledger[key] = xp;
  save(ledger);
}

/** The running total across every finished game this device has recorded. */
export function totalXp(): number {
  return Object.values(load()).reduce((a, b) => a + b, 0);
}
