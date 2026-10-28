import { encodeHashToBase64, decodeHashFromBase64 } from "@holochain/client";
import { Hc, type Signal } from "./holochain.js";
import { TouchJoystick } from "./mobile/joystick.js";
import { currentGame as findCurrentGame, lobbySeed } from "./game/rooms.js";
import { RoomRegistry, normalizeRoomCode, ROOM_UNAVAILABLE } from "./game/registry.js";
import { Movement } from "./peerkit/movement.js";
import { isVoiceSignal, Voice } from "./peerkit/voice.js";
import { Sounds } from "./game/sound.js";
import { colorHex } from "./game/colors.js";
import { pickRelayAddress } from "./game/relays.js";
import { gameKey, recordGameXp } from "./game/xp.js";
import { tryLoadHeads } from "./game/heads.js";
import { startMiniGame, type MiniGame } from "./game/minigames.js";
import { DEFAULT_PLAYERS, DEFAULT_SETTINGS, killRadius, maxImpostors, type GameSettings } from "./game/settings.js";
import { CAMS_H, CAMS_W, draw, drawCameras, VIEW_H, VIEW_W, type Dot } from "./game/canvas.js";
import { CHAT_MAX_LEN, ChatLog, chatLogHtml, chatView, isChatMsg } from "./game/chat.js";
import {
  audioBarHtml,
  bindActions,
  entryActionsHtml,
  entryBannerHtml,
  errorText,
  hasOpenSeat,
  hudEnabled,
  hudHtml,
  inPlay,
  meetingClock,
  myRole,
  screenHtml,
  SHORTCUTS,
  talkingHtml,
  vitalsHtml,
  type LobbyProbe,
  type Model,
  type PlayerV,
  type StateV,
} from "./game/ui.js";
import {
  airlockStep,
  airlockWalls,
  COMMS_PANEL,
  CRISES,
  dist,
  DOORS,
  EMERGENCY,
  HEARING_RADIUS,
  LIGHTS_PANEL,
  lineOfSight,
  moveWithin,
  SECURITY_CONSOLE,
  SPAWN,
  spawnFor,
  TASKS,
  TUNING,
  type Airlock,
  TASK_HOLD_MS,
  TASK_TARGET,
  USE_RADIUS,
  VENTS,
  VITALS,
  WALK_SPEED,
  WALL_MUFFLE,
  wallsWith,
} from "./game/world.js";

const app = document.getElementById("app")!;
app.innerHTML = `
  <div id="audio" class="row" hidden>
    <div id="audio-bar" class="row"></div>
    <span id="talking" class="muted"></span>
  </div>
  <div id="screen"></div>
  <div id="chat" class="card" hidden>
    <div id="chat-title" class="muted" style="margin-bottom:6px">Meeting chat</div>
    <div id="chat-log"></div>
    <form id="chat-form" class="row">
      <input id="chat-input" maxlength="${CHAT_MAX_LEN}" autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  </div>
  <div id="play" hidden>
    <div id="minigame" class="card" hidden></div>
    <div id="stage">
      <canvas id="map" width="${VIEW_W}" height="${VIEW_H}"></canvas>
      <div id="mobile-controls">
        <div id="mobile-joystick" class="mobile-pad" aria-label="Move character with touch joystick">
          <div class="mobile-stick"></div>
        </div>
      </div>
    </div>
    <div id="hud"></div>
  </div>`;
const screenEl = document.getElementById("screen")!;
const playEl = document.getElementById("play")! as HTMLDivElement;
const hudEl = document.getElementById("hud")!;
const miniEl = document.getElementById("minigame")! as HTMLDivElement;
const canvas = document.getElementById("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const joystick = new TouchJoystick(document.getElementById("mobile-joystick")!);
// The chat card lives outside #screen so re-renders never wipe a half-typed line.
const chatEl = document.getElementById("chat")! as HTMLDivElement;
const chatLogEl = document.getElementById("chat-log")!;
const chatTitleEl = document.getElementById("chat-title")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const chatSend = chatForm.querySelector("button")!;
const chat = new ChatLog();
// The audio bar sits outside #screen for the same reason as the chat card.
const audioEl = document.getElementById("audio")! as HTMLDivElement;
const audioBarEl = document.getElementById("audio-bar")!;
const talkingEl = document.getElementById("talking")!;
const sounds = new Sounds();

const LS = "imposter-ui";
const saved = JSON.parse(localStorage.getItem(LS) ?? "{}");

function freshProbe(code: string, status: LobbyProbe["status"]): LobbyProbe {
  return { code, round: 1, status, since: Date.now(), state: null, relay: null, relayFilledFrom: null, error: null };
}

const model: Model = {
  entered: false,
  connecting: false,
  error: null,
  name: saved.name ?? "",
  code: saved.code ?? "LOBBY-DEMO",
  round: 1,
  next: { state: null, wanted: false, busy: false },
  relayAddr: "", // discovered automatically; old saved developer addresses are ignored
  menuMode: saved.menuMode === "host" ? "host" : "join",
  showSettings: false,
  createOpts: {
    players: saved.players ?? DEFAULT_PLAYERS,
    impostors: saved.impostors ?? 1,
    tasks: saved.tasks ?? Math.min(3, TASK_TARGET), // tasks each
  },
  probe: freshProbe(saved.code ?? "LOBBY-DEMO", "connecting"),
  peerkit: { enabled: false, startError: null, startedAt: 0, relayUp: false, livePlayers: [] },
  audio: { soundMuted: false, voiceUp: false, micOn: false, micError: null, deafened: false, talking: [] },
  hostOffline: false,
  myTasks: null,
  localDone: [],
  taskHold: null,
  vent: null,
  airlockLeft: null,
  state: null,
  myKeyB64: "",
  myRoleFromSignal: null,
  near: { taskId: null, killKeyB64: null, bodyKeyB64: null, atEmergency: false, atLights: false, atComms: false, atVitals: false, atSecurity: false, crisisPanel: null, ventId: null },
  cooldownLeft: 0,
  voteSalt: null,
  myVoteChoice: null,
  dismissedMeeting: null,
};

let hc: Hc | null = null;
let movement: Movement | null = null;
let voice: Voice | null = null;
let peerkitStarting = false;
let sharedRelay: string | null = null; // "seed addr" last shared into a game
let lastRelaySync = 0;
let meetingHash: Uint8Array | null = null;
let tallying: string | null = null; // meetingB64 the host has already asked to tally
let lastKillAt = 0;
let lastRoleReq = 0;
let lastTasksReq = 0;
const keys = new Set<string>();
const self = { x: SPAWN.x, y: SPAWN.y };
/** My airlock: it only ever shuts on me (see world.ts). */
let airlock: Airlock = { phase: "idle" };
/** When I last re-confirmed holding a reactor console. */
let lastReactorConfirm = 0;

// --- rendering --------------------------------------------------------

// Only touch the DOM when the markup changed. Rewriting a button on every
// frame replaces it between mousedown and mouseup, which swallows the click.
const lastHtml = new WeakMap<Element, string>();
function setHtml(el: Element, html: string) {
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  el.innerHTML = html;
}

function persist() {
  localStorage.setItem(
    LS,
    JSON.stringify({ name: model.name, code: model.code, menuMode: model.menuMode, ...model.createOpts }),
  );
}

function refreshPeerkit() {
  model.peerkit.relayUp = movement?.relayUp() ?? false;
  model.peerkit.livePlayers = movement?.liveKeys(2000) ?? [];
}

function render() {
  const now = Date.now();
  refreshPeerkit();
  const playing = inPlay(model);
  playEl.hidden = !playing;
  setHtml(screenEl, screenHtml(model, now));
  const timer = document.getElementById("meeting-timer");
  if (timer && model.state) timer.textContent = meetingClock(model.state, now).text;
  if (!model.entered) {
    const banner = document.getElementById("entry-banner");
    const actions = document.getElementById("entry-actions");
    if (banner) setHtml(banner, entryBannerHtml(model, now));
    if (actions) setHtml(actions, entryActionsHtml(model, now));
  }
  setHtml(hudEl, hudHtml(model, now));
  renderAudio();
  renderChat();
}

// --- meeting chat (PeerKit) --------------------------------------------

function renderChat() {
  chat.sync(model.state);
  const v = chatView(model);
  if (!v.visible && !chatEl.hidden) {
    chatInput.value = "";
    chatInput.blur();
  }
  chatEl.hidden = !v.visible;
  chatTitleEl.textContent = v.title;
  chatInput.disabled = chatSend.disabled = !v.canType;
  chatInput.placeholder = v.placeholder;
  const atBottom = chatLogEl.scrollHeight - chatLogEl.scrollTop - chatLogEl.clientHeight < 24;
  setHtml(chatLogEl, chatLogHtml(model, chat));
  if (atBottom) chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const meeting = chat.current();
  const text = chatInput.value.trim();
  if (!movement || !meeting || !text || !chatView(model).canType) return;
  const msg = chat.compose(model.myKeyB64, meeting, text);
  chat.add(msg);
  movement.sendJson(msg);
  chatInput.value = "";
  renderChat();
});

function onPacket(data: unknown) {
  if (isChatMsg(data)) {
    if (chat.add(data)) renderChat();
  } else if (isVoiceSignal(data)) {
    voice?.onSignal(data).catch((e) => console.warn("voice signal:", e));
  }
}

// Packets are best effort and peers connect late, so keep re-sending our own
// lines for the current discussion; receivers de-duplicate by id.
function resendChat() {
  if (!movement || !chatView(model).canType) return;
  for (const msg of chat.mine(model.myKeyB64)) movement.sendJson(msg);
}

// --- sound & voice ---------------------------------------------------------

function renderAudio() {
  model.audio = {
    ...model.audio,
    soundMuted: sounds.isMuted(),
    voiceUp: !!voice,
    micOn: voice?.micOn() ?? false,
    micError: voice?.micError ?? null,
    deafened: voice?.isDeafened() ?? false,
  };
  audioEl.hidden = !model.entered;
  setHtml(audioBarEl, audioBarHtml(model));
}

/** Sound effects for what changed on-chain since the last poll. */
function stateSounds(prev: StateV | null, s: StateV) {
  if (!prev) return; // first look at this game: nothing "just happened"
  const mt = s.active_meeting;
  const was = prev.active_meeting?.meetingB64 === mt?.meetingB64 ? prev.active_meeting : null;
  // A new meeting — but not the tie breaker that follows a tied vote.
  if (s.phase === "meeting" && mt && !was && !mt.candidates) {
    sounds.play(mt.trigger === "body_report" ? "body" : "emergency");
  }
  if (mt?.resolved && mt.resolved.kind !== "tie" && !was?.resolved) sounds.play("voted");
  if (s.lights_out && !prev.lights_out && s.phase === "playing") sounds.play("lights");
  if (s.comms_out && !prev.comms_out && s.phase === "playing") sounds.play("comms");
  if (s.doors_closed.length > prev.doors_closed.length) sounds.play("doors");
  if (s.crisis && !prev.crisis && s.phase === "playing") sounds.play("alarm");
  if (prev.phase !== "ended" && s.phase === "ended" && s.result) {
    const role = myRole(model) ?? s.role_reveals.find(([seat]) => seat === s.my_seat)?.[1] ?? null;
    sounds.play((role === 1) === (s.result.outcome === "impostors_win") ? "win" : "lose");
  }
}

/** The moment a game is seen ending, bank its XP — once, before its clone can
 *  ever be disabled (see game/xp.ts for why that timing matters: a finished
 *  game's clone stops being callable once the room moves on). */
function recordXpIfJustEnded(prev: StateV | null, s: StateV, round: number) {
  if (prev?.phase === "ended" || s.phase !== "ended" || s.my_xp == null) return;
  recordGameXp(gameKey(model.code, round), s.my_xp);
}

/** My role is known — from the host's signal, or pulled from the host. The
 *  first time in a game, play the role sting. */
function learnRole(role: number) {
  if (model.myRoleFromSignal == null) sounds.play(role === 1 ? "start-impostor" : "start-crew");
  model.myRoleFromSignal = role;
}

/** How loud another player is for me, 0..1. Honest-client rules, as for text
 *  chat: ghosts are only heard by ghosts. In the lobby, meetings and on the
 *  result screen everyone is in one room; out on the map a voice carries as
 *  far as I can see, fading out towards that edge. */
function hearing(s: StateV, me: PlayerV | undefined, p: PlayerV): number {
  if (s.phase === "lobby" || s.phase === "ended") return 1;
  if (p.dead) return me?.dead ? 1 : 0;
  if (!inPlay(model)) return 1;
  const pos = movement?.positions.get(p.keyB64);
  if (!pos) return 0; // no position from them: can't place them, so out of earshot
  const vision = me?.dead ? 0 : myRole(model) === 1 ? s.settings.impostor_vision : s.settings.crew_vision;
  const range = vision > 0 ? vision : HEARING_RADIUS;
  // full volume within 40% of the range, silent at its edge; muffled through walls
  if (pos.h) return 0; // hiding in a vent
  const muffle = lineOfSight(self.x, self.y, pos.x, pos.y, wallsWith(closedRooms(s))) ? 1 : WALL_MUFFLE;
  return muffle * Math.max(0, Math.min(1, (range - dist(self.x, self.y, pos.x, pos.y)) / (range * 0.6)));
}

function updateVoice() {
  const s = model.state;
  if (!voice || !s) return;
  const me = s.players.find((p) => p.keyB64 === model.myKeyB64);
  const others = s.players.filter((p) => p.keyB64 !== model.myKeyB64);
  voice.setPeers(others.map((p) => p.keyB64));
  const talking: string[] = [];
  for (const p of others) {
    const gain = hearing(s, me, p);
    voice.setGain(p.keyB64, gain);
    if (gain > 0 && voice.isTalking(p.keyB64)) talking.push(p.keyB64);
  }
  model.audio.talking = voice.isDeafened() ? [] : talking;
  setHtml(talkingEl, talkingHtml(model));
}

// --- relay address, shared through the game ------------------------------

/** (Re)start PeerKit on a relay address. Best effort: the game runs without it. */
async function startPeerkit(addr: string) {
  if (peerkitStarting) return;
  peerkitStarting = true;
  try {
    await movement?.shutdown();
    movement = null;
    model.relayAddr = addr;
    persist();
    model.peerkit = { enabled: true, startError: null, startedAt: Date.now(), relayUp: false, livePlayers: [] };
    movement = await Movement.start(model.code, model.myKeyB64, [addr], { x: self.x, y: self.y });
    movement.onPacket = onPacket;
    // Voice outlives a PeerKit restart: it only needs a way to send packets.
    voice ??= new Voice(model.myKeyB64, (msg) => movement?.sendJson(msg));
  } catch (e: any) {
    model.peerkit.startError = String(e?.message ?? e);
    console.warn("PeerKit off:", e);
  } finally {
    peerkitStarting = false;
  }
}

/** In a game: once our node reaches its relay, share that address with the
 *  game; while we have no relay that works, switch to the one the game shares. */
async function syncRelay(round: number) {
  const now = Date.now();
  if (!hc || peerkitStarting || now - lastRelaySync < 3000) return;
  lastRelaySync = now;
  const seed = gameSeed(round);
  if (movement?.relayUp()) {
    if (sharedRelay !== `${seed} ${model.relayAddr}`) {
      await hc.callOn(seed, "share_relay", model.relayAddr);
      sharedRelay = `${seed} ${model.relayAddr}`;
    }
    return;
  }
  // A relay running on this machine is the freshest lead — unless it's the one
  // that just failed (its file can outlive a relay that was killed); then the game's.
  const shared = await hc.callOn<string | null>(seed, "get_relay", null).catch(() => null);
  const addr = localRelay && localRelay !== model.relayAddr ? localRelay : shared ?? localRelay;
  // No known address yet: keep discovering. Never expose setup steps to players.
  if (round !== model.round || !addr) return;
  // Reconnect after a grace period. A temporarily unavailable relay must not
  // strand players until they reopen the game.
  if (now - model.peerkit.startedAt < 10_000 && addr === model.relayAddr) return;
  await startPeerkit(addr);
}

/** Select relay addresses automatically. Network configuration is never shown in
 * the player menu, but the existing local/room sharing protocol stays intact. */
function adoptRelayAddress(addr: string | null) {
  if (!model.entered && addr) model.relayAddr = addr;
}

/** The relay `npm run relay` is running on this machine, from the relay.json it
 *  writes for the dev server; null when there's none (or no dev server, as in
 *  a packaged build). */
let localRelay: string | null = null;

async function discoverLocalRelay() {
  try {
    const res = await fetch("/relay.json", { cache: "no-store" });
    localRelay = res.ok ? pickRelayAddress(await res.json(), location.hostname, model.entered ? model.code : model.probe.code) : null;
  } catch {
    localRelay = null;
  }
  if (!model.entered) {
    adoptRelayAddress(localRelay ?? model.probe.relay);
    render();
  }
}

// Look now, and again every few seconds until PeerKit is up: the relay may be
// started after the windows are.
void discoverLocalRelay();
setInterval(() => {
  if (!model.peerkit.relayUp) void discoverLocalRelay();
}, 5000);

// --- state polling ---------------------------------------------------

function otherSpot(seat: number): { x: number; y: number } {
  // fallback layout when PeerKit is off: ring the other players by seat, round the emergency button
  const a = (seat / 8) * Math.PI * 2;
  return { x: EMERGENCY.x + Math.cos(a) * 200, y: EMERGENCY.y + Math.sin(a) * 120 };
}

function toStateV(raw: any): StateV {
  const b64 = (u: unknown) => (u ? encodeHashToBase64(u as Uint8Array) : "");
  const players = (raw.players ?? []).map((p: any) => ({
    key: p.key,
    keyB64: b64(p.key),
    name: p.name,
    seat: p.seat ?? null,
    dead: !!p.dead,
    is_host: !!p.is_host,
    role: p.role ?? null,
    color: p.color ?? 0,
  }));
  let active_meeting = null;
  if (raw.active_meeting) {
    active_meeting = {
      meetingB64: b64(raw.active_meeting.meeting),
      opened_at_ms: raw.active_meeting.opened_at_ms ?? Date.now(),
      trigger: raw.active_meeting.trigger,
      candidates: raw.active_meeting.candidates ?? null,
      committed: (raw.active_meeting.committed ?? []).map(b64),
      revealed: (raw.active_meeting.revealed ?? []).map(b64),
      resolved: raw.active_meeting.resolved ?? null,
      votes: raw.active_meeting.votes ?? [],
    };
  }
  return {
    phase: raw.phase,
    is_host: !!raw.is_host,
    code: raw.code ?? null,
    player_count: raw.player_count ?? 0,
    impostor_count: raw.impostor_count ?? 0,
    task_target: raw.task_target ?? TASK_TARGET,
    players,
    roles_dealt: !!raw.roles_dealt,
    my_seat: raw.my_seat ?? null,
    my_role: raw.my_role ?? null,
    tasks_done: raw.tasks_done ?? 0,
    tasks_done_at_meeting: raw.tasks_done_at_meeting ?? raw.tasks_done ?? 0,
    my_tasks_done: raw.my_tasks_done ?? [],
    active_meeting,
    role_reveals: raw.role_reveals ?? [],
    result: raw.result ? { ...raw.result, meltdown: raw.result.meltdown ?? null } : null,
    my_xp: raw.my_xp ?? null,
    // a hApp without settings: no fog, no meeting timers; settings it doesn't know yet: the defaults
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw.settings ?? { crew_vision: 0, impostor_vision: 0, kill_cooldown_s: 8, discussion_s: 0, voting_s: 0, task_bar: 0 }),
    },
    bodies: (raw.bodies ?? []).map((b: any) => ({ keyB64: b64(b.key), at: b.at ?? null })),
    emergencies_left: raw.emergencies_left ?? 1,
    emergency_ready_at: raw.emergency_ready_at ?? null,
    kill_ready_at: raw.kill_ready_at ?? null,
    lights_out: !!raw.lights_out,
    lights_ready_at: raw.lights_ready_at ?? null,
    comms_out: !!raw.comms_out,
    comms_ready_at: raw.comms_ready_at ?? null,
    doors_closed: raw.doors_closed ?? [],
    doors_ready_at: raw.doors_ready_at ?? null,
    crisis: raw.crisis ?? null,
    crisis_ready_at: raw.crisis_ready_at ?? null,
    seat_lost: !!raw.seat_lost,
  };
}

async function poll() {
  if (!hc) return;
  const round = model.round;
  try {
    const raw = await hc.callOn<any>(gameSeed(round), "get_game_state", null);
    if (round !== model.round) return; // moved on to the next game meanwhile
    meetingHash = (raw.active_meeting?.meeting as Uint8Array | undefined) ?? null;
    const prev = model.state;
    model.state = toStateV(raw);
    // the game just started: everyone to their own spawn on the Bridge
    if (model.state.phase === "playing" && (!prev || prev.phase === "lobby")) {
      const at = spawnFor(model.state.my_seat);
      self.x = at.x;
      self.y = at.y;
      movement?.setPos(self.x, self.y);
    }
    stateSounds(prev, model.state);
    recordXpIfJustEnded(prev, model.state, round);
    if (model.state.bodies.some((b) => b.keyB64 === model.myKeyB64 && !b.at)) markBody();
    model.error = null;
    void syncRelay(round).catch((e) => console.warn("relay sync:", e));
    // host drives the finish
    if (model.state.is_host && model.state.phase !== "lobby" && !model.state.result) {
      hc.call("try_finish", null).catch(() => {});
    }
    // Voting. My vote reveals itself once every living player has voted, or just
    // before time runs out. The host tallies once everyone has revealed, or
    // shortly after time is up (with no votes in, nobody is voted off).
    const mt = model.state.active_meeting;
    if (model.state.phase === "meeting" && mt && !mt.resolved) {
      const now = Date.now();
      const living = model.state.players.filter((p) => !p.dead);
      const { votingEndsAt } = meetingClock(model.state, now);
      const closing = votingEndsAt !== null && now >= votingEndsAt - REVEAL_LEAD_MS;
      const allVoted = living.every((p) => mt.committed.includes(p.keyB64));
      const mineHidden = mt.committed.includes(model.myKeyB64) && !mt.revealed.includes(model.myKeyB64);
      if (mineHidden && (allVoted || closing)) autoReveal(mt.meetingB64);
      const timeUp = votingEndsAt !== null && now >= votingEndsAt + TALLY_GRACE_MS;
      const allRevealed = living.every((p) => mt.revealed.includes(p.keyB64));
      if (model.state.is_host && tallying !== mt.meetingB64 && (allRevealed || timeUp)) {
        tallying = mt.meetingB64;
        hc.call("resolve_meeting", meetingHash).catch(() => (tallying = null));
      }
    }
    // clear stale vote material when a new meeting opens
    if (!model.state.active_meeting) {
      model.voteSalt = null;
      model.myVoteChoice = null;
    }
    // The host's `RoleDealt` signal is fire-and-forget; if it was lost, pull
    // our own leaf from the host until we know it.
    if (model.state.phase === "playing" && myRole(model) == null) {
      const now = Date.now();
      if (now - lastRoleReq > 2500) {
        lastRoleReq = now;
        hc.call<number | null>("request_role", null)
          .then((r) => {
            if (r != null && model.myRoleFromSignal == null) {
              learnRole(r);
              render();
            }
          })
          .catch(() => {});
      }
    }
    // My secret task list comes from the host once roles are dealt and the
    // consoles are published; ask until it arrives.
    if (model.state.roles_dealt && !model.myTasks?.length && Date.now() - lastTasksReq > 2500) {
      lastTasksReq = Date.now();
      hc.call<number[]>("my_tasks", null)
        .then((list) => {
          if (round === model.round && list.length) {
            model.myTasks = list;
            render();
          }
        })
        .catch(() => {});
    }
    if (model.state.phase === "ended" || model.hostOffline) await watchNextGame(round);
  } catch (e: any) {
    model.error = errorText(e);
  }
  render();
}

// --- one game after another in the same room --------------------------

type GameConfig = {
  player_count: number;
  impostor_count: number;
  task_target: number;
  settings?: GameSettings; // unset: the coordinator's defaults
};

/** A lobby created from the entry screen: the counts picked there. */
function createConfig(): GameConfig {
  const { players, impostors, tasks } = model.createOpts;
  const most = maxImpostors(players);
  if (impostors > most) throw new Error(`${players} players can have at most ${most} impostor${most === 1 ? "" : "s"}`);
  // `tasks` is tasks each; the lobby's target is what the whole crew must finish
  return {
    player_count: players,
    impostor_count: impostors,
    task_target: Math.min(tasks, TASK_TARGET) * (players - impostors),
  };
}

// The initial private game uses a pointer. Play Again still uses the legacy
// round walk until Phase 4 supplies the complete handoff.
const selectedSeeds = new Map<string, string>();
let registry: RoomRegistry | null = null;
function roomRegistry(): RoomRegistry {
  return registry ??= new RoomRegistry(hc!, localStorage, model.myKeyB64);
}
function gameSeed(round: number, code = model.code): string {
  return selectedSeeds.get(`${code}:${round}`) ?? lobbySeed(code.startsWith("LEGACY:") ? legacyCode(code) : code, round);
}
function roomInput(value: string): string {
  const code = value.trim();
  return code.toUpperCase().startsWith("LEGACY:")
    ? `LEGACY:${normalizeRoomCode(code.slice(7))}` : normalizeRoomCode(code);
}
function legacyCode(code: string) { return code.slice(7); }

/** Resolve in the base cell first. Only explicit LEGACY: input uses the walk. */
async function currentGame(code: string, from: number): Promise<{ round: number; raw: any }> {
  if (code.startsWith("LEGACY:")) {
    const { round, game } = await findCurrentGame(legacyCode(code), from, async (seed) =>
      hc!.isClosed(seed) ? null : hc!.callOn<any>(seed, "get_game_state", null));
    selectedSeeds.set(`${code}:${round}`, lobbySeed(legacyCode(code), round));
    return { round, raw: game };
  }
  const { current, raw } = await roomRegistry().lookup(code);
  const round = current.pointer.round;
  selectedSeeds.set(`${code}:${round}`, current.pointer.game_seed);
  return { round, raw };
}

/** Disable the clones of this room's earlier games, so a long session doesn't
 *  keep every old game syncing and holding memory. By the time a later game is
 *  entered they have all ended or been abandoned. */
function closeEarlierGames(round: number) {
  for (let r = 1; r < round; r++) {
    hc!.closeLobby(gameSeed(r)).catch((e) => console.warn("closing an old game:", e));
  }
}

/** Take a seat in one game of the room; a host opens its lobby if nobody has.
 *  A seat already held (e.g. after a reload) is kept, never taken twice. */
async function takeSeat(round: number, asHost: boolean, config?: GameConfig) {
  const seed = gameSeed(round);
  const current = toStateV(await hc!.callOn<any>(seed, "get_game_state", null));
  if (current.players.some((p) => p.keyB64 === model.myKeyB64)) return;
  if (asHost && current.code == null) {
    const c = config ?? createConfig();
    await hc!.callOn(seed, "create_lobby", {
      code: seed,
      player_count: c.player_count,
      impostor_count: c.impostor_count,
      task_target: c.task_target,
      display_name: model.name,
    });
    if (c.settings) await hc!.callOn(seed, "set_settings", c.settings);
  } else {
    await hc!.callOn(seed, "join_lobby", { display_name: model.name });
  }
}

/** Point the UI at one game of the room and drop everything left from the last. */
async function enterGame(round: number) {
  await hc!.useLobby(gameSeed(round));
  model.round = round;
  closeEarlierGames(round);
  model.state = null;
  model.next = { state: null, wanted: false, busy: false };
  model.hostOffline = false;
  hostMisses = 0;
  model.myRoleFromSignal = null;
  model.near = { taskId: null, killKeyB64: null, bodyKeyB64: null, atEmergency: false, atLights: false, atComms: false, atVitals: false, atSecurity: false, crisisPanel: null, ventId: null };
  model.myTasks = null;
  model.localDone = [];
  model.taskHold = null;
  lastTasksReq = 0;
  model.vent = null;
  airlock = { phase: "idle" };
  model.airlockLeft = null;
  movement?.setHidden(false);
  deathSpot = null;
  model.cooldownLeft = 0;
  model.voteSalt = null;
  model.myVoteChoice = null;
  model.dismissedMeeting = null;
  meetingHash = null;
  tallying = null;
  revealing = null;
  lastKillAt = 0;
  lastRoleReq = 0;
  self.x = SPAWN.x;
  self.y = SPAWN.y;
  movement?.setPos(self.x, self.y);
}

/** Once a game has ended, or its host has gone: follow the room's next game,
 *  so a player who pressed Play again joins the moment it's opened. */
async function watchNextGame(round: number) {
  const raw = await hc!.callOn<any>(gameSeed(round + 1), "get_game_state", null);
  if (round !== model.round) return;
  model.next.state = toStateV(raw);
  if (model.next.state.players.some((p) => p.keyB64 === model.myKeyB64)) await enterGame(round + 1);
  else if (model.next.wanted && hasOpenSeat(model.next.state)) await playAgain();
}

/** Result screen, or a game whose host has gone → the room's next game. Only
 *  this game's host opens its lobby (with this game's settings), so a room never
 *  gets two — unless that host has gone, when anyone may. Everyone else joins. */
async function playAgain() {
  const s = model.state;
  if (!hc || !s || model.next.busy || (s.phase !== "ended" && !model.hostOffline)) return;
  model.next.wanted = true;
  const hosting = s.is_host || model.hostOffline;
  if (!hosting && !hasOpenSeat(model.next.state)) return render(); // watchNextGame joins once open
  const round = model.round + 1;
  model.next.busy = true;
  render();
  try {
    await takeSeat(round, hosting, s);
    await enterGame(round);
  } finally {
    model.next.busy = false;
  }
}

// --- host presence ---------------------------------------------------------

const HOST_CHECK_TIMEOUT_MS = 5000;
let hostMisses = 0;
let checkingHost = false;

/** The host deals, tallies, publishes the result and alone knows the roles:
 *  without it the game can't go on. Ask it every few seconds; two misses in a
 *  row count as gone. A ping to a vanished host can hang, so it's given up on. */
async function watchHost() {
  const s = model.state;
  if (!hc || checkingHost || !s || s.is_host || s.code == null) return;
  checkingHost = true;
  const round = model.round;
  try {
    const online = await Promise.race([
      hc.call<boolean>("host_online", null),
      new Promise<boolean>((done) => setTimeout(() => done(false), HOST_CHECK_TIMEOUT_MS)),
    ]).catch(() => false);
    if (round !== model.round) return;
    hostMisses = online ? 0 : hostMisses + 1;
    const offline = hostMisses >= 2;
    if (offline !== model.hostOffline) {
      model.hostOffline = offline;
      render();
    }
  } finally {
    checkingHost = false;
  }
}

// --- entry screen: watch the lobby code until we join ------------------

let probing = false;
async function probeLobby() {
  if (model.entered || probing) return;
  probing = true;
  const code = model.probe.code;
  try {
    if (!hc) {
      hc = await Hc.connect(onSignal);
      model.myKeyB64 = encodeHashToBase64(hc.myPubKey);
      void tryLoadHeads(model.myKeyB64); // best-effort; draws blockies until (if ever) this resolves
    }
    if (model.probe.code === code && model.probe.status !== "looking") {
      model.probe.status = "looking";
      model.probe.since = Date.now();
    }
    const { round, raw } = await currentGame(code, model.probe.round);
    // Optional: a conductor still running an older hApp has no `get_relay`.
    const relay = await hc
      .callOn<string | null>(gameSeed(round, code), "get_relay", null)
      .catch(() => null);
    if (model.probe.code !== code || model.entered) return;
    model.probe.round = round;
    model.probe.state = toStateV(raw);
    model.probe.relay = relay;
    adoptRelayAddress(localRelay ?? relay);
    model.probe.error = null;
  } catch (e: any) {
    if (model.probe.code === code) {
      model.probe.state = null;
      model.probe.relay = null;
      const message = String(e?.message ?? e);
      model.probe.error = message.includes("room") || message.includes("Room") ? message : ROOM_UNAVAILABLE;
      if (!hc) model.probe.status = "no-conductor";
    }
  } finally {
    probing = false;
    if (!model.entered) render();
  }
}

const probeTimer = setInterval(() => {
  if (model.entered) clearInterval(probeTimer);
  else void probeLobby();
}, 1000);

// Re-check as soon as the lobby code is edited (on blur / Enter, so a
// half-typed code doesn't spin up a clone cell per keystroke).
app.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (model.entered || input.id !== "f-code") return;
  const enteredCode = input.value.trim() || "LOBBY-DEMO";
  let code: string;
  try { code = roomInput(enteredCode); }
  catch { code = enteredCode; } // the probe shows the invalid-code message
  if (code === model.probe.code) return;
  model.probe = freshProbe(code, hc ? "looking" : "connecting");
  model.relayAddr = localRelay ?? "";
  void discoverLocalRelay();
  render();
  void probeLobby();
});

// Host, in the lobby: a settings picker changed. Every picker is read from the
// page, so two quick changes don't overwrite each other before the next poll.
const SETTINGS_FIELDS: Record<string, keyof GameSettings> = {
  "f-crew-vision": "crew_vision",
  "f-impostor-vision": "impostor_vision",
  "f-kill-cooldown": "kill_cooldown_s",
  "f-discussion": "discussion_s",
  "f-voting": "voting_s",
  "f-task-bar": "task_bar",
  "f-emergencies": "emergency_meetings",
  "f-speed": "player_speed",
  "f-kill-distance": "kill_distance",
  "f-confirm-ejects": "confirm_ejects",
  "f-anonymous-votes": "anonymous_votes",
};
app.addEventListener("change", (e) => {
  const id = (e.target as HTMLElement).id;
  const s = model.state;
  if (!hc || !s?.is_host || s.phase !== "lobby" || !(id in SETTINGS_FIELDS)) return;
  const settings = { ...s.settings };
  for (const [fieldId, key] of Object.entries(SETTINGS_FIELDS)) {
    const value = Number(field(fieldId));
    // on/off pickers hold 1 / 0; the zome wants a bool
    (settings as Record<string, number | boolean>)[key] = typeof DEFAULT_SETTINGS[key] === "boolean" ? value === 1 : value;
  }
  hc.call("set_settings", settings)
    .then(poll)
    .catch((err: any) => {
      model.error = errorText(err);
      render();
    });
});

// --- game loop -----------------------------------------------------

function positionsFor(s: StateV): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const p of s.players) {
    if (p.keyB64 === model.myKeyB64) {
      out.set(p.keyB64, { x: self.x, y: self.y });
      continue;
    }
    const pk = movement?.positions.get(p.keyB64);
    out.set(p.keyB64, pk ? { x: pk.x, y: pk.y } : otherSpot(p.seat ?? 0));
  }
  return out;
}

function tick() {
  requestAnimationFrame(tick);
  const s = model.state;
  if (!s || !inPlay(model)) {
    joystick.reset();
    if (miniGame || vitalsOpen || camsOpen) closeMiniGame(); // a meeting, the end, a new game: the task card or vitals go
    if (model.vent !== null) leaveVent(false); // …and impostors come out of vents
    return;
  }

  const iAmDead = s.players.find((p) => p.keyB64 === model.myKeyB64)?.dead ?? false;
  // shut doors are walls until they open again — and so is my airlock, mid-cycle
  const now = Date.now();
  const closed = closedRooms(s);
  airlock = iAmDead ? { phase: "idle" } : airlockStep(airlock, self.x, self.y, now);
  const airlockShut = airlockWalls(airlock, now);
  model.airlockLeft = airlock.phase === "cycling" ? Math.max(0, airlock.until - now) : null;
  const walls = airlockShut.length ? [...wallsWith(closed), ...airlockShut] : wallsWith(closed);
  const speed = (WALK_SPEED * s.settings.player_speed) / 100;
  let dx = 0;
  let dy = 0;
  if (keys.has("arrowleft") || keys.has("a")) dx -= 1;
  if (keys.has("arrowright") || keys.has("d")) dx += 1;
  if (keys.has("arrowup") || keys.has("w")) dy -= 1;
  if (keys.has("arrowdown") || keys.has("s")) dy += 1;
  // Desktop keyboard and mobile touch share collision/vision/gameplay rules.
  dx += joystick.direction.x;
  dy += joystick.direction.y;
  if (miniGame || vitalsOpen || camsOpen) dx = dy = 0; // at a console, vitals or security: no walking off mid-task
  // killed mid-task: a crewmate's ghost carries on (the task still counts)
  if (miniGame && iAmDead && myRole(model) === 1) closeMiniGame();
  if (model.vent !== null) {
    if (iAmDead) leaveVent(false);
    else dx = dy = 0; // in a vent: hop between vents instead
  }
  if (dx || dy) {
    const n = Math.hypot(dx, dy) || 1;
    const moveSpeed = speed * Math.min(1, n); // preserve analog travel speed
    // walls stop the living; ghosts drift through
    // in steps no longer than normal speed, so a fast walker can't skip through a wall
    const steps = Math.max(1, Math.ceil(moveSpeed / WALK_SPEED));
    for (let i = 0; i < steps; i++) {
      const c = moveWithin(self.x, self.y, ((dx / n) * moveSpeed) / steps, ((dy / n) * moveSpeed) / steps, iAmDead, walls);
      self.x = c.x;
      self.y = c.y;
    }
    movement?.setPos(self.x, self.y);
  }

  const pos = positionsFor(s);
  const role = myRole(model);

  // nearest of my own tasks not done yet — an impostor's too: they're cover
  const myDone = [...s.my_tasks_done, ...model.localDone];
  let taskId: number | null = null;
  let best = USE_RADIUS;
  for (const t of TASKS) {
    if (!model.myTasks?.includes(t.id) || myDone.includes(t.id)) continue;
    if (!lineOfSight(self.x, self.y, t.x, t.y, walls)) continue; // no reaching through walls
    const d = dist(self.x, self.y, t.x, t.y);
    if (d < best) {
      best = d;
      taskId = t.id;
    }
  }
  // nearest killable: living players only
  let killKeyB64: string | null = null;
  let bk = killRadius(s.settings.kill_distance);
  for (const p of s.players) {
    if (p.keyB64 === model.myKeyB64 || p.dead || role !== 1) continue;
    const pp = pos.get(p.keyB64)!;
    if (movement?.positions.get(p.keyB64)?.h) continue; // hiding in a vent
    if (!lineOfSight(self.x, self.y, pp.x, pp.y, walls)) continue;
    const d = dist(self.x, self.y, pp.x, pp.y);
    if (d < bk) {
      bk = d;
      killKeyB64 = p.keyB64;
    }
  }
  // nearest body: where its victim fell, not where their ghost has gone since
  let bodyKeyB64: string | null = null;
  let bb = USE_RADIUS;
  for (const b of s.bodies) {
    if (!b.at) continue;
    if (!lineOfSight(self.x, self.y, b.at.x, b.at.y, walls)) continue;
    const d = dist(self.x, self.y, b.at.x, b.at.y);
    if (d < bb) {
      bb = d;
      bodyKeyB64 = b.keyB64;
    }
  }
  const atEmergency =
    dist(self.x, self.y, EMERGENCY.x, EMERGENCY.y) < USE_RADIUS && lineOfSight(self.x, self.y, EMERGENCY.x, EMERGENCY.y, walls);
  const atLights =
    dist(self.x, self.y, LIGHTS_PANEL.x, LIGHTS_PANEL.y) < USE_RADIUS &&
    lineOfSight(self.x, self.y, LIGHTS_PANEL.x, LIGHTS_PANEL.y, walls);
  const atComms =
    dist(self.x, self.y, COMMS_PANEL.x, COMMS_PANEL.y) < USE_RADIUS &&
    lineOfSight(self.x, self.y, COMMS_PANEL.x, COMMS_PANEL.y, walls);
  // a vent a living impostor can slip into
  const ventId =
    role === 1 && !iAmDead && model.vent === null
      ? (VENTS.find((v) => dist(self.x, self.y, v.x, v.y) < USE_RADIUS && lineOfSight(self.x, self.y, v.x, v.y, walls))
          ?.id ?? null)
      : null;
  const at = (p: { x: number; y: number }) =>
    dist(self.x, self.y, p.x, p.y) < USE_RADIUS && lineOfSight(self.x, self.y, p.x, p.y, walls);
  const atVitals = at(VITALS);
  const atSecurity = at(SECURITY_CONSOLE);
  // a console of the crisis under way that still needs someone (the reactor's always does)
  const crisis = s.crisis;
  const panelIdx = crisis ? CRISES[crisis.kind].panels.findIndex(at) : -1;
  const crisisPanel =
    crisis && panelIdx >= 0 && (crisis.kind === "reactor" || !crisis.panels[panelIdx]) ? panelIdx : null;
  model.near = { taskId, killKeyB64, bodyKeyB64, atEmergency, atLights, atComms, atVitals, atSecurity, crisisPanel, ventId };

  // Fixing lights or comms: hold E, or the Use button, at the panel for
  // TASK_HOLD_MS. Moving, letting go or stepping away cancels it. (A console
  // opens a mini-game instead.)
  // A crisis console is held the same way — the reactor's for as long as it
  // takes, re-confirming every so often, since two players must hold at once.
  const target =
    taskId !== null
      ? null
      : crisisPanel !== null
        ? CRISIS_FIX - crisisPanel
        : s.lights_out && atLights
          ? LIGHTS_FIX
          : s.comms_out && atComms
            ? COMMS_FIX
            : null;
  const holding = !iAmDead && target !== null && !dx && !dy && (keys.has("e") || useHeld);
  const reactor = crisis?.kind === "reactor" && crisisPanel !== null;
  if (!holding || target === null) {
    model.taskHold = null;
  } else if (model.taskHold?.taskId !== target) {
    model.taskHold = { taskId: target, startedAt: now };
    lastReactorConfirm = 0;
  } else if (reactor) {
    if (now - lastReactorConfirm >= TUNING.reactorConfirmEveryMs) {
      lastReactorConfirm = now;
      fixCrisis(crisisPanel!, false);
    }
  } else if (now - model.taskHold.startedAt >= TASK_HOLD_MS) {
    model.taskHold = null;
    if (target === LIGHTS_FIX) fixLights();
    else if (target === COMMS_FIX) fixComms();
    else if (crisisPanel !== null) fixCrisis(crisisPanel, true);
    else finishTask(target, role === 1);
  }
  // Kill cooldown: the zome's (since the start, the latest meeting and my last
  // kill), or my own last kill if that hasn't synced back yet.
  const killReadyAt = Math.max(s.kill_ready_at ?? 0, lastKillAt + s.settings.kill_cooldown_s * 1000);
  model.cooldownLeft = Math.max(0, killReadyAt - Date.now());

  // draw — ghosts see the whole map, the living only as far as the host set
  // Lights out: the crew's vision drops right down; impostors' far less.
  const dim = (vision: number, cap: number) => (s.lights_out ? Math.min(vision || Infinity, cap) : vision);
  const crewVision = dim(s.settings.crew_vision, TUNING.lightsOutCrewVision);
  const impostorVision = dim(s.settings.impostor_vision, TUNING.lightsOutImpostorVision);
  const radius = iAmDead ? 0 : role === 1 ? impostorVision : crewVision;
  const dots: Dot[] = s.players
    // the living don't see ghosts, and nobody sees into a vent
    .filter((p) => (!p.dead || iAmDead) && (p.keyB64 === model.myKeyB64 || !movement?.positions.get(p.keyB64)?.h))
    .map((p) => {
      const pp = pos.get(p.keyB64)!;
      return {
        keyB64: p.keyB64,
        name: p.name,
        x: pp.x,
        y: pp.y,
        dead: p.dead,
        isMe: p.keyB64 === model.myKeyB64,
        isImpostorView: p.keyB64 === model.myKeyB64 && role === 1,
        color: colorHex(p.color),
        hidden: p.keyB64 === model.myKeyB64 && model.vent !== null,
      };
    });
  const bodies = s.bodies.flatMap((b) => {
    const p = s.players.find((pl) => pl.keyB64 === b.keyB64);
    return b.at ? [{ name: p?.name ?? "?", color: colorHex(p?.color ?? 0), x: b.at.x, y: b.at.y }] : [];
  });
  draw(ctx, {
    dots,
    bodies,
    atEmergency: model.near.atEmergency && !iAmDead,
    lightsOut: s.lights_out,
    atLights: atLights && !iAmDead,
    commsOut: s.comms_out,
    atComms: atComms && !iAmDead,
    atVitals,
    atSecurity,
    crisis: crisis ? { kind: crisis.kind, panels: crisis.panels } : null,
    airlockDoors: airlockShut,
    killRadius: killRadius(s.settings.kill_distance),
    walls,
    closedDoors: DOORS.filter((d) => closed.includes(d.room)).map((d) => d.wall),
    nearVent: ventId,
    myTasks: model.myTasks,
    myDone,
    taskHold: model.taskHold
      ? {
          x: self.x,
          y: self.y,
          // the reactor has no finish line: the bar pulses while held
          progress: reactor ? 0.5 + 0.5 * Math.sin(now / 150) : Math.min(1, (now - model.taskHold.startedAt) / TASK_HOLD_MS),
        }
      : null,
    tasksDoneTotal: s.tasks_done,
    taskTarget: s.task_target,
    vision: radius > 0 ? radius : null,
  });
  miniGame?.frame?.(miniEl, Date.now());
  if (vitalsOpen) renderVitals();
  if (camsOpen) renderCams(s, pos, walls);
  refreshPeerkit();
  setHtml(hudEl, hudHtml(model));
}
requestAnimationFrame(tick);

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  keys.add(key);
  // Action shortcuts. Skip held-key repeats, modifier combos (Ctrl+R must still
  // reload the window) and typing in a form field.
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (key === "escape" && (miniGame || vitalsOpen || camsOpen)) return void closeMiniGame();
  if (e.target instanceof HTMLInputElement) return;
  if (key === "v" && model.entered) return void act("toggle-mic", {});
  const action = SHORTCUTS[key];
  // E opens a console's mini-game; holding it at the lights panel is tick()'s.
  if (!action || !hudEnabled(model)[action]) return;
  void act(action, {});
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

// The Use button counts while it's held down. Let go anywhere to stop: the HUD
// may redraw the button mid-hold.
let useHeld = false;
hudEl.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest('[data-act="use-task"]:not([disabled])')) useHeld = true;
});
window.addEventListener("pointerup", () => (useHeld = false));
window.addEventListener("pointercancel", () => (useHeld = false));

/** A held Use ran its course. It shows as done straight away. A crewmate's task
 *  is recorded; an impostor's is only faked, in this window, and never reaches
 *  the DHT — so nobody else can tell the difference. The medbay scan
 *  (`TaskDef.scan`) also publishes the caller's own role when it's real: an
 *  impostor gains nothing from that, so a real one only ever comes from crew. */
function finishTask(taskId: number, fake: boolean) {
  model.localDone = [...model.localDone, taskId];
  const scan = TASKS.find((t) => t.id === taskId)?.scan;
  sounds.play(scan && !fake ? "scan" : "task");
  if (fake || !hc) return;
  hc.call(scan ? "scan_role" : "complete_task", taskId).catch((e: any) => {
    model.localDone = model.localDone.filter((id) => id !== taskId);
    model.error = errorText(e);
  });
}

// --- task mini-games -------------------------------------------------------

let miniGame: MiniGame | null = null;

function openMiniGame(taskId: number) {
  const task = TASKS.find((t) => t.id === taskId);
  miniGame = startMiniGame(taskId, task?.name ?? `Task ${taskId}`, Date.now());
  model.taskHold = null;
  renderMiniGame();
}

function closeMiniGame() {
  miniGame = null;
  vitalsOpen = false;
  camsOpen = false;
  miniEl.hidden = true;
  miniEl.innerHTML = "";
  lastHtml.delete(miniEl); // vitals draw through setHtml
}

function renderMiniGame() {
  if (!miniGame) return closeMiniGame();
  miniEl.hidden = false;
  miniEl.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:8px">
      <strong>${miniGame.title}</strong><button data-act="mg-close">Close<span class="key">Esc</span></button>
    </div>${miniGame.html(Date.now())}`;
}

// --- vitals ---------------------------------------------------------------

/** The vitals panel shares the mini-game's card, and closes the same ways. */
let vitalsOpen = false;

function openVitals() {
  closeMiniGame();
  vitalsOpen = true;
  model.taskHold = null;
  renderVitals();
}

function renderVitals() {
  miniEl.hidden = false;
  setHtml(
    miniEl,
    `<div class="row" style="justify-content:space-between;margin-bottom:8px">
      <strong>Vitals</strong><button data-act="mg-close">Close<span class="key">Esc</span></button>
    </div>${vitalsHtml(model)}`,
  );
}

// --- security & network ------------------------------------------------------

/** The security console shares the mini-game's card too. Whoever watches can't
 *  move — useful information, at a price. */
let camsOpen = false;

function openCams() {
  closeMiniGame();
  camsOpen = true;
  model.taskHold = null;
  miniEl.hidden = false;
  miniEl.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:8px">
      <strong>Security &amp; Network</strong><button data-act="mg-close">Close<span class="key">Esc</span></button>
    </div>
    <canvas id="cams" width="${CAMS_W}" height="${CAMS_H}" style="width:${CAMS_W}px;max-width:100%"></canvas>
    <p id="cams-status" class="muted"></p>`;
}

function renderCams(s: StateV, pos: Map<string, { x: number; y: number }>, walls: ReturnType<typeof wallsWith>) {
  const el = document.getElementById("cams") as HTMLCanvasElement | null;
  if (!el) return;
  // the living, out of the Maintenance Network; cameras don't see ghosts
  const dots = s.players
    .filter((p) => !p.dead && !(p.keyB64 !== model.myKeyB64 && movement?.positions.get(p.keyB64)?.h))
    .map((p) => ({ ...pos.get(p.keyB64)!, color: colorHex(p.color) }));
  const seen = drawCameras(el.getContext("2d")!, dots, walls);
  const others = s.players.filter((p) => p.keyB64 !== model.myKeyB64);
  const linked = others.filter((p) => model.peerkit.livePlayers.includes(p.keyB64)).length;
  const status = document.getElementById("cams-status");
  if (status) {
    status.textContent = `${seen} on camera · ${
      model.peerkit.relayUp || linked > 0 ? `Synchronizing Ship Status · ${linked}/${others.length} crew linked` : "Network Connection Lost"
    }`;
  }
}

/** A click inside the mini-game. Winning it finishes the task: recorded for
 *  the crew, faked for an impostor (`finishTask`). */
function playMiniGame(data: DOMStringMap) {
  if (!miniGame) return;
  if (!miniGame.act(data, Date.now())) return renderMiniGame();
  const taskId = miniGame.taskId;
  closeMiniGame();
  finishTask(taskId, myRole(model) === 1);
}

miniEl.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.id === "mg-slider") miniGame?.input?.(Number(input.value));
});

/** The lights and comms panels' hold targets, told apart from a console's task
 *  id; crisis consoles count down from `CRISIS_FIX`. */
const LIGHTS_FIX = -1;
const COMMS_FIX = -2;
const CRISIS_FIX = -10;

/** A crisis console: fixed (a held Use ran its course), or, at the reactor,
 *  still held. */
function fixCrisis(panel: number, done: boolean) {
  if (done) sounds.play("task");
  hc?.call("fix_crisis", panel)
    .then(done ? poll : undefined)
    .catch((e: any) => (model.error = errorText(e)));
}

/** A held Use at the lights panel ran its course: turn the lights back on. */
function fixLights() {
  sounds.play("task");
  hc?.call("fix_lights", null)
    .then(poll)
    .catch((e: any) => (model.error = errorText(e)));
}

/** A held Use at the comms panel ran its course: restore comms. */
function fixComms() {
  sounds.play("task");
  hc?.call("fix_comms", null)
    .then(poll)
    .catch((e: any) => (model.error = errorText(e)));
}

// --- vents and doors -------------------------------------------------------

/** Rooms whose doors are shut right now; they open again on their own. */
function closedRooms(s: StateV): number[] {
  const now = Date.now();
  return s.doors_closed.filter((d) => d.until_ms > now).map((d) => d.room);
}

/** An impostor slips into a vent: out of everyone else's sight, and unheard.
 *  Only honest clients hide them — positions still travel over PeerKit. */
function enterVent(id: number) {
  const vent = VENTS.find((v) => v.id === id);
  if (!vent) return;
  model.vent = id;
  model.taskHold = null;
  self.x = vent.x;
  self.y = vent.y;
  movement?.setPos(self.x, self.y);
  movement?.setHidden(true);
  sounds.play("vent");
}

/** Hop to a vent linked to the one I'm in. */
function hopVent(id: number) {
  const here = VENTS.find((v) => v.id === model.vent);
  const there = VENTS.find((v) => v.id === id);
  if (!here?.links.includes(id) || !there) return;
  model.vent = id;
  self.x = there.x;
  self.y = there.y;
  movement?.setPos(self.x, self.y);
  sounds.play("vent");
}

/** Climb out of the vent I'm in, right where it is. */
function leaveVent(sound = true) {
  model.vent = null;
  movement?.setHidden(false);
  if (sound) sounds.play("vent");
}

// --- actions -------------------------------------------------------

function field(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";
}

async function enter(asHost: boolean) {
  if (model.connecting) return;
  model.name = field("f-name") || "Player";
  model.code = field("f-code") || "LOBBY-DEMO";
  model.relayAddr = localRelay ?? model.probe.relay ?? model.relayAddr;
  model.createOpts = {
    players: Number(field("f-players")) || model.createOpts.players,
    impostors: Number(field("f-impostors")) || model.createOpts.impostors,
    tasks: Number(field("f-tasks")) || model.createOpts.tasks,
  };
  persist();
  model.connecting = true;
  model.peerkit.startedAt = Date.now(); // yellow while discovering and joining
  model.error = null;
  render();
  try {
    if (!hc) {
      hc = await Hc.connect(onSignal);
      model.myKeyB64 = encodeHashToBase64(hc.myPubKey);
      void tryLoadHeads(model.myKeyB64);
    }
    model.code = roomInput(model.code);
    let round: number;
    if (model.code.startsWith("LEGACY:")) {
      if (asHost) throw new Error("Create a private game with a new room code. LEGACY: is only for joining older rooms.");
      ({ round } = await currentGame(model.code, model.probe.round));
      await takeSeat(round, false);
    } else if (asHost) {
      const current = await roomRegistry().create(model.code, model.myKeyB64, { ...createConfig(), display_name: model.name });
      round = current.pointer.round;
      selectedSeeds.set(`${model.code}:${round}`, current.pointer.game_seed);
    } else {
      const { current } = await roomRegistry().join(model.code, model.name);
      round = current.pointer.round;
      selectedSeeds.set(`${model.code}:${round}`, current.pointer.game_seed);
    }
    persist();
    await enterGame(round);
    model.entered = true;
    // Best-effort PeerKit. Without an address it starts later, once the game
    // shares one (see `syncRelay`).
    if (model.relayAddr) await startPeerkit(model.relayAddr);
    setInterval(resendChat, 2000);
    setInterval(updateVoice, 150);
    setInterval(watchHost, 3000);
    await poll();
    setInterval(poll, 700);
  } catch (e: any) {
    model.error = errorText(e);
  } finally {
    model.connecting = false;
    render();
  }
}

function onSignal(s: Signal) {
  if (s.kind === "your_role") {
    learnRole((s as any).role);
    render();
  } else if (s.kind === "you_died") {
    sounds.play("kill");
    deathSpot = { x: self.x, y: self.y };
    markBody();
    poll();
  }
}

// Where I fell: kept from the moment I learn of the kill, so a mark that has to
// be retried (below, and from `poll`) still lands there — not wherever my ghost
// has drifted to since.
let deathSpot: { x: number; y: number } | null = null;
let markingBody = false;

/** Record my body's spot. The `you_died` signal can arrive before my kill report
 *  is stored, so the first try may be refused; `poll` retries while my body has
 *  no mark. Without the signal (e.g. a reload), I fall where I am now. */
function markBody() {
  if (!hc || markingBody) return;
  deathSpot ??= { x: self.x, y: self.y };
  markingBody = true;
  hc.call("mark_body", { x: Math.round(deathSpot.x), y: Math.round(deathSpot.y) })
    .catch(() => {})
    .finally(() => (markingBody = false));
}

// --- voting --------------------------------------------------------------

const REVEAL_LEAD_MS = 3000; // reveal my vote this long before voting closes
const TALLY_GRACE_MS = 3000; // the host waits this long after it closes, for late reveals
let revealing: string | null = null; // meetingB64 whose vote I'm revealing

async function revealVote() {
  if (!hc || !model.voteSalt) throw new Error("your vote can't be revealed: it was lost in a reload");
  const choice =
    model.myVoteChoice && model.myVoteChoice !== "skip" ? decodeHashFromBase64(model.myVoteChoice) : null;
  await hc.call("reveal_vote", {
    meeting: meetingHash,
    choice,
    salt: Array.from(model.voteSalt),
  });
}

/** Reveal my vote for this meeting, once; tried again on the next poll if it fails. */
function autoReveal(meetingB64: string) {
  if (revealing === meetingB64 || !model.voteSalt) return;
  revealing = meetingB64;
  revealVote().catch((e: any) => {
    revealing = null;
    model.error = errorText(e);
  });
}

async function act(a: string, data: DOMStringMap) {
  if (!model.entered && a === "choose-mode") {
    // Keep typed values while swapping the Join / Host tabs.
    model.name = field("f-name");
    const newCode = field("f-code") || "LOBBY-DEMO";
    model.createOpts = {
      players: Number(field("f-players")) || model.createOpts.players,
      impostors: Number(field("f-impostors")) || model.createOpts.impostors,
      tasks: Number(field("f-tasks")) || model.createOpts.tasks,
    };
    if (newCode !== model.probe.code) {
      model.probe = freshProbe(newCode, hc ? "looking" : "connecting");
      model.relayAddr = localRelay ?? "";
      void probeLobby();
    }
    model.code = newCode;
    model.menuMode = data.mode === "host" ? "host" : "join";
    persist();
    render();
    return;
  }
  if (!model.entered && a === "new-code") {
    // Room codes aren't passwords, just short human-friendly identifiers.
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
    model.name = field("f-name");
    model.createOpts = {
      players: Number(field("f-players")) || model.createOpts.players,
      impostors: Number(field("f-impostors")) || model.createOpts.impostors,
      tasks: Number(field("f-tasks")) || model.createOpts.tasks,
    };
    model.code = code;
    model.probe = freshProbe(code, hc ? "looking" : "connecting");
    model.relayAddr = localRelay ?? "";
    persist();
    render();
    void probeLobby();
    return;
  }
  if (a === "toggle-settings") {
    model.showSettings = !model.showSettings;
    render();
    return;
  }
  if (a === "copy-code") {
    try { await navigator.clipboard.writeText(model.code); }
    catch { model.error = "Couldn’t copy the code. You can select it from the lobby."; render(); }
    return;
  }
  if (!model.entered && (a === "create" || a === "join")) return enter(a === "create");
  if (!hc) return;
  try {
    model.error = null;
    if (a === "start") {
      await hc.call("deal_roles", null);
      await hc.call(
        "publish_tasks",
        TASKS.map((t) => ({ id: t.id, name: t.name, x: t.x, y: t.y })),
      );
    } else if (a === "use-task") {
      // A console opens its mini-game, vitals and security their panels; sabotage panels are held (see tick()).
      if (model.near.taskId !== null && !miniGame) openMiniGame(model.near.taskId);
      else if (model.near.taskId === null && model.near.atVitals && !vitalsOpen) openVitals();
      else if (model.near.taskId === null && model.near.atSecurity && !camsOpen) openCams();
    } else if (a === "mg") {
      playMiniGame(data);
    } else if (a === "mg-close") {
      closeMiniGame();
    } else if (a === "kill") {
      if (model.near.killKeyB64) {
        await hc.call("kill", decodeHashFromBase64(model.near.killKeyB64));
        lastKillAt = Date.now();
        sounds.play("kill");
      }
    } else if (a === "report") {
      if (model.near.bodyKeyB64)
        await hc.call("report_body", { dead: decodeHashFromBase64(model.near.bodyKeyB64) });
    } else if (a === "vent") {
      if (model.vent !== null) leaveVent();
      else if (model.near.ventId !== null) enterVent(model.near.ventId);
    } else if (a === "vent-to") {
      hopVent(Number(data.vent));
    } else if (a === "close-doors") {
      await hc.call("close_doors", Number(data.room));
    } else if (a === "sabotage") {
      await hc.call("cut_lights", null);
    } else if (a === "sabotage-comms") {
      await hc.call("cut_comms", null);
    } else if (a === "crisis") {
      await hc.call("start_crisis", data.kind);
    } else if (a === "emergency") {
      await hc.call("press_emergency", null);
    } else if (a === "commit-vote") {
      const choice = data.choice === "skip" ? null : decodeHashFromBase64(data.choice!);
      const { voteCommitment, randomSalt } = await import("./vote.js");
      model.voteSalt = randomSalt();
      model.myVoteChoice = data.choice ?? "skip";
      await hc.call("commit_vote", {
        meeting: meetingHash,
        commitment: Array.from(voteCommitment(choice, model.voteSalt)),
      });
    } else if (a === "reveal-vote") {
      await revealVote();
    } else if (a === "resolve") {
      await hc.call("resolve_meeting", meetingHash);
    } else if (a === "dismiss-meeting") {
      model.dismissedMeeting = model.state?.active_meeting?.meetingB64 ?? null;
    } else if (a === "toggle-sound") {
      sounds.setMuted(!sounds.isMuted());
    } else if (a === "toggle-mic") {
      if (voice) await voice.setMic(!voice.micOn());
    } else if (a === "toggle-deafen") {
      voice?.setDeafened(!voice.isDeafened());
    } else if (a === "play-again") {
      await playAgain();
    } else if (a === "leave") {
      location.reload(); // back to the entry screen, which skips past finished games
    }
    await poll();
  } catch (e: any) {
    model.error = errorText(e);
    render();
  }
}

bindActions(app, (a, d) => void act(a, d));
render();
void probeLobby();
