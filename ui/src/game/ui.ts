import { ROOM_NOT_FOUND } from "./registry.js";
// DOM for every screen except the <canvas> (main.ts owns that so it stays
// stable across re-renders). `screenHtml` fills the top region; `hudHtml` fills
// the in-game HUD. `bindActions` wires click delegation once.

import { COMMS_PANEL, CRISES, LIGHTS_PANEL, roomAt, ROOMS, TASK_TARGET, VENTS, VISION_PRESETS, type CrisisKind } from "./world.js";
import { colorHex } from "./colors.js";
import { hotelCrisisName, hotelRoomName, hotelTaskName } from "./hotel.js";
import { totalXp } from "./xp.js";
import {
  DISCUSSION_TIMES,
  EMERGENCY_MEETINGS,
  KILL_COOLDOWNS,
  KILL_DISTANCES,
  maxImpostors,
  PLAYER_COUNTS,
  PLAYER_SPEEDS,
  secondsLabel,
  speedLabel,
  TASK_BAR_OPTIONS,
  VOTING_TIMES,
  type GameSettings,
} from "./settings.js";

export type PlayerV = {
  key: unknown;
  keyB64: string;
  name: string;
  seat: number | null;
  dead: boolean;
  is_host: boolean;
  role: number | null;
  color: number; // palette index, by join order
};
export type StateV = {
  phase: "lobby" | "playing" | "meeting" | "ended";
  is_host: boolean;
  code: string | null;
  player_count: number;
  impostor_count: number;
  task_target: number;
  players: PlayerV[];
  roles_dealt: boolean;
  my_seat: number | null;
  my_role: number | null;
  tasks_done: number;
  tasks_done_at_meeting: number; // the count as it stood when the latest meeting opened
  my_tasks_done: number[];
  active_meeting: null | {
    meetingB64: string;
    opened_at_ms: number; // the meeting's timers count from here
    trigger: "body_report" | "emergency";
    /** Tie-breaker only: the tied options (seat, or null for Skip) — the only valid votes. */
    candidates: (number | null)[] | null;
    committed: string[]; // b64 keys
    revealed: string[];
    resolved:
      | null
      | { kind: "ejected"; seat: number }
      | { kind: "no_ejection" }
      | { kind: "tie"; candidates: (number | null)[] };
    /** Once tallied: the votes counted, by seat (choice null = Skip; voter null when votes are anonymous). */
    votes: { voter: number | null; choice: number | null }[];
  };
  role_reveals: [number, number][];
  result: null | {
    outcome: "crew_win" | "impostors_win";
    impostors_alive: number;
    crew_alive: number;
    tasks_done: number;
    tasks_total: number;
    meltdown: CrisisKind | null; // the impostors won because this crisis ran out
  };
  my_xp: number | null; // my XP for this game — tasks, survival, the win — once it's ended
  settings: GameSettings; // the host's; fixed once roles are dealt
  /** Bodies still on the map (killed since the latest meeting); `at` stays
   *  null until the victim's client has marked where they fell. */
  bodies: { keyB64: string; at: { x: number; y: number } | null }[];
  emergencies_left: number;
  emergency_ready_at: number | null; // ms since the epoch; null before the game starts
  kill_ready_at: number | null; // when I could kill again as an impostor; same clock
  lights_out: boolean; // sabotaged: crew vision shrinks until someone fixes them
  lights_ready_at: number | null; // when an impostor may next cut them; same clock
  comms_out: boolean; // sabotaged: task lists and the task bar go dark until someone fixes them
  comms_ready_at: number | null; // when an impostor may next cut comms; same clock
  doors_closed: { room: number; until_ms: number }[]; // rooms whose doors an impostor shut
  doors_ready_at: number | null; // when impostors may shut doors again; same clock
  /** A crisis sabotage under way: stabilise it before `ends_at_ms` or the impostors win. */
  crisis: { kind: CrisisKind; started_ms: number; ends_at_ms: number; panels: boolean[] } | null;
  crisis_ready_at: number | null; // when an impostor may next start one; same clock
  seat_lost: boolean; // I joined, but every seat went to someone else first
};

export type Tone = "ok" | "warn" | "bad" | "off";

/** What the entry screen has learned about the lobby code before joining. */
export type LobbyProbe = {
  code: string;
  round: number; // the room's current game: the first one that hasn't ended
  status: "connecting" | "no-conductor" | "looking";
  since: number; // when the search for this code started (ms)
  state: StateV | null; // last `get_game_state` on this code's clone cell
  relay: string | null; // relay address this game shares, if any
  relayFilledFrom: "local" | "game" | null; // the relay box was filled from a relay on this machine, or the game
  error: string | null;
};

/** Live PeerKit facts, refreshed by main.ts from `Movement`. */
export type PeerkitView = {
  enabled: boolean; // a relay address was given
  startError: string | null;
  startedAt: number;
  relayUp: boolean;
  livePlayers: string[]; // hc keys (b64) with a position received in the last 2 s
};

/** Sound and voice, refreshed by main.ts from `Sounds` and `Voice`. */
export type AudioView = {
  soundMuted: boolean;
  voiceUp: boolean; // voice chat is running (it rides on PeerKit)
  micOn: boolean;
  micError: string | null;
  deafened: boolean;
  talking: string[]; // hc keys (b64) of players I can hear talking right now
};

/** The room's next game, watched from the result screen once this one ends. */
export type NextGame = {
  state: StateV | null; // last `get_game_state` on the next game's clone
  wanted: boolean; // pressed Play again: join as soon as the host opens it
  busy: boolean;
};

export type Model = {
  entered: boolean;
  connecting: boolean;
  error: string | null;
  name: string;
  code: string; // the room: every game in it shares this code and the PeerKit relay
  round: number; // which game in the room this is (1 = the first)
  next: NextGame;
  hostOffline: boolean; // this game's host stopped answering, so the game can't go on
  myTasks: number[] | null; // my secret task list (console ids); null until the host sends it
  localDone: number[]; // tasks finished in this window: an impostor's fakes, a crewmate's not yet synced
  taskHold: { taskId: number; startedAt: number } | null; // Use being held at the lights panel
  vent: number | null; // the vent I'm hiding in (impostors)
  airlockLeft: number | null; // ms until the airlock lets me through; null when I'm not in it
  relayAddr: string;
  createOpts: { players: number; impostors: number; tasks: number }; // entry screen, for a lobby I create
  probe: LobbyProbe;
  peerkit: PeerkitView;
  audio: AudioView;
  state: StateV | null;
  myKeyB64: string;
  myRoleFromSignal: number | null; // 0 crew / 1 impostor / null
  near: {
    taskId: number | null;
    killKeyB64: string | null;
    bodyKeyB64: string | null;
    atEmergency: boolean;
    atLights: boolean; // at the lights panel
    atComms: boolean; // at the comms panel
    atVitals: boolean; // at the vitals panel
    atSecurity: boolean; // at the security console
    crisisPanel: number | null; // at this console of the crisis under way
    ventId: number | null; // a vent I (an impostor) can slip into
  };
  cooldownLeft: number;
  voteSalt: Uint8Array | null;
  myVoteChoice: string | null; // b64 or "skip" once committed
  dismissedMeeting: string | null; // meetingB64 whose result this player closed
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const roleTag = (r: number | null) =>
  r === 1 ? `<span class="tag impostor">IMPOSTOR</span>` : r === 0 ? `<span class="tag crew">CREWMATE</span>` : "";
const pill = (tone: Tone, text: string) => `<span class="pill ${tone}">${text}</span>`;
const keyHint = (k: string) => `<span class="key">${k}</span>`;
const enabledAttr = (on: boolean) => (on ? "" : "disabled");
/** A player's name with their color swatch. */
const playerName = (p: PlayerV) => `<span class="swatch" style="background:${colorHex(p.color)}"></span>${esc(p.name)}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function selectHtml(id: string, values: number[], selected: number): string {
  return `<select id="${id}">${values
    .map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`)
    .join("")}</select>`;
}

/** How a game is named on screen: the room code, plus its number after the first. */
export function gameName(code: string, round: number): string {
  return round > 1 ? `${code} · game ${round}` : code;
}

/** A game whose lobby exists and still has a free seat. */
export function hasOpenSeat(s: StateV | null): boolean {
  return !!s && s.code != null && s.phase === "lobby" && s.players.length < s.player_count;
}

export function screenHtml(m: Model, now = Date.now()): string {
  if (!m.entered) return entryScreen(m);
  const s = m.state;
  if (!s) return `<div class="card">Entering lobby…</div>`;
  if (m.hostOffline && s.phase !== "ended") return hostGoneHtml(m, s);
  if (s.seat_lost && s.phase !== "ended") return gameFullHtml();
  if (s.phase === "lobby") return lobbyScreen(m, s, now);
  if (s.phase === "meeting" || meetingResultPending(m)) return meetingScreen(m, s, now);
  if (s.phase === "ended") return resultScreen(m, s);
  return ""; // playing -> handled by the HUD
}

// --- entry: is the lobby ready to join? ------------------------------------

export type Readiness = {
  tone: Tone;
  label: string;
  detail: string; // HTML
  canCreate: boolean;
  canJoin: boolean;
  joinLabel: string;
};

export function lobbyReadiness(m: Model, now: number): Readiness {
  const p = m.probe;
  const code = esc(gameName(p.code, p.round));
  const blocked = { canCreate: false, canJoin: false, joinLabel: "Join lobby" };
  if (p.status === "connecting") {
    return { tone: "off", label: "Connecting…", detail: "Connecting to the game service.", ...blocked };
  }
  if (p.status === "no-conductor") {
    return { tone: "bad", label: "Connection unavailable", detail: "Can’t connect to the game service. Please try again.", ...blocked };
  }
  if (p.error) {
    const absent = p.error === ROOM_NOT_FOUND;
    return { tone: absent ? "warn" : "bad", label: absent ? "Room not found yet" : "Unable to join", detail: esc(p.error), canCreate: absent && !p.code.startsWith("LEGACY:"), canJoin: false, joinLabel: "Join lobby" };
  }
  const s = p.state;
  if (!s || s.code == null) {
    const secs = Math.max(0, Math.floor((now - p.since) / 1000));
    return {
      tone: "warn",
      label: "Searching…",
      detail: `No lobby “${code}” on the network yet (${secs}s). Host: create it. Everyone else: wait here — a new lobby takes a few seconds to reach you.`,
      canCreate: true,
      canJoin: false,
      joinLabel: "Join lobby",
    };
  }
  const me = s.players.find((pl) => pl.keyB64 === m.myKeyB64);
  const host = s.players.find((pl) => pl.is_host)?.name ?? "unknown";
  const count = `${s.players.length}/${s.player_count} players`;
  if (me && s.is_host) {
    return { tone: "ok", label: "Your lobby", detail: `You're the host of “${code}” · ${count}`, canCreate: false, canJoin: true, joinLabel: "Rejoin as host" };
  }
  if (me) {
    return { tone: "ok", label: "Already in", detail: `You already have a seat in “${code}” · ${count}`, canCreate: false, canJoin: true, joinLabel: "Rejoin" };
  }
  if (s.phase !== "lobby") {
    return { tone: "bad", label: "In progress", detail: `“${code}” has already started and can't take new players.`, ...blocked };
  }
  if (s.players.length >= s.player_count) {
    return { tone: "bad", label: "Full", detail: `“${code}” is full (${count}).`, ...blocked };
  }
  return { tone: "ok", label: "Ready to join", detail: `“${code}” · host ${esc(host)} · ${count}`, canCreate: false, canJoin: true, joinLabel: "Join lobby" };
}

function entryScreen(m: Model): string {
  // Static on purpose: the status and buttons live in their own elements so the
  // once-a-second refresh never rewrites an input while someone is typing.
  return `
  <section class="hotel-hero" aria-label="The Impossible Hotel">
    <p class="hotel-eyebrow">The Grand Celeste welcomes you</p>
    <h1 class="hotel-title">Imposter</h1>
    <p class="hotel-subtitle">The Impossible Hotel</p>
    <p class="hotel-tagline">Every guest has a secret. One of them shouldn't exist.</p>
  </section>
  <p class="hotel-section-title">Guest register · Check in</p>
  <div class="card">
    <div class="row" style="margin-bottom:10px">
      <label>Name <input id="f-name" value="${esc(m.name)}" placeholder="Alice" /></label>
      <label>Room code <input id="f-code" value="${esc(m.code)}" placeholder="ROOM-CODE" /></label>
    </div>
    <div class="row" style="margin-bottom:10px">
      <label style="flex:1">Relay address (optional — movement and chat)
        <input id="f-relay" style="width:100%" value="${esc(m.relayAddr)}" placeholder="fills in by itself when npm run relay runs here, or once a player shares one" />
      </label>
    </div>
    <div id="entry-banner"></div>
    <div class="row" style="margin-bottom:10px">
      <span class="muted">When you create a lobby:</span>
      <label>Players ${selectHtml("f-players", PLAYER_COUNTS, m.createOpts.players)}</label>
      <label>Impostors ${selectHtml("f-impostors", range(1, maxImpostors(PLAYER_COUNTS[PLAYER_COUNTS.length - 1])), m.createOpts.impostors)}</label>
      <label>Tasks each ${selectHtml("f-tasks", range(1, TASK_TARGET), m.createOpts.tasks)}</label>
    </div>
    <div id="entry-actions"></div>
    <p class="muted" style="margin-top:12px">Players, impostors and tasks are fixed once the lobby exists; the host picks the rest in the lobby. Share the room code with your friends. To join an older room, enter LEGACY: followed by its code.</p>
  </div>`;
}

export function entryBannerHtml(m: Model, now: number): string {
  const r = lobbyReadiness(m, now);
  const xp = totalXp();
  return `<div class="banner ${r.tone}">${pill(r.tone, r.label)}<span>${r.detail}</span></div>
    ${xp > 0 ? `<p class="muted" style="margin-top:6px">${xp} XP earned so far, on this device.</p>` : ""}
    ${
      m.probe.relayFilledFrom
        ? `<p class="muted" style="margin-top:6px">${
            m.probe.relayFilledFrom === "local" ? "Found the relay running on this machine." : "Relay address filled in from the game."
          }</p>`
        : ""
    }
    ${m.error ? `<p class="tag impostor" style="margin-top:10px">${esc(m.error)}</p>` : ""}`;
}

export function entryActionsHtml(m: Model, now: number): string {
  const r = lobbyReadiness(m, now);
  const busy = m.connecting;
  return `<div class="row">
      <button ${r.canCreate ? `class="primary"` : ""} data-act="create" ${enabledAttr(r.canCreate && !busy)}>Create Private Game</button>
      <button ${r.canJoin ? `class="primary"` : ""} data-act="join" ${enabledAttr(r.canJoin && !busy)}>${busy ? "Joining…" : r.joinLabel}</button>
    </div>`;
}

// --- PeerKit: is movement actually flowing? ----------------------------------

export function peerkitStatus(m: Model, now: number): { tone: Tone; text: string } {
  const pk = m.peerkit;
  if (!pk.enabled) return { tone: "off", text: "PeerKit off · no relay address" };
  if (pk.startError) return { tone: "bad", text: `PeerKit failed to start · ${esc(pk.startError)}` };
  const others = (m.state?.players ?? []).filter((p) => p.keyB64 !== m.myKeyB64);
  const live = others.filter((p) => pk.livePlayers.includes(p.keyB64)).length;
  // Positions flow over direct peer connections, so full coverage is "live"
  // even if the relay has since gone away.
  if (others.length > 0 && live === others.length) {
    return { tone: "ok", text: `PeerKit live · ${live}/${others.length} players` };
  }
  if (!pk.relayUp) {
    if (now - pk.startedAt < 10_000) return { tone: "warn", text: "PeerKit connecting to relay…" };
    const partial = live > 0 ? ` · live with ${live}/${others.length}` : "";
    return { tone: "bad", text: `PeerKit can't reach the relay${partial} · is it running, and is the address right?` };
  }
  if (others.length === 0) return { tone: "warn", text: "PeerKit relay connected · waiting for other players" };
  return { tone: "warn", text: `PeerKit relay connected · live with ${live}/${others.length} players` };
}

function movementCell(m: Model, p: PlayerV): string {
  if (p.keyB64 === m.myKeyB64) return `<span class="muted">you</span>`;
  return m.peerkit.livePlayers.includes(p.keyB64)
    ? `<span class="live on">● live</span>`
    : `<span class="live">○ no signal</span>`;
}

// --- sound & voice ---------------------------------------------------------------

/** Sound, mic and deafen toggles, shown on every screen once in a game. The
 *  "talking" line lives in its own element (`talkingHtml`), so it can change
 *  many times a second without rewriting these buttons mid-click. */
export function audioBarHtml(m: Model): string {
  const a = m.audio;
  const iAmDead = m.state?.players.find((p) => p.keyB64 === m.myKeyB64)?.dead ?? false;
  let note = "";
  if (!a.voiceUp) note = "Voice chat needs PeerKit — join with a relay address.";
  else if (a.micError) note = `Mic unavailable: ${esc(a.micError)}`;
  else if (a.micOn && iAmDead) note = "You're a ghost — only other ghosts hear you.";
  return `
    <button data-act="toggle-sound" class="${a.soundMuted ? "" : "on"}">${a.soundMuted ? "Sound off" : "Sound on"}</button>
    <button data-act="toggle-mic" class="${a.micOn ? "on" : ""}" ${enabledAttr(a.voiceUp)}>${a.micOn ? "Mic on" : "Mic off"}${keyHint("V")}</button>
    <button data-act="toggle-deafen" class="${a.deafened ? "" : "on"}" ${enabledAttr(a.voiceUp)}>${a.deafened ? "Deafened" : "Hearing voices"}</button>
    ${note ? `<span class="muted">${note}</span>` : ""}`;
}

export function talkingHtml(m: Model): string {
  if (m.audio.talking.length === 0) return "";
  const names = new Map((m.state?.players ?? []).map((p) => [p.keyB64, p.name]));
  return `Talking: ${m.audio.talking.map((k) => esc(names.get(k) ?? "?")).join(", ")}`;
}

// --- screens -------------------------------------------------------------------

function lobbyScreen(m: Model, s: StateV, now: number): string {
  const full = s.players.length >= s.player_count;
  const pk = peerkitStatus(m, now);
  return `
  <h1>LOBBY · ${esc(gameName(m.code, m.round))}</h1>
  <div class="card">
    <p>${s.players.length} / ${s.player_count} players · ${s.impostor_count} impostor(s) · ${Math.ceil(
      s.task_target / Math.max(1, s.player_count - s.impostor_count),
    )} tasks each</p>
    ${settingsHtml(s)}
    <p>${pill(pk.tone, pk.text)}</p>
    <table>
      <tbody>
        ${s.players
          .map(
            (p) =>
              `<tr><td>${playerName(p)}</td><td class="muted">${p.is_host ? "host" : ""}${
                p.keyB64 === m.myKeyB64 ? " (you)" : ""
              }</td>${m.peerkit.enabled ? `<td>${movementCell(m, p)}</td>` : ""}</tr>`,
          )
          .join("")}
      </tbody>
    </table>
    ${
      s.is_host
        ? `<div class="row" style="margin-top:12px"><button class="primary" data-act="start" ${
            full ? "" : "disabled"
          }>Start game</button>${full ? "" : `<span class="muted">waiting for players…</span>`}</div>`
        : `<p class="muted" style="margin-top:12px">Waiting for the host to start…</p>`
    }
    ${m.error ? `<p class="tag impostor" style="margin-top:10px">${esc(m.error)}</p>` : ""}
  </div>`;
}

/** The host's settings: pickers for the host, a readout for everyone else.
 *  main.ts sends a change to `set_settings`. */
function settingsHtml(s: StateV): string {
  const g = s.settings;
  type Option = { value: number; label: string };
  const pick = (id: string, label: string, value: number, options: Option[]) =>
    s.is_host
      ? `<label>${label} <select id="${id}">${options
          .map((o) => `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`)
          .join("")}</select></label>`
      : `<span>${label}: <strong>${options.find((o) => o.value === value)?.label ?? value}</strong></span>`;
  const vision: Option[] = VISION_PRESETS.map((p) => ({ value: p.radius, label: p.label }));
  const seconds = (values: number[], zero: string): Option[] =>
    values.map((v) => ({ value: v, label: secondsLabel(v, zero) }));
  // on/off settings are bools; their pickers hold 1 / 0 (main.ts converts back)
  const onOff: Option[] = [
    { value: 1, label: "On" },
    { value: 0, label: "Off" },
  ];
  return `<div class="row" style="margin:8px 0 4px">
    ${pick("f-crew-vision", "Crew vision", g.crew_vision, vision)}
    ${pick("f-impostor-vision", "Impostor vision", g.impostor_vision, vision)}
    ${pick("f-kill-cooldown", "Kill cooldown", g.kill_cooldown_s, seconds(KILL_COOLDOWNS, "none"))}
    ${pick("f-discussion", "Discussion", g.discussion_s, seconds(DISCUSSION_TIMES, "none"))}
    ${pick("f-voting", "Voting", g.voting_s, seconds(VOTING_TIMES, "no limit"))}
    ${pick("f-task-bar", "Task bar", g.task_bar, TASK_BAR_OPTIONS)}
    ${pick(
      "f-emergencies",
      "Emergency meetings",
      g.emergency_meetings,
      EMERGENCY_MEETINGS.map((n) => ({ value: n, label: n === 0 ? "none" : String(n) })),
    )}
    ${pick("f-speed", "Player speed", g.player_speed, PLAYER_SPEEDS.map((p) => ({ value: p, label: speedLabel(p) })))}
    ${pick("f-kill-distance", "Kill distance", g.kill_distance, KILL_DISTANCES)}
    ${pick("f-confirm-ejects", "Confirm ejects", Number(g.confirm_ejects), onOff)}
    ${pick("f-anonymous-votes", "Anonymous votes", Number(g.anonymous_votes), onOff)}
  </div>
  <p class="muted" style="margin:0 0 12px">Ghosts see the whole map.</p>`;
}

/** Where a meeting stands on its timers: discussion first (a tie breaker has
 *  none), then voting, which closes after the voting time if there is one. */
export function meetingClock(s: StateV, now: number): { discussing: boolean; votingEndsAt: number | null; text: string } {
  const mt = s.active_meeting;
  if (!mt || mt.resolved) return { discussing: false, votingEndsAt: null, text: "" };
  const votingOpensAt = mt.opened_at_ms + (mt.candidates ? 0 : s.settings.discussion_s * 1000);
  const votingEndsAt = s.settings.voting_s > 0 ? votingOpensAt + s.settings.voting_s * 1000 : null;
  if (now < votingOpensAt) {
    return { discussing: true, votingEndsAt, text: `Discussion — voting opens in ${Math.ceil((votingOpensAt - now) / 1000)}s` };
  }
  if (votingEndsAt === null) return { discussing: false, votingEndsAt, text: "Voting — no time limit" };
  const left = Math.ceil((votingEndsAt - now) / 1000);
  return { discussing: false, votingEndsAt, text: left > 0 ? `Voting ends in ${left}s` : "Voting closed — tallying…" };
}

/** A finished meeting's result stays on screen until this player closes it, so
 *  everyone sees who was voted off — even though the game is back to `playing`. */
function meetingResultPending(m: Model): boolean {
  const mt = m.state?.active_meeting;
  return (
    m.state?.phase === "playing" &&
    !!mt?.resolved &&
    mt.resolved.kind !== "tie" &&
    mt.meetingB64 !== m.dismissedMeeting
  );
}

/** Out on the map: movement, tasks, kills and the HUD are live. */
export function inPlay(m: Model): boolean {
  return m.state?.phase === "playing" && !m.state.seat_lost && !meetingResultPending(m);
}

/** Two players went for the last seat at once and the other one got it. */
function gameFullHtml(): string {
  return `
  <h1>GAME FULL</h1>
  <div class="card">
    <p>${GAME_FULL}</p>
    <div class="row"><button class="primary" data-act="leave">Back to menu</button></div>
  </div>`;
}

const GAME_FULL = "Game full: every seat was taken just before you joined.";

/** An error as the player should read it. The zome's "game full" refusal is
 *  the one a player can hit in normal play. */
export function errorText(e: unknown): string {
  const raw = String((e as { message?: unknown })?.message ?? e);
  return /game full/i.test(raw) ? GAME_FULL : raw;
}

function meetingScreen(m: Model, s: StateV, now: number): string {
  const mt = s.active_meeting!;
  // The countdown itself goes into #meeting-timer from main.ts, so it can tick
  // without rewriting these buttons mid-click; only discussion → voting does.
  const clock = meetingClock(s, now);
  const committed = new Set(mt.committed);
  const revealed = new Set(mt.revealed);
  const iCommitted = committed.has(m.myKeyB64);
  const iRevealed = revealed.has(m.myKeyB64);
  const iAmDead = s.players.find((p) => p.keyB64 === m.myKeyB64)?.dead ?? false;
  const living = s.players.filter((p) => !p.dead);
  const allRevealed = living.every((p) => revealed.has(p.keyB64));
  // null: the full ballot. Otherwise a tie-breaker, limited to these options.
  const ballot = mt.candidates;
  const optionName = (seat: number | null) =>
    seat === null ? "Skip" : esc(s.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`);
  const listOptions = (seats: (number | null)[]) => {
    const names = seats.map(optionName);
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
  };
  // The host's window tallies by itself once every living player has revealed.
  const tallyControl = s.is_host
    ? `<button data-act="resolve">${allRevealed ? "Tally votes" : "Tally now"}</button>`
    : `<p class="muted">The host tallies once everyone has revealed${clock.votingEndsAt ? ", or when time runs out" : ""}.</p>`;

  let body = "";
  const r = mt.resolved;
  if (r?.kind === "tie") {
    body = `<p><strong>It's a tie between ${listOptions(r.candidates)}.</strong></p>
      <p class="muted">Starting the tie breaker…</p>`;
  } else if (r) {
    body = `${ejectionHtml(s, r.kind === "ejected" ? r.seat : null)}
      ${voteTallyHtml(s)}
      ${ballot ? `<p class="muted">Decided by the tie breaker.</p>` : ""}
      <button class="primary" data-act="dismiss-meeting">Back to the game</button>`;
  } else if (ballot?.length === 0) {
    body = `<p class="muted">Loading the tie-breaker ballot…</p>`;
  } else if (iAmDead) {
    body = `<p class="muted">You are dead — spectating. Votes in: ${revealed.size} / ${living.length}.</p>
      ${tallyControl}`;
  } else if (!iCommitted) {
    const options = ballot ? s.players.filter((p) => p.seat !== null && ballot.includes(p.seat)) : living;
    const canSkip = !ballot || ballot.includes(null);
    const open = enabledAttr(!clock.discussing);
    const prompt = clock.discussing
      ? "Discuss first — the ballot opens when the discussion time is up:"
      : ballot
        ? "Vote again — only the tied options are on the ballot:"
        : "Cast a hidden vote:";
    body = `<p>${prompt}</p><div class="row">
      ${options
        .map(
          (p) =>
            `<button data-act="commit-vote" data-choice="${p.keyB64}" ${open}>${playerName(p)}${
              p.keyB64 === m.myKeyB64 ? " (you)" : ""
            }</button>`,
        )
        .join("")}
      ${canSkip ? `<button data-act="commit-vote" data-choice="skip" ${open}>Skip</button>` : ""}
    </div>`;
  } else if (!iRevealed) {
    body = `<p>Your vote is in (${committed.size} / ${living.length} voted). It's revealed by itself once everyone has voted${
      clock.votingEndsAt ? " or time is nearly up" : ""
    }.</p>`;
  } else {
    body = `<p class="muted">Revealed. Waiting on others (${revealed.size} / ${living.length}).</p>
      ${tallyControl}`;
  }

  const tieNote =
    ballot?.length && !r
      ? `<p>The vote tied between ${listOptions(ballot)}. If the tie breaker ties too, a random draw decides.</p>`
      : "";
  return `
  <h1>${ballot ? "THE SECOND BALLOT" : "GRAND SALON · EMERGENCY ASSEMBLY"}</h1>
  <div class="card">
    <p class="muted">${mt.trigger === "body_report" ? "A body was reported." : "Emergency button pressed."} ${taskBarText(s)}</p>
    ${tieNote}
    ${r ? "" : `<p id="meeting-timer" class="muted"></p>`}
    ${body}
    ${m.error ? `<p class="tag impostor" style="margin-top:10px">${esc(m.error)}</p>` : ""}
  </div>`;
}

/** What the ejection screen says: who went out, then — when the host's settings
 *  confirm ejects and their role has been opened — whether they were an
 *  impostor, and how many impostors remain. */
export function ejectionText(s: StateV, seat: number | null): { line: string; details: string[] } {
  if (seat === null) return { line: "No one was removed from the network.", details: ["(Skipped)"] };
  const name = s.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat}`;
  const line = `${name} was voted out of the network.`;
  const role = s.role_reveals.find(([st]) => st === seat)?.[1];
  if (!s.settings.confirm_ejects || role === undefined) return { line, details: [] };
  const out = s.role_reveals.filter(([st, rl]) => rl === 1 && s.players.some((p) => p.seat === st && p.dead)).length;
  const left = Math.max(0, s.impostor_count - out);
  return {
    line,
    details: [
      `${name} was ${role === 1 ? "" : "not "}an Impostor.`,
      `${left} Impostor${left === 1 ? " remains" : "s remain"}.`,
    ],
  };
}

/** The ejection screen: the player's node on the network graph, its links to the
 *  other agents severing, then the text. */
function ejectionHtml(s: StateV, seat: number | null): string {
  const { line, details } = ejectionText(s, seat);
  const p = seat === null ? undefined : s.players.find((pl) => pl.seat === seat);
  return `<div class="eject">
    ${p ? `<div class="eject-net">${[0, 60, 120, 180, 240, 300].map((a) => `<div class="eject-spoke" style="--a:${a}deg"></div>`).join("")}<div class="eject-node" style="--c:${colorHex(p.color)}"></div></div>` : ""}
    <p class="eject-line">${esc(line)}</p>
    ${details.map((d, i) => `<p class="eject-detail" style="animation-delay:${2.4 + i * 0.6}s">${esc(d)}</p>`).join("")}
  </div>`;
}

/** The tally, option by option, most votes first: the seats that voted for each
 *  (null voters when votes are anonymous). */
export function voteGroups(s: StateV): { choice: number | null; voters: (number | null)[] }[] {
  const groups = new Map<number | null, (number | null)[]>();
  for (const v of s.active_meeting?.votes ?? []) groups.set(v.choice, [...(groups.get(v.choice) ?? []), v.voter]);
  return [...groups.entries()]
    .map(([choice, voters]) => ({ choice, voters }))
    .sort((a, b) => b.voters.length - a.voters.length || (a.choice ?? Infinity) - (b.choice ?? Infinity));
}

function voteTallyHtml(s: StateV): string {
  const groups = voteGroups(s);
  if (groups.length === 0) return "";
  const bySeat = (seat: number | null) => (seat === null ? undefined : s.players.find((p) => p.seat === seat));
  const voter = (seat: number | null) => {
    const p = bySeat(seat);
    return p
      ? `<span class="swatch" title="${esc(p.name)}" style="background:${colorHex(p.color)}"></span>`
      : `<span class="swatch anon"></span>`;
  };
  const rows = groups.map(({ choice, voters }) => {
    const p = bySeat(choice);
    return `<tr><td>${p ? playerName(p) : "Skip"}</td><td>${voters.length}</td><td>${voters.map(voter).join("")}</td></tr>`;
  });
  return `<table class="votes"><tbody>${rows.join("")}</tbody></table>
    ${s.settings.anonymous_votes ? `<p class="muted">Votes are anonymous.</p>` : ""}`;
}

/** A player on the vitals panel. Dead shows as soon as a kill is recorded,
 *  reported or not. Disconnected: no position over PeerKit for a couple of
 *  seconds — unknowable while PeerKit is down, so then everyone shows OK. */
export function vitalsStatus(m: Model, p: PlayerV): "ok" | "dead" | "disconnected" {
  if (p.dead) return "dead";
  if (p.keyB64 !== m.myKeyB64 && m.peerkit.relayUp && !m.peerkit.livePlayers.includes(p.keyB64)) return "disconnected";
  return "ok";
}

export function vitalsHtml(m: Model): string {
  const s = m.state;
  if (!s) return "";
  const label = { ok: pill("ok", "OK"), dead: pill("bad", "DEAD"), disconnected: pill("off", "DISCONNECTED") };
  // A scanned or ejected player's role is public from then on — the medbay
  // scan's payoff: proof of crew nobody can fake, shown wherever roles show.
  const revealed = new Map(s.role_reveals);
  const rows = [...s.players]
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
    .map(
      (p) =>
        `<tr><td>${playerName(p)}</td><td>${label[vitalsStatus(m, p)]}</td><td>${
          p.seat !== null ? roleTag(revealed.get(p.seat) ?? null) : ""
        }</td></tr>`,
    );
  return `<table><tbody>${rows.join("")}</tbody></table>`;
}

function resultScreen(m: Model, s: StateV): string {
  const r = s.result!;
  const win = r.outcome === "impostors_win" ? "IMPOSTORS WIN" : "CREWMATES WIN";
  return `
  <h1>${win}</h1>
  <div class="card">
    ${r.meltdown ? `<p><strong>${hotelCrisisName(r.meltdown)} wasn't stabilised in time.</strong></p>` : ""}
    <p>Impostors alive ${r.impostors_alive} · Crew alive ${r.crew_alive} · Tasks ${r.tasks_done}/${r.tasks_total}</p>
    ${s.my_xp != null ? `<p>You earned <strong>${s.my_xp} XP</strong> this game · <strong>${totalXp()} XP</strong> total.</p>` : ""}
    <table>
      <thead><tr><th>Seat</th><th>Player</th><th>Role</th></tr></thead>
      <tbody>
        ${[...s.players]
          .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
          .map(
            (p) =>
              `<tr><td>${p.seat}</td><td class="${p.dead ? "dead" : ""}">${playerName(p)}</td><td>${roleTag(
                s.role_reveals.find(([seat]) => seat === p.seat)?.[1] ?? p.role,
              )}</td></tr>`,
          )
          .join("")}
      </tbody>
    </table>
    ${nextGameHtml(m, s)}
  </div>`;
}

/** The host stopped answering. It deals, tallies, publishes the result and alone
 *  knows the roles, so the game can't go on; the room can start a new one. */
function hostGoneHtml(m: Model, s: StateV): string {
  const host = esc(s.players.find((p) => p.is_host)?.name ?? "The host");
  return `
  <h1>HOST LEFT</h1>
  <div class="card">
    <p><strong>${host} isn't answering.</strong> Only the host can deal roles, tally votes and
      publish the result, and only they know who the impostors are, so this game can't go on.
      If they come back, it carries on where it stopped.</p>
    ${nextGameHtml(m, s)}
  </div>`;
}

/** After the result — or once the host has gone — the room's next game. This
 *  game's host opens it, or anyone if that host has gone; everyone else joins
 *  it, by themselves once they have pressed Play again. */
function nextGameHtml(m: Model, s: StateV): string {
  const next = m.next.state;
  const host = esc(s.players.find((p) => p.is_host)?.name ?? "the host");
  const opener = esc(next?.players.find((p) => p.is_host)?.name ?? "someone");
  const busy = m.next.busy;
  let status: string;
  let button = "";
  if (s.is_host) {
    status = "Open the next game with the same settings. Players who press Play again join it automatically.";
    button = `<button class="primary" data-act="play-again" ${enabledAttr(!busy)}>${busy ? "Opening…" : "New game"}</button>`;
  } else if (hasOpenSeat(next)) {
    status = `${opener} opened the next game · ${next!.players.length}/${next!.player_count} players`;
    button = `<button class="primary" data-act="play-again" ${enabledAttr(!busy && !m.next.wanted)}>${
      busy || m.next.wanted ? "Joining…" : "Join next game"
    }</button>`;
  } else if (next?.code != null) {
    status = next.phase === "lobby" ? "The next game is full." : "The next game has already started without you.";
  } else if (m.hostOffline) {
    status = `${host} has gone, so someone else needs to host the next game.`;
    button = `<button class="primary" data-act="play-again" ${enabledAttr(!busy)}>${busy ? "Opening…" : "New game (you host)"}</button>`;
  } else if (m.next.wanted) {
    status = `Waiting for ${host} to open the next game — you'll join it automatically.`;
    button = `<button disabled>Waiting…</button>`;
  } else {
    status = `Waiting for ${host} to open the next game.`;
    button = `<button class="primary" data-act="play-again">Play again</button>`;
  }
  return `
    <p class="muted" style="margin-top:12px">${status}</p>
    <div class="row">${button}<button data-act="leave">Back to menu</button></div>
    ${m.error ? `<p class="tag impostor" style="margin-top:10px">${esc(m.error)}</p>` : ""}`;
}

export function myRole(m: Model): number | null {
  return m.myRoleFromSignal ?? m.state?.my_role ?? null;
}

// --- in-game HUD -----------------------------------------------------------------

export type HudAction = "use-task" | "kill" | "report" | "emergency" | "sabotage" | "sabotage-comms" | "vent";

/** In-game keyboard shortcuts, key → action. Handled in main.ts. */
export const SHORTCUTS: Record<string, HudAction> = {
  e: "use-task",
  q: "kill",
  r: "report",
  m: "emergency",
  l: "sabotage",
  c: "sabotage-comms",
  f: "vent",
};

/** The emergency button: pressable only at the button, with a use left and
 *  its cooldown over (the zome checks the same, bar the position). */
export function emergencyStatus(m: Model, now = Date.now()): { ready: boolean; label: string } {
  const s = m.state;
  if (!s) return { ready: false, label: "Emergency" };
  if (s.settings.emergency_meetings === 0) return { ready: false, label: "No emergency meetings" };
  if (s.emergencies_left <= 0) return { ready: false, label: "Emergency (used)" };
  const wait = s.emergency_ready_at == null ? 0 : s.emergency_ready_at - now;
  if (wait > 0) return { ready: false, label: `Emergency ${Math.ceil(wait / 1000)}s` };
  if (s.crisis) return { ready: false, label: "Emergency (crisis under way)" };
  if (!m.near.atEmergency) return { ready: false, label: "Emergency (at the red button)" };
  return { ready: true, label: `Emergency (${s.emergencies_left} left)` };
}

/** The impostors' lights sabotage: ready when off cooldown and not already out. */
export function sabotageStatus(m: Model, now = Date.now()): { ready: boolean; label: string } {
  const s = m.state;
  if (!s) return { ready: false, label: "Sabotage lights" };
  if (s.lights_out) return { ready: false, label: "Lights are out" };
  const wait = (s.lights_ready_at ?? 0) - now;
  if (wait > 0) return { ready: false, label: `Sabotage ${Math.ceil(wait / 1000)}s` };
  return { ready: true, label: "Sabotage lights" };
}

/** The impostors' comms sabotage: ready when off cooldown and not already out. */
export function commsStatus(m: Model, now = Date.now()): { ready: boolean; label: string } {
  const s = m.state;
  if (!s) return { ready: false, label: "Sabotage comms" };
  if (s.comms_out) return { ready: false, label: "Comms are down" };
  const wait = (s.comms_ready_at ?? 0) - now;
  if (wait > 0) return { ready: false, label: `Sabotage comms ${Math.ceil(wait / 1000)}s` };
  return { ready: true, label: "Sabotage comms" };
}

/** Impostors' door lockdown: ready once its cooldown is over. */
export function doorsStatus(m: Model, now = Date.now()): { ready: boolean; label: string } {
  const wait = (m.state?.doors_ready_at ?? 0) - now;
  return wait > 0 ? { ready: false, label: `Lockdown ${Math.ceil(wait / 1000)}s` } : { ready: true, label: "Lockdown" };
}

/** The impostors' crisis sabotages: one at a time, then a cooldown. */
export function crisisStatus(m: Model, now = Date.now()): { ready: boolean; label: string } {
  const s = m.state;
  if (!s) return { ready: false, label: "Crisis" };
  if (s.crisis) return { ready: false, label: "Crisis under way" };
  const wait = (s.crisis_ready_at ?? 0) - now;
  if (wait > 0) return { ready: false, label: `Crisis ${Math.ceil(wait / 1000)}s` };
  return { ready: true, label: "Crisis" };
}

/** An impostor's extra tools: hopping along the Maintenance Network from
 *  inside it, starting a crisis, and locking a room's doors down. */
function impostorToolsHtml(m: Model, now: number): string {
  const s = m.state!;
  const here = VENTS.find((v) => v.id === m.vent);
  const hops = here
    ? `<span class="muted">Maintenance to:</span>${here.links
        .map((id) => `<button data-act="vent-to" data-vent="${id}">${esc(hotelRoomName(VENTS.find((v) => v.id === id)!.room))}</button>`)
        .join("")}`
    : "";
  const crisis = crisisStatus(m, now);
  const crises = (Object.keys(CRISES) as CrisisKind[])
    .map(
      (kind) =>
        `<button data-act="crisis" data-kind="${kind}" ${enabledAttr(inPlay(m) && crisis.ready)}>${hotelCrisisName(kind)}</button>`,
    )
    .join("");
  const doors = doorsStatus(m, now);
  const shut = new Set(s.doors_closed.filter((d) => d.until_ms > now).map((d) => d.room));
  const rooms = ROOMS.map(
    (r, i) =>
      `<button data-act="close-doors" data-room="${i}" ${enabledAttr(inPlay(m) && doors.ready && !shut.has(i))}>${esc(hotelRoomName(r.name))}</button>`,
  ).join("");
  return `<div class="row" style="margin-top:6px">${hops}<span class="muted">${crisis.label}:</span>${crises}</div>
    <div class="row" style="margin-top:6px"><span class="muted">${doors.label}:</span>${rooms}</div>`;
}

/** Where a sabotage panel is, for the crew's warning banner. */
const roomOf = (p: { x: number; y: number }) => hotelRoomName(roomAt(p.x, p.y)?.name ?? "the corridor");

/** The crisis banner: what's failing, how long is left, and which consoles
 *  still need someone. At the reactor, two players at once. */
export function crisisBannerHtml(m: Model, now = Date.now()): string {
  const c = m.state?.crisis;
  if (!c) return "";
  const def = CRISES[c.kind];
  const left = Math.max(0, Math.ceil((c.ends_at_ms - now) / 1000));
  const consoles = def.panels
    .map((p, i) => `${c.panels[i] ? "✔" : "✖"} ${esc(roomOf(p))}`)
    .join(" · ");
  const what =
    c.kind === "reactor"
      ? "Hold both reactor consoles at the same time — two crew needed."
      : c.kind === "life_support"
        ? "Restore both terminals."
        : "Correct course at all three consoles.";
  // holding one reactor console while the other isn't held
  const second =
    c.kind === "reactor" && m.near.crisisPanel !== null && m.taskHold && c.panels.filter(Boolean).length < 2
      ? ` <strong>Second Confirmation Required.</strong>`
      : "";
  return `<p class="tag impostor" style="margin-top:6px">⚠ ${hotelCrisisName(c.kind).toUpperCase()} — ${left}s · ${what}${second}<br>${consoles}</p>`;
}

/** The crew's task count, as far as the host's task bar setting shows it — or
 *  a comms sabotage, which blanks it regardless of that setting. */
export function taskBarText(s: StateV): string {
  if (s.comms_out) return "Tasks: comms down";
  if (s.settings.task_bar === 2) return "Tasks: hidden";
  if (s.settings.task_bar === 1) return `Tasks ${s.tasks_done_at_meeting}/${s.task_target} (at the last meeting)`;
  return `Tasks ${s.tasks_done}/${s.task_target}`;
}

/** My secret task list, crossed off as I go. An impostor's is cover: it gets
 *  faked, never recorded. A comms sabotage hides it, for crew and impostors alike. */
function myTaskListHtml(m: Model): string {
  if (m.state?.comms_out) return `<span class="muted">Comms are down — task list hidden.</span>`;
  if (!m.myTasks?.length) return `<span class="muted">Waiting for your tasks…</span>`;
  const done = new Set([...(m.state?.my_tasks_done ?? []), ...m.localDone]);
  const names = m.myTasks.map((id) => {
    const name = esc(hotelTaskName(id));
    return done.has(id) ? `<s>${name}</s>` : name;
  });
  return `<span class="muted">${myRole(m) === 1 ? "Your cover tasks" : "Your tasks"}: ${names.join(" · ")}</span>`;
}

/** Which in-game actions are available right now. Shared by the HUD buttons
 *  and the keyboard shortcuts so a key can never do what its button can't. */
export function hudEnabled(m: Model): Record<HudAction, boolean> {
  const s = m.state;
  const amImpostor = myRole(m) === 1;
  const iAmDead = s?.players.find((p) => p.keyB64 === m.myKeyB64)?.dead ?? false;
  const alive = inPlay(m) && !iAmDead && m.vent === null; // from inside a vent: only hopping and sabotage
  return {
    // Consoles: crew ghosts too — their tasks still count — and
    // living impostors, who fake theirs. Vitals: anyone. The lights panel needs
    // someone alive.
    "use-task":
      inPlay(m) &&
      m.vent === null &&
      (m.near.taskId !== null
        ? !(iAmDead && amImpostor)
        : m.near.atVitals ||
          m.near.atSecurity ||
          (alive &&
            ((!!s?.lights_out && m.near.atLights) ||
              (!!s?.comms_out && m.near.atComms) ||
              m.near.crisisPanel !== null))),
    kill: alive && amImpostor && !!m.near.killKeyB64 && m.cooldownLeft <= 0,
    report: alive && !!m.near.bodyKeyB64,
    emergency: alive && emergencyStatus(m).ready,
    sabotage: inPlay(m) && amImpostor && sabotageStatus(m).ready, // ghosts too
    "sabotage-comms": inPlay(m) && amImpostor && commsStatus(m).ready,
    vent: inPlay(m) && amImpostor && !iAmDead && (m.vent !== null || m.near.ventId !== null),
  };
}

/** The Use button's label when there's no console nearby. */
function useElsewhereLabel(m: Model): string {
  if (m.near.atVitals) return "Vitals";
  if (m.near.atSecurity) return "Security";
  if (m.near.crisisPanel !== null && m.state?.crisis?.kind === "reactor") return "Hold to stabilise";
  if (m.near.atComms) return "Hold to fix comms";
  return "Hold to fix";
}

export function hudHtml(m: Model, now = Date.now()): string {
  const s = m.state;
  if (!s || !inPlay(m)) return "";
  const role = myRole(m);
  const amImpostor = role === 1;
  const iAmDead = s.players.find((p) => p.keyB64 === m.myKeyB64)?.dead ?? false;
  const can = hudEnabled(m);
  const pk = peerkitStatus(m, now);

  return `
  <div class="row" style="justify-content:space-between;margin-top:10px">
    <div class="row">${iAmDead ? `<span class="tag">GHOST</span>` : roleTag(role)}
      ${role === null ? pill("warn", "Verifying identity…") : pill("ok", "Identity Verified")}
      <span class="muted">${taskBarText(s)}</span>
      ${myTaskListHtml(m)}
      ${pill(pk.tone, pk.text)}
    </div>
    <div class="row">
      <button data-act="use-task" ${enabledAttr(can["use-task"])}>${m.near.taskId !== null ? "Use" : useElsewhereLabel(m)}${keyHint("E")}</button>
      ${
        amImpostor
          ? `<button data-act="kill" ${enabledAttr(can.kill)}>Kill${
              m.cooldownLeft > 0 ? ` ${Math.ceil(m.cooldownLeft / 1000)}s` : ""
            }${keyHint("Q")}</button><button data-act="sabotage" ${enabledAttr(can.sabotage)}>${
              sabotageStatus(m, now).label
            }${keyHint("L")}</button><button data-act="sabotage-comms" ${enabledAttr(can["sabotage-comms"])}>${
              commsStatus(m, now).label
            }${keyHint("C")}</button><button data-act="vent" ${enabledAttr(can.vent)}>${
              m.vent !== null ? "Exit passage" : "Staff passage"
            }${keyHint("F")}</button>`
          : ""
      }
      <button data-act="report" ${enabledAttr(can.report)}>Report body${keyHint("R")}</button>
      <button data-act="emergency" ${enabledAttr(can.emergency)}>${emergencyStatus(m, now).label}${keyHint("M")}</button>
    </div>
  </div>
  ${amImpostor ? impostorToolsHtml(m, now) : ""}
  ${crisisBannerHtml(m, now)}
  ${s.lights_out ? `<p class="tag impostor" style="margin-top:6px">Lights are out! Fix them at the panel in ${roomOf(LIGHTS_PANEL)}.</p>` : ""}
  ${s.comms_out ? `<p class="tag impostor" style="margin-top:6px">Comms are down! Fix them at the panel in ${roomOf(COMMS_PANEL)}.</p>` : ""}
  ${m.airlockLeft !== null ? `<p class="tag" style="margin-top:6px">${m.airlockLeft > 0 ? `Steam doors cycling… ${(m.airlockLeft / 1000).toFixed(1)}s` : "Decontamination complete — inner door open."}</p>` : ""}
  <p class="muted" style="margin-top:6px">Move with arrow keys / WASD.${
    pk.tone === "ok" ? "" : " Other players only move on your map while PeerKit is live; until then they sit at placeholder spots."
  }</p>
  ${m.error ? `<p class="tag impostor">${esc(m.error)}</p>` : ""}`;
}

/** Click delegation for every `[data-act]` button. */
export function bindActions(
  root: HTMLElement,
  handle: (act: string, dataset: DOMStringMap) => void,
): void {
  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!el || el.hasAttribute("disabled")) return;
    handle(el.dataset.act!, el.dataset);
  });
}
