// Legacy round walk retained for explicit LEGACY: joins and Phase 3 Play Again.
// New private games are resolved through registry.ts in the base game cell.

/** The network seed of one game in a room. */
export function lobbySeed(room: string, round: number): string {
  return round <= 1 ? `room1.${room}` : `room1.${room}#${round}`;
}

/** A new network seed for a game `hostKeyB64` owns: `g1.<host key>.<random id>`,
 *  the id 128 random bits as 32 hex digits. The game DNA's validation reads it
 *  back (`parse_game_seed` in the integrity zome) and refuses a lobby opened by
 *  anyone but that host. */
export function newGameSeed(hostKeyB64: string): string {
  const id = crypto.getRandomValues(new Uint8Array(16));
  return `g1.${hostKeyB64}.${Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** What the walk needs to know about a game. `code` is null until its lobby exists. */
export type GameLook = { phase: string; code: string | null };

/**
 * The room's current game: the first one that hasn't ended, hasn't been
 * abandoned for a later one (its host left and someone opened a new game), and
 * wasn't closed by this window. `look` returns `null` for a closed game. Games
 * are only ever added, so the walk can start from the last one known.
 */
export async function currentGame<T extends GameLook>(
  room: string,
  from: number,
  look: (seed: string) => Promise<T | null>,
): Promise<{ round: number; game: T }> {
  for (let round = Math.max(1, from); ; round++) {
    const game = await look(lobbySeed(room, round));
    if (!game || game.phase === "ended") continue;
    const later = await look(lobbySeed(room, round + 1));
    if (later && later.code == null) return { round, game };
  }
}
