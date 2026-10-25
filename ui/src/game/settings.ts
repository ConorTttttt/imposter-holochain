// Host settings, picked in two places. The player, impostor and task counts go
// in the `Lobby` entry, so they're chosen on the entry screen when creating a
// lobby and fixed from then on. Everything else is picked in the lobby, until
// the game starts. The defaults match the coordinator's `GameSettings::default()`.

export type GameSettings = {
  crew_vision: number; // map px, 0 = no fog
  impostor_vision: number;
  kill_cooldown_s: number;
  discussion_s: number; // votes open after this
  voting_s: number; // 0 = no time limit
  task_bar: number; // the crew's task count updates: 0 always, 1 at meetings, 2 never
  emergency_meetings: number; // each player's, per game; 0 = none
  player_speed: number; // percent of normal
  kill_distance: number; // 0 short, 1 normal, 2 long — see KILL_DISTANCES
  confirm_ejects: boolean; // a voted-off player's role shows straight away
  anonymous_votes: boolean; // the tally hides who voted for whom
};

export const DEFAULT_SETTINGS: GameSettings = {
  crew_vision: 170,
  impostor_vision: 250,
  kill_cooldown_s: 20,
  discussion_s: 15,
  voting_s: 60,
  task_bar: 1,
  emergency_meetings: 1,
  player_speed: 100,
  kill_distance: 1,
  confirm_ejects: true,
  anonymous_votes: false,
};

export const PLAYER_COUNTS = [3, 4, 5, 6, 7, 8, 9, 10];
export const DEFAULT_PLAYERS = 4;

/** The most impostors a game can start with: they must start outnumbered, or
 *  they'd have won before anyone moves. */
export function maxImpostors(players: number): number {
  return Math.max(1, Math.ceil(players / 2) - 1);
}

export const KILL_COOLDOWNS = [10, 15, 20, 30, 45, 60];
export const DISCUSSION_TIMES = [0, 15, 30, 60, 90];
export const VOTING_TIMES = [30, 60, 90, 120, 0];

/** How the crew's task count shows. Live updates let a watcher catch an impostor
 *  "doing" a task that never counts; at meetings, it only tells how much got done. */
export const TASK_BAR_OPTIONS = [
  { value: 0, label: "Always" },
  { value: 1, label: "At meetings" },
  { value: 2, label: "Never" },
];

export const EMERGENCY_MEETINGS = [0, 1, 2, 3, 5];

export const PLAYER_SPEEDS = [50, 75, 100, 125, 150, 200];

export function speedLabel(percent: number): string {
  return `${percent / 100}x`;
}

/** How close an impostor stands to kill: map px, centre to centre. */
export const KILL_DISTANCES = [
  { value: 0, label: "Short", radius: 32 },
  { value: 1, label: "Normal", radius: 46 },
  { value: 2, label: "Long", radius: 70 },
];

export function killRadius(setting: number): number {
  return KILL_DISTANCES.find((d) => d.value === setting)?.radius ?? 46;
}

export function secondsLabel(seconds: number, zero: string): string {
  return seconds === 0 ? zero : `${seconds}s`;
}
