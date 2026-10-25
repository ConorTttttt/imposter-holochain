// The map: the Holo-Net Node, a GREYBOX. Rooms with walls and doorways,
// corridors between them, solid blocks for cover and sightline breaks, the
// task consoles, sabotage panels, the Maintenance Network and the spawns.
// Everything is plain data in map px, meant to be moved around between
// playtests. The same `TASKS` array is what the host publishes on-chain (so
// the `task_id`s line up) and what the canvas draws. Movement, collision and
// line of sight all run in each player's own window.
//
//                       Navigator Bridge (spawn)
//                               │
//       Shields ──────── Communications ──────── Weapons
//          │                    │                   │
//       Medical ───────────  Commons  ───────── Life Support
//                              ║ ║
//   Security ─────────────  Core Engine  ─────────── Cargo Control
//      │                        │                       │
//   Reactor ────────────────────┘                    Storage Bay
//      │                                                │
//   Electrical ──────────── (loop corridor) ──────── Decontamination

export const MAP_W = 2400;
export const MAP_H = 2260;

export const PLAYER_R = 11;
export const USE_RADIUS = 46; // stand this close to a console / body / victim
/** Normal walking speed, map px per frame; the host's player speed scales it. */
export const WALK_SPEED = 3.2;
export const KILL_COOLDOWN_MS = 8000;
/** How long Use is held at a sabotage panel to fix it. */
export const TASK_HOLD_MS = 2500;
/** How far voices carry on the map when there's no fog to go by (map px). */
export const HEARING_RADIUS = 250;
/** How much a wall between two players turns their voices down. */
export const WALL_MUFFLE = 0.3;

/**
 * Playtest tunables that live in this window. Two more live on the zome side,
 * because the host enforces them: the door lockdown (`DOOR_CLOSE_MS`, 10 s, in
 * the coordinator) and the crisis durations (`REACTOR_EMERGENCY_MS`,
 * `LIFE_SUPPORT_MS`, `NAV_DRIFT_MS` in `imposter-core`'s crisis.rs, which
 * validation re-checks a meltdown against).
 */
export const TUNING = {
  /** How long the airlock holds you between its doors. */
  decontaminationMs: 3500,
  /** Crew vision while the lights are out (map px). */
  lightsOutCrewVision: 60,
  /** Impostor vision while the lights are out (map px): better than the crew's. */
  lightsOutImpostorVision: 220,
  /** How often a held reactor console re-confirms the hold. */
  reactorConfirmEveryMs: 900,
  /** How far a security camera sees (map px). */
  cameraRange: 300,
};

type Side = "left" | "right" | "top" | "bottom";
export type Zone = "forward" | "central" | "engineering" | "cargo";

/** An opening in one side of a rect, centred `at` map px along that side. */
type Gap = { side: Side; at: number; width: number };

/** A room. Its `doors` are real doors: a lockdown shuts them. */
export type Room = { x: number; y: number; w: number; h: number; name: string; zone: Zone; doors: Gap[] };
/** A corridor between rooms. Its open ends are never shut. */
export type Hall = { x: number; y: number; w: number; h: number; open: Gap[] };
/** A solid block: machinery, crates, cabinets, benches. Walls on every side. */
export type Block = { x: number; y: number; w: number; h: number };

export const DOOR_WIDTH = 64;

const door = (side: Side, at: number): Gap => ({ side, at, width: DOOR_WIDTH });

function room(name: string, zone: Zone, x: number, y: number, w: number, h: number, doors: Gap[]): Room {
  return { name, zone, x, y, w, h, doors };
}

/** A corridor; a bare side name opens that whole side. */
function hall(x: number, y: number, w: number, h: number, open: (Side | Gap)[]): Hall {
  const whole = (side: Side): Gap =>
    side === "left" || side === "right" ? { side, at: y + h / 2, width: h } : { side, at: x + w / 2, width: w };
  return { x, y, w, h, open: open.map((o) => (typeof o === "string" ? whole(o) : o)) };
}

// Indices matter: a door lockdown names a room by its index here (on-chain, as a u8).
export const ROOMS: Room[] = [
  // FORWARD
  room("Navigator Bridge", "forward", 960, 60, 480, 240, [door("bottom", 1200)]),
  room("Communications Array", "forward", 880, 380, 620, 160, [
    door("top", 1200),
    door("left", 450),
    door("right", 470),
    door("bottom", 1240),
  ]),
  room("Shields Control", "forward", 360, 330, 300, 240, [door("right", 450), door("bottom", 470)]),
  room("Weapons Control", "forward", 1780, 300, 280, 260, [door("left", 470), door("bottom", 1930)]),
  room("Medical Bay", "forward", 330, 690, 340, 250, [door("top", 470), door("right", 860)]),
  room("Life Support", "forward", 1760, 670, 320, 240, [door("top", 1930), door("left", 820)]),
  // CENTRAL
  room("Commons", "central", 880, 700, 640, 380, [
    door("left", 860),
    door("right", 820),
    door("top", 1240),
    door("bottom", 1060),
    door("bottom", 1360),
  ]),
  room("Core Engine", "central", 800, 1220, 800, 380, [
    door("top", 1060),
    door("top", 1360),
    door("left", 1480),
    door("right", 1320),
    door("bottom", 1000),
  ]),
  // ENGINEERING
  room("Security & Network", "engineering", 340, 1320, 320, 240, [door("right", 1480), door("bottom", 500)]),
  room("Reactor Core", "engineering", 220, 1680, 560, 260, [door("top", 500), door("right", 1820), door("bottom", 420)]),
  room("Electrical Systems", "engineering", 260, 2020, 420, 200, [door("top", 420), door("right", 2160)]),
  // CARGO
  room("Cargo Control", "cargo", 1740, 1200, 320, 220, [door("left", 1320), door("bottom", 1900)]),
  room("Storage Bay", "cargo", 1620, 1520, 560, 360, [door("top", 1900), door("bottom", 1760)]),
  room("Decontamination", "cargo", 1680, 1980, 160, 220, [door("top", 1760), door("left", 2160)]),
];

export const HALLS: Hall[] = [
  hall(1160, 300, 80, 80, ["top", "bottom"]), // Bridge ↔ Communications
  hall(660, 410, 220, 80, ["left", "right"]), // Communications ↔ Shields
  hall(1500, 430, 280, 80, ["left", "right"]), // Communications ↔ Weapons
  hall(430, 570, 80, 120, ["top", "bottom"]), // Shields ↔ Medical
  hall(1890, 560, 80, 110, ["top", "bottom"]), // Weapons ↔ Life Support
  hall(670, 820, 210, 80, ["left", "right"]), // Medical ↔ Commons
  hall(1520, 780, 240, 80, ["left", "right"]), // Life Support ↔ Commons
  hall(1200, 540, 80, 160, ["top", "bottom"]), // Communications ↔ Commons
  hall(1020, 1080, 80, 140, ["top", "bottom"]), // Commons ↔ Core Engine, west
  hall(1320, 1080, 80, 140, ["top", "bottom"]), // Commons ↔ Core Engine, east
  hall(660, 1440, 140, 80, ["left", "right"]), // Core Engine ↔ Security
  hall(1600, 1280, 140, 80, ["left", "right"]), // Core Engine ↔ Cargo Control
  hall(460, 1560, 80, 120, ["top", "bottom"]), // Security ↔ Reactor
  hall(780, 1780, 180, 80, ["left", "right"]), // Reactor → …
  hall(960, 1600, 80, 260, ["top", { side: "left", at: 1820, width: 80 }]), // … ↔ Core Engine
  hall(380, 1940, 80, 80, ["top", "bottom"]), // Reactor ↔ Electrical
  hall(1860, 1420, 80, 100, ["top", "bottom"]), // Cargo Control ↔ Storage
  hall(1720, 1880, 80, 100, ["top", "bottom"]), // Storage ↔ Decontamination
  hall(680, 2120, 1000, 80, ["left", "right"]), // Electrical ↔ Decontamination, along the keel
];

export const BLOCKS: Block[] = [
  // Commons: benches that break the hub up a little
  { x: 960, y: 780, w: 140, h: 24 },
  { x: 1300, y: 960, w: 150, h: 24 },
  { x: 1390, y: 760, w: 40, h: 40 },
  // Core Engine: machinery — you see them go in, not what happens inside
  { x: 900, y: 1300, w: 110, h: 70 },
  { x: 1330, y: 1290, w: 120, h: 50 },
  { x: 1090, y: 1450, w: 170, h: 60 },
  { x: 1460, y: 1440, w: 60, h: 100 },
  { x: 1180, y: 1300, w: 40, h: 40 },
  // Reactor Core: the core itself, between its two consoles
  { x: 460, y: 1770, w: 80, h: 80 },
  // Electrical Systems: cabinets, deliberately cramped
  { x: 330, y: 2060, w: 24, h: 110 },
  { x: 420, y: 2090, w: 120, h: 24 },
  { x: 560, y: 2040, w: 24, h: 100 },
  { x: 470, y: 2150, w: 24, h: 70 },
  // Storage Bay: containers and racks, some cover
  { x: 1700, y: 1600, w: 90, h: 70 },
  { x: 1880, y: 1640, w: 60, h: 140 },
  { x: 2020, y: 1580, w: 100, h: 60 },
  { x: 2000, y: 1740, w: 120, h: 70 },
  { x: 1660, y: 1720, w: 70, h: 60 },
];

/** A wall: a straight segment from (ax, ay) to (bx, by). */
export type Wall = { ax: number; ay: number; bx: number; by: number };

type Rect = { x: number; y: number; w: number; h: number };

/** A rect's four sides, each split around its openings. */
function rectWalls(r: Rect, gaps: Gap[]): Wall[] {
  const sides: [Side, number, number, number, number][] = [
    ["top", r.x, r.y, r.x + r.w, r.y],
    ["bottom", r.x, r.y + r.h, r.x + r.w, r.y + r.h],
    ["left", r.x, r.y, r.x, r.y + r.h],
    ["right", r.x + r.w, r.y, r.x + r.w, r.y + r.h],
  ];
  return sides.flatMap(([side, ax, ay, bx, by]) => {
    const vertical = ax === bx;
    const from = vertical ? ay : ax;
    const to = vertical ? by : bx;
    const cuts = gaps
      .filter((g) => g.side === side)
      .map((g) => [g.at - g.width / 2, g.at + g.width / 2])
      .sort((a, b) => a[0] - b[0]);
    const out: Wall[] = [];
    let at = from;
    for (const [lo, hi] of [...cuts, [to, to]]) {
      if (lo > at) out.push(vertical ? { ax, ay: at, bx, by: lo } : { ax: at, ay, bx: lo, by });
      at = Math.max(at, hi);
    }
    return out;
  });
}

export const WALLS: Wall[] = [
  ...ROOMS.flatMap((r) => rectWalls(r, r.doors)),
  ...HALLS.flatMap((h) => rectWalls(h, h.open)),
  ...BLOCKS.flatMap((b) => rectWalls(b, [])),
];

/** A doorway, as the segment that fills its gap while it's shut. */
export type Door = { room: number; wall: Wall };

export const DOORS: Door[] = ROOMS.flatMap((r, room) =>
  r.doors.map(({ side, at, width }) => {
    const half = width / 2;
    if (side === "left" || side === "right") {
      const x = side === "left" ? r.x : r.x + r.w;
      return { room, wall: { ax: x, ay: at - half, bx: x, by: at + half } };
    }
    const y = side === "top" ? r.y : r.y + r.h;
    return { room, wall: { ax: at - half, ay: y, bx: at + half, by: y } };
  }),
);

/** The walls in force: every wall, plus the doorways of rooms whose doors are shut. */
export function wallsWith(closedRooms: number[]): Wall[] {
  if (closedRooms.length === 0) return WALLS;
  return [...WALLS, ...DOORS.filter((d) => closedRooms.includes(d.room)).map((d) => d.wall)];
}

/** The room a spot is in, if any (corridors aren't rooms). */
export function roomAt(x: number, y: number): Room | undefined {
  return ROOMS.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

const roomIndex = (name: string) => ROOMS.findIndex((r) => r.name === name);

// --- decontamination airlock ----------------------------------------------
// Two doors. Step inside and both shut behind you; after `decontaminationMs`
// the far one opens. Each window runs its own airlock for its own player —
// like movement, it never reaches the DHT — so it's only ever your doors that
// shut, never someone else's.

export const AIRLOCK_ROOM = roomIndex("Decontamination");
export const AIRLOCK_DOORS: Wall[] = DOORS.filter((d) => d.room === AIRLOCK_ROOM).map((d) => d.wall);

export type Airlock = { phase: "idle" } | { phase: "cycling"; from: number; until: number };

/** Whether a player standing at (x, y) is inside the airlock: wholly inside,
 *  clear of both doorways (`margin`), or — once it's cycling — anywhere in it,
 *  so leaning on a shut door doesn't count as leaving. */
export function inAirlock(x: number, y: number, margin = PLAYER_R + 2): boolean {
  const r = ROOMS[AIRLOCK_ROOM];
  return x > r.x + margin && x < r.x + r.w - margin && y > r.y + margin && y < r.y + r.h - margin;
}

function distToWall(x: number, y: number, w: Wall): number {
  const vx = w.bx - w.ax;
  const vy = w.by - w.ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - w.ax) * vx + (y - w.ay) * vy) / len2));
  return Math.hypot(x - (w.ax + t * vx), y - (w.ay + t * vy));
}

/** The airlock's next state, for a living player at (x, y). */
export function airlockStep(a: Airlock, x: number, y: number, now: number, durationMs = TUNING.decontaminationMs): Airlock {
  if (a.phase === "idle") {
    if (!inAirlock(x, y)) return a;
    // the door they came through: the nearer one
    const dists = AIRLOCK_DOORS.map((w) => distToWall(x, y, w));
    return { phase: "cycling", from: dists.indexOf(Math.min(...dists)), until: now + durationMs };
  }
  return inAirlock(x, y, 0) ? a : { phase: "idle" };
}

/** The airlock doors shut for this player right now: both while cycling, then
 *  only the one they came in by. */
export function airlockWalls(a: Airlock, now: number): Wall[] {
  if (a.phase === "idle") return [];
  return now < a.until ? AIRLOCK_DOORS : [AIRLOCK_DOORS[a.from]];
}

// --- consoles ----------------------------------------------------------------

/** `scan`: this console's mini-game publishes the player's own role, proved
 *  against the commitment — public, unforgeable proof of crew, from then on
 *  (see `scan_role` in the coordinator). An impostor gains nothing from a real
 *  one, so it's faked like any other task. Ids 0–5 have their own mini-games;
 *  the rest are greybox placeholders (a plain confirm). */
export type TaskDef = { id: number; name: string; x: number; y: number; scan?: boolean };

export const TASKS: TaskDef[] = [
  { id: 0, name: "Align Engine Output", x: 1240, y: 1560 }, // Core Engine
  { id: 1, name: "Refuel Reactor", x: 620, y: 1720 }, // Reactor Core
  { id: 2, name: "Calibrate Distributor", x: 630, y: 2060 }, // Electrical
  { id: 3, name: "Prime Shields", x: 420, y: 380 }, // Shields Control
  { id: 4, name: "Chart Course", x: 1040, y: 110 }, // Navigator Bridge
  { id: 5, name: "Medical Scan", x: 400, y: 890, scan: true }, // Medical Bay
  { id: 6, name: "Calibrate Targeting", x: 2000, y: 350 }, // Weapons Control
  { id: 7, name: "Check Oxygen Filters", x: 2030, y: 860 }, // Life Support
  { id: 8, name: "Relay Ship Status", x: 960, y: 420 }, // Communications
  { id: 9, name: "Verify Shipment", x: 1790, y: 1250 }, // Cargo Control
  { id: 10, name: "Scan Container", x: 2010, y: 1250 }, // Cargo Control
  { id: 11, name: "Confirm Manifest", x: 2010, y: 1380 }, // Cargo Control
  { id: 12, name: "Assign Cargo Route", x: 1790, y: 1380 }, // Cargo Control
  { id: 13, name: "Synchronize Inventory", x: 2130, y: 1840 }, // Storage Bay
  { id: 14, name: "Clear Network Alerts", x: 620, y: 1360 }, // Security & Network
  { id: 15, name: "Reset Breakers", x: 300, y: 2190 }, // Electrical
  { id: 16, name: "Inspect Decontam Seals", x: 1800, y: 2020 }, // Decontamination
  { id: 17, name: "Log Crew Status", x: 1470, y: 1040 }, // Commons
];

/** The most tasks one player can be given: one per console. */
export const TASK_TARGET = TASKS.length;

/** The emergency meeting button, in the middle of Commons. */
export const EMERGENCY = { x: 1200, y: 900 };

/** The lights panel, where Lights Out is fixed (in Electrical). */
export const LIGHTS_PANEL = { x: 300, y: 2045 };
/** How far the crew sees while the lights are out (map px). */
export const LIGHTS_OUT_VISION = TUNING.lightsOutCrewVision;

/** The comms panel, where a comms sabotage is fixed (in Communications). */
export const COMMS_PANEL = { x: 1440, y: 420 };

/** The vitals panel, where anyone sees who's alive, dead or gone (in Medical Bay). */
export const VITALS = { x: 630, y: 730 };

/** The security console: camera feeds and network monitoring. Whoever watches
 *  stands still with their back to the room. */
export const SECURITY_CONSOLE = { x: 400, y: 1500 };

/** Security cameras: what the console shows. */
export const CAMERAS: { name: string; x: number; y: number }[] = [
  { name: "Commons", x: 900, y: 720 },
  { name: "Core Engine", x: 1580, y: 1240 },
  { name: "Storage Bay", x: 2160, y: 1540 },
  { name: "Comms corridor", x: 1240, y: 560 },
  { name: "Keel corridor", x: 1180, y: 2140 },
];

/** Crisis sabotage consoles, by the zome's `CrisisKind`. Console order is the
 *  panel number `fix_crisis` takes. */
export type CrisisKind = "reactor" | "life_support" | "nav_drift";

export const CRISES: Record<CrisisKind, { label: string; panels: { x: number; y: number }[] }> = {
  // far enough apart that one player can't hold both
  reactor: { label: "Reactor Emergency", panels: [{ x: 270, y: 1720 }, { x: 735, y: 1900 }] },
  // opposite sides of the ship
  life_support: { label: "Life Support", panels: [{ x: 2040, y: 720 }, { x: 380, y: 1530 }] },
  // pulls everyone forward
  nav_drift: {
    label: "Navigation Drift",
    panels: [{ x: 1380, y: 110 }, { x: 610, y: 530 }, { x: 1830, y: 520 }],
  },
};

// --- Maintenance Network --------------------------------------------------
// Impostors slip in, hop along linked hatches out of sight, and climb out.
// Four small local networks plus one shortcut (Security ↔ Reactor) — never
// one network that spans the ship.

export type Vent = { id: number; x: number; y: number; room: string; links: number[] };

export const VENTS: Vent[] = [
  // Forward: Bridge — Shields — Weapons
  { id: 0, x: 1000, y: 260, room: "Navigator Bridge", links: [1] },
  { id: 1, x: 390, y: 540, room: "Shields Control", links: [0, 2] },
  { id: 2, x: 2030, y: 525, room: "Weapons Control", links: [1] },
  // Central: Medical — Security — Commons
  { id: 3, x: 630, y: 905, room: "Medical Bay", links: [4] },
  { id: 4, x: 370, y: 1350, room: "Security & Network", links: [3, 5, 6] },
  { id: 5, x: 920, y: 1050, room: "Commons", links: [4] },
  // Engineering: Reactor — Electrical — Core Engine
  { id: 6, x: 250, y: 1910, room: "Reactor Core", links: [4, 7] },
  { id: 7, x: 640, y: 2190, room: "Electrical Systems", links: [6, 8] },
  { id: 8, x: 1560, y: 1570, room: "Core Engine", links: [7] },
  // Cargo: Cargo Control — Storage — Decontamination
  { id: 9, x: 2030, y: 1310, room: "Cargo Control", links: [10] },
  { id: 10, x: 1650, y: 1850, room: "Storage Bay", links: [9, 11] },
  { id: 11, x: 1810, y: 2170, room: "Decontamination", links: [10] },
];

// --- spawns ---------------------------------------------------------------

/** Where players start, by seat: spread around the Navigator Bridge. */
export const SPAWNS: { x: number; y: number }[] = [
  { x: 1200, y: 200 },
  { x: 1120, y: 170 },
  { x: 1280, y: 170 },
  { x: 1060, y: 230 },
  { x: 1340, y: 230 },
  { x: 1160, y: 250 },
  { x: 1240, y: 250 },
  { x: 1020, y: 160 },
  { x: 1380, y: 160 },
  { x: 1200, y: 130 },
];
export const SPAWN = SPAWNS[0];

export function spawnFor(seat: number | null): { x: number; y: number } {
  return SPAWNS[(seat ?? 0) % SPAWNS.length];
}

/** Vision radius presets (map px) the host picks from in the lobby; 0 = no fog.
 *  The coordinator's `GameSettings::default()` is Normal crew, Long impostor. */
export const VISION_PRESETS: { label: string; radius: number }[] = [
  { label: "Short", radius: 110 },
  { label: "Normal", radius: 170 },
  { label: "Long", radius: 250 },
  { label: "Very long", radius: 340 },
  { label: "No fog", radius: 0 },
];

export function visionLabel(radius: number): string {
  return VISION_PRESETS.find((p) => p.radius === radius)?.label ?? `${radius}px`;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function clampToMap(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(PLAYER_R, Math.min(MAP_W - PLAYER_R, x)),
    y: Math.max(PLAYER_R, Math.min(MAP_H - PLAYER_R, y)),
  };
}

/** Whether a player standing at (x, y) would overlap a wall. `walls` defaults
 *  to the fixed walls; pass `wallsWith(...)` while doors are shut. */
export function hitsWall(x: number, y: number, walls: Wall[] = WALLS): boolean {
  return walls.some((w) => distToWall(x, y, w) < PLAYER_R);
}

/** Where a move by (dx, dy) from (x, y) ends up. Walls stop the living — one
 *  axis at a time, so they slide along a wall rather than sticking to it —
 *  and ghosts drift straight through. Nobody leaves the map. */
export function moveWithin(
  x: number,
  y: number,
  dx: number,
  dy: number,
  ghost: boolean,
  walls: Wall[] = WALLS,
): { x: number; y: number } {
  if (ghost) return clampToMap(x + dx, y + dy);
  const stuck = hitsWall(x, y, walls); // already overlapping a wall (or a door that shut on me): walk out
  let nx = clampToMap(x + dx, y).x;
  if (!stuck && hitsWall(nx, y, walls)) nx = x;
  let ny = clampToMap(nx, y + dy).y;
  if (!stuck && hitsWall(nx, ny, walls)) ny = y;
  return { x: nx, y: ny };
}

/** Whether the straight line between two points crosses no wall. Vision,
 *  voices and every reach (kill, report, console, button) go through this. */
export function lineOfSight(ax: number, ay: number, bx: number, by: number, walls: Wall[] = WALLS): boolean {
  return !walls.some((w) => crosses(ax, ay, bx, by, w));
}

/** Whether segment p–q properly crosses wall `w`; grazing an end doesn't count. */
function crosses(px: number, py: number, qx: number, qy: number, w: Wall): boolean {
  const side = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return (
    side(w.ax, w.ay, w.bx, w.by, px, py) * side(w.ax, w.ay, w.bx, w.by, qx, qy) < 0 &&
    side(px, py, qx, qy, w.ax, w.ay) * side(px, py, qx, qy, w.bx, w.by) < 0
  );
}
