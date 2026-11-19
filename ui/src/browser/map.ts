import { draw, VIEW_H, VIEW_W, type CanvasView } from "../game/canvas.js";
import { colorHex } from "../game/colors.js";
import {
  airlockStep, airlockWalls, dist, DOORS, EMERGENCY, lineOfSight, moveWithin, roomAt, spawnFor, USE_RADIUS,
  WALK_SPEED, wallsWith, WALLS,
  type Airlock,
} from "../game/world.js";
import { BrowserMovement, type SignMovement } from "./movement.js";
import type { Point } from "./movement-wire.js";
import { browserAssignments, mountBrowserTasks } from "./tasks.js";
import type { CallMeeting } from "./meetings.js";

type Player = {
  key: unknown;
  name: string;
  seat: number | null;
  color: number;
  dead: boolean;
};

type State = {
  code: string | null;
  phase: "lobby" | "playing" | "meeting" | "ended";
  my_seat: number | null;
  players: Player[];
  tasks: { id: number }[];
  my_tasks_done: number[];
  tasks_done: number;
  task_target: number;
  player_count: number;
  impostor_count: number;
  bodies: { key: unknown; at: Point | null }[];
  emergency_ready_at: number | null;
  emergencies_left: number;
  crisis: unknown;
  doors_closed: { room: number; until_ms: number }[];
  settings: { player_speed: number };
};

type MapUpdate = {
  authenticated: boolean;
  state: State | null;
  dna?: string;
  seed?: string;
  identity: string | null;
  sign?: SignMovement;
  role: 0 | 1 | null;
  submit?: (id: number) => Promise<void>;
  callMeeting?: CallMeeting;
  toBytes: (value: unknown) => Uint8Array;
  hash: (value: unknown) => string;
};

const MOVEMENT_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"]);

export function mountBrowserMap() {
  const panel = document.querySelector<HTMLElement>("#gameplay-map")!;
  const canvas = panel.querySelector("canvas")!;
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  const ctx = canvas.getContext("2d");
  const status = panel.querySelector<HTMLElement>("#movement-status")!;
  const location = panel.querySelector<HTMLElement>("#ship-location")!;
  const roster = panel.querySelector<HTMLOListElement>("#movement-players")!;
  const tasks = mountBrowserTasks(panel, canvas);
  const emergency = panel.querySelector<HTMLButtonElement>("#call-emergency")!;
  const report = panel.querySelector<HTMLButtonElement>("#report-body")!;
  const meetingStatus = panel.querySelector<HTMLElement>("#map-meeting-status")!;
  const keys = new Set<string>();
  let state: State | null = null;
  let self: Point = spawnFor(null);
  let identity: string | null = null;
  let scope: string | null = null;
  let movement: BrowserMovement | null = null;
  let players: (Omit<Player, "key"> & { agent: string })[] = [];
  let assigned: number[] = [];
  const peers = new Set<string>();
  let airlock: Airlock = { phase: "idle" };
  let previous = 0;
  let rosterLabel = "";
  let frame = 0;
  let atEmergency = false;
  let reportTarget: Uint8Array | null = null;
  let contactMeeting: CallMeeting | undefined;
  let bodies: (Point & { name: string; color: string; key: Uint8Array })[] = [];
  let meetingPending = false;

  canvas.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (!MOVEMENT_KEYS.has(key) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    keys.add(key);
  });
  window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
  canvas.addEventListener("blur", () => keys.clear());
  window.addEventListener("blur", () => keys.clear());
  window.addEventListener("pagehide", () => movement?.stop());

  emergency.addEventListener("click", () => {
    if (state && atEmergency && !emergency.disabled) void openMeeting("press_emergency", null);
  });
  report.addEventListener("click", () => {
    if (state && reportTarget && !report.disabled) void openMeeting("report_body", { dead: reportTarget });
  });

  async function openMeeting(action: "press_emergency" | "report_body", payload: unknown) {
    if (!contactMeeting || meetingPending) return;
    meetingPending = true;
    meetingStatus.textContent = "";
    try {
      await contactMeeting(action, payload);
    } catch {
      meetingStatus.textContent = "Meeting unavailable. Check the round state and try again.";
    } finally {
      meetingPending = false;
    }
  }

  function tick(now: number) {
    frame = 0;
    if (!state || !ctx || panel.hidden) return;
    frame = requestAnimationFrame(tick);
    const elapsed = Math.min(Math.max(0, now - previous), 50);
    previous = now;
    const wallTime = Date.now();
    const closed = state.doors_closed.filter((door) => door.until_ms > wallTime).map((door) => door.room);
    const local = players.find((player) => player.agent === identity);
    if (!local) return;
    airlock = local.dead ? { phase: "idle" } : airlockStep(airlock, self.x, self.y, wallTime);
    const airlockDoors = airlockWalls(airlock, wallTime);
    const walls = closed.length || airlockDoors.length ? [...wallsWith(closed), ...airlockDoors] : WALLS;
    const dx = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
    const dy = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
    const direction = Math.hypot(dx, dy);
    if (direction && !tasks.active) {
      const distance = WALK_SPEED * state.settings.player_speed / 100 * elapsed / (1000 / 60);
      const steps = Math.ceil(distance / WALK_SPEED);
      for (let i = 0; i < steps; i++) {
        const step = distance / (steps * direction);
        self = moveWithin(self.x, self.y, dx * step, dy * step, local.dead, walls);
      }
    }
    tasks.tick(self, walls, now);
    const inReach = (point: Point) =>
      dist(self.x, self.y, point.x, point.y) < USE_RADIUS && lineOfSight(self.x, self.y, point.x, point.y, walls);
    atEmergency = !local.dead && inReach(EMERGENCY);
    emergency.disabled = !atEmergency || meetingPending || tasks.active || state.emergencies_left < 1 || Boolean(state.crisis) ||
      state.emergency_ready_at == null || wallTime < state.emergency_ready_at;
    reportTarget = local.dead ? null : bodies.find(inReach)?.key ?? null;
    report.hidden = !bodies.length;
    report.disabled = !reportTarget || meetingPending || tasks.active;
    movement?.tick(now, self, peers);
    const dots: CanvasView["dots"] = [];
    const rows = [];
    for (const player of players) {
      const isMe = player.agent === identity;
      const p = isMe ? self : movement?.position(player.agent, now);
      rows.push({ seat: player.seat, name: player.name, color: colorHex(player.color), isMe, here: Boolean(p) });
      if (!p || (player.dead && !local.dead)) continue;
      dots.push({
        ...p, keyB64: player.agent, name: player.name, color: colorHex(player.color),
        dead: player.dead, isMe, hidden: false, isImpostorView: false,
      });
    }
    draw(ctx, {
      dots, walls, airlockDoors, closedDoors: DOORS.filter((door) => closed.includes(door.room)).map((door) => door.wall),
      bodies, atEmergency, lightsOut: false, atLights: false, atComms: false, commsOut: false,
      atVitals: false, atSecurity: false, crisis: null, killRadius: 0, nearVent: null,
      myTasks: assigned, myDone: tasks.done,
      taskHold: null, tasksDoneTotal: state.tasks_done, taskTarget: state.task_target, vision: null,
    });
    const transportStatus = movement?.connected ? "Movement connected" : "Movement reconnecting · you can still explore";
    if (status.textContent !== transportStatus) status.textContent = transportStatus;
    const room = roomAt(self.x, self.y)?.name ?? "Corridor";
    if (location.textContent !== room) location.textContent = room;
    const label = JSON.stringify(rows);
    if (label !== rosterLabel) {
      rosterLabel = label;
      roster.replaceChildren(...rows.map((row) => {
        const item = document.createElement("li");
        item.style.setProperty("--player-color", row.color);
        item.textContent = row.name + (row.isMe ? " (you)" : row.here ? " · Connected" : " · Offline");
        return item;
      }));
    }
  }

  return {
    update({ authenticated, state: latest, dna, seed, identity: agent, sign, hash, role, submit, callMeeting, toBytes }: MapUpdate) {
      const usable = authenticated && dna && agent && latest && latest.code === seed &&
        latest.phase === "playing" && Number.isInteger(latest.my_seat);
      if (!usable || !latest || !agent || !dna) {
        panel.hidden = true;
        keys.clear();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        movement?.stop();
        tasks.update(null);
        state = null;
        contactMeeting = undefined;
        return;
      }
      const nextScope = JSON.stringify([dna, agent, latest.my_seat]);
      if (scope !== nextScope) {
        movement?.stop();
        scope = nextScope;
        self = spawnFor(latest.my_seat);
        airlock = { phase: "idle" };
        movement = sign ? new BrowserMovement(dna, agent, sign) : null;
      }
      identity = agent;
      state = latest;
      contactMeeting = callMeeting;
      players = latest.players.filter((player) => Number.isInteger(player.seat)).map((player) => ({
        name: player.name, seat: player.seat, dead: player.dead, color: player.color, agent: hash(player.key),
      }));
      peers.clear();
      for (const player of players) if (player.agent !== identity) peers.add(player.agent);
      bodies = (latest.bodies ?? []).flatMap((body) => {
        if (!body.at) return [];
        const player = players.find((row) => row.agent === hash(body.key));
        return player ? [{ ...body.at, key: toBytes(body.key), name: player.name, color: colorHex(player.color) }] : [];
      });
      const objectives = browserAssignments(latest.tasks, latest.task_target, latest.player_count - latest.impostor_count);
      assigned = role != null ? objectives.map((task) => task.id) : [];
      tasks.update({
        scope: nextScope, role, assigned: objectives, done: latest.my_tasks_done, submit,
      });
      panel.hidden = false;
      if (!frame) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    },
  };
}
