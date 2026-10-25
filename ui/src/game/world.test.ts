import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AIRLOCK_DOORS,
  AIRLOCK_ROOM,
  airlockStep,
  airlockWalls,
  CAMERAS,
  COMMS_PANEL,
  CRISES,
  EMERGENCY,
  hitsWall,
  inAirlock,
  LIGHTS_PANEL,
  lineOfSight,
  MAP_H,
  MAP_W,
  moveWithin,
  PLAYER_R,
  roomAt,
  ROOMS,
  SECURITY_CONSOLE,
  SPAWNS,
  TASKS,
  USE_RADIUS,
  VENTS,
  VITALS,
  WALLS,
  wallsWith,
  type Airlock,
} from "./world.js";

const commons = ROOMS.find((r) => r.name === "Commons")!;
const commonsLeftDoor = commons.doors.find((d) => d.side === "left")!.at;
const walkLeft = (x: number, y: number, ghost: boolean) => {
  let p = { x, y };
  for (let i = 0; i < 40; i++) p = moveWithin(p.x, p.y, -3, 0, ghost);
  return p;
};

test("walls stop players, who slide along them instead of sticking", () => {
  const p = walkLeft(commons.x + 30, commons.y + 30, false); // well clear of the left doorway
  assert.ok(p.x >= commons.x + PLAYER_R, `walked through the wall: x=${p.x}`);
  const slid = moveWithin(p.x, p.y, -3, 3, false);
  assert.ok(slid.y > p.y, "stuck to the wall instead of sliding along it");
});

test("doorways let players through", () => {
  const p = walkLeft(commons.x + 30, commonsLeftDoor, false);
  assert.ok(p.x < commons.x - PLAYER_R, `stuck in the doorway: x=${p.x}`);
});

test("ghosts drift through walls", () => {
  const p = walkLeft(commons.x + 30, commons.y + 30, true);
  assert.ok(p.x < commons.x - PLAYER_R, `a ghost was stopped: x=${p.x}`);
});

test("walls block line of sight; doorways and open rooms don't", () => {
  const inside = { x: commons.x + 30, y: commons.y + 30 };
  assert.ok(lineOfSight(inside.x, inside.y, inside.x, commons.y + 200), "can't see across the room");
  assert.ok(!lineOfSight(inside.x, inside.y, commons.x - 40, inside.y), "saw through the wall");
  assert.ok(lineOfSight(commons.x + 30, commonsLeftDoor, commons.x - 40, commonsLeftDoor), "can't see through the doorway");
});

test("shut doors block a doorway, for movement and sight", () => {
  const door = commonsLeftDoor;
  const shut = wallsWith([ROOMS.indexOf(commons)]);
  let p = { x: commons.x + 30, y: door };
  for (let i = 0; i < 40; i++) p = moveWithin(p.x, p.y, -3, 0, false, shut);
  assert.ok(p.x >= commons.x + PLAYER_R, `walked through shut doors: x=${p.x}`);
  assert.ok(!lineOfSight(commons.x + 30, door, commons.x - 40, door, shut), "saw through shut doors");
  assert.ok(lineOfSight(commons.x + 30, door, commons.x - 40, door, wallsWith([])), "open doors blocked sight");
});

test("the map fits, and every room is distinct", () => {
  for (const w of WALLS) {
    for (const [x, y] of [[w.ax, w.ay], [w.bx, w.by]]) {
      assert.ok(x >= 0 && x <= MAP_W && y >= 0 && y <= MAP_H, `a wall leaves the map at ${x},${y}`);
    }
  }
  assert.equal(new Set(ROOMS.map((r) => r.name)).size, ROOMS.length);
  assert.ok(ROOMS.length <= 32, "a lockdown names a room in a u8 the zome caps at 32");
});

test("the Maintenance Network: links go both ways, and stay in their four local networks plus one shortcut", () => {
  for (const v of VENTS) {
    for (const id of v.links) {
      assert.ok(VENTS.find((w) => w.id === id)?.links.includes(v.id), `hatch ${v.id} → ${id} only goes one way`);
    }
  }
  // flood each network: four separate ones, but the Security ↔ Reactor
  // shortcut merges Central and Engineering
  const reach = (from: number) => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) for (const id of VENTS[queue.pop()!].links) if (!seen.has(id)) (seen.add(id), queue.push(id));
    return [...seen].map((id) => VENTS[id].room).sort();
  };
  assert.deepEqual(reach(0), ["Navigator Bridge", "Shields Control", "Weapons Control"]);
  assert.deepEqual(reach(9), ["Cargo Control", "Decontamination", "Storage Bay"]);
  assert.equal(reach(3).length, 6, "Central + Engineering, joined by one shortcut");
  for (const v of VENTS) assert.equal(roomAt(v.x, v.y)?.name, v.room, `hatch ${v.id} isn't in ${v.room}`);
});

test("every room is reachable, and so is every console, panel, hatch and spawn", () => {
  // flood-fill the walkable map from the first spawn on a coarse grid
  const step = 6;
  const key = (x: number, y: number) => `${x},${y}`;
  const start = { x: Math.round(SPAWNS[0].x / step) * step, y: Math.round(SPAWNS[0].y / step) * step };
  assert.ok(!hitsWall(start.x, start.y), "the spawn is inside a wall");
  const seen = new Set([key(start.x, start.y)]);
  const queue = [start];
  while (queue.length) {
    const { x, y } = queue.pop()!;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < PLAYER_R || ny < PLAYER_R || nx > MAP_W - PLAYER_R || ny > MAP_H - PLAYER_R) continue;
      if (seen.has(key(nx, ny)) || hitsWall(nx, ny) || !lineOfSight(x, y, nx, ny)) continue;
      seen.add(key(nx, ny));
      queue.push({ x: nx, y: ny });
    }
  }
  const spots = [...seen].map((k) => k.split(",").map(Number));
  for (const r of ROOMS) {
    assert.ok(spots.some(([x, y]) => roomAt(x, y) === r), `${r.name} can't be reached`);
  }
  const targets = [
    ...TASKS,
    { name: "the emergency button", ...EMERGENCY },
    { name: "the lights panel", ...LIGHTS_PANEL },
    { name: "the comms panel", ...COMMS_PANEL },
    { name: "the vitals panel", ...VITALS },
    { name: "the security console", ...SECURITY_CONSOLE },
    ...Object.values(CRISES).flatMap((c) => c.panels.map((p, i) => ({ name: `${c.label} console ${i}`, ...p }))),
    ...VENTS.map((v) => ({ name: `the ${v.room} hatch`, x: v.x, y: v.y })),
    ...SPAWNS.map((s, i) => ({ name: `spawn ${i}`, ...s })),
  ];
  for (const target of targets) {
    const reachable = spots.some(
      ([x, y]) => Math.hypot(x - target.x, y - target.y) < USE_RADIUS && lineOfSight(x, y, target.x, target.y),
    );
    assert.ok(reachable, `${target.name} can't be reached`);
  }
});

test("spawns are apart, on the Bridge, and clear of walls", () => {
  for (const [i, s] of SPAWNS.entries()) {
    assert.equal(roomAt(s.x, s.y)?.name, "Navigator Bridge", `spawn ${i}`);
    assert.ok(!hitsWall(s.x, s.y), `spawn ${i} is in a wall`);
    for (const t of SPAWNS.slice(i + 1)) assert.ok(Math.hypot(s.x - t.x, s.y - t.y) >= PLAYER_R * 2, "spawns overlap");
  }
});

test("the reactor's two consoles are too far apart for one player", () => {
  const [a, b] = CRISES.reactor.panels;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > USE_RADIUS * 4);
  for (const p of CRISES.reactor.panels) assert.equal(roomAt(p.x, p.y)?.name, "Reactor Core");
  for (const p of CRISES.nav_drift.panels) assert.equal(roomAt(p.x, p.y)?.zone, "forward");
});

test("cameras sit on the map", () => {
  for (const c of CAMERAS) assert.ok(c.x > 0 && c.x < MAP_W && c.y > 0 && c.y < MAP_H, c.name);
});

test("the airlock: in, both doors shut, then only the far one opens", () => {
  const r = ROOMS[AIRLOCK_ROOM];
  const [top, left] = AIRLOCK_DOORS; // doors in declaration order: top (Storage), left (keel corridor)
  assert.equal(top.ay, r.y);
  let a: Airlock = { phase: "idle" };
  // outside: nothing happens
  a = airlockStep(a, r.x + r.w / 2, r.y - 30, 0, 3500);
  assert.equal(a.phase, "idle");
  assert.deepEqual(airlockWalls(a, 0), []);
  // in through the top door
  const x = r.x + r.w / 2;
  const y = r.y + PLAYER_R + 6;
  assert.ok(inAirlock(x, y));
  a = airlockStep(a, x, y, 1000, 3500);
  assert.equal(a.phase, "cycling");
  assert.deepEqual(airlockWalls(a, 1000), [top, left], "both doors shut while decontaminating");
  // can't walk back out
  let p = { x, y };
  for (let i = 0; i < 20; i++) p = moveWithin(p.x, p.y, 0, -3, false, [...WALLS, ...airlockWalls(a, 2000)]);
  assert.ok(inAirlock(p.x, p.y, 0), "walked back out mid-cycle");
  assert.equal(airlockStep(a, p.x, p.y, 2000, 3500), a, "leaning on the shut door reset it");
  // once it's done, only the door I came in by stays shut
  assert.deepEqual(airlockWalls(a, 4500), [top]);
  assert.equal(airlockStep(a, x, y, 4500, 3500), a, "stays cycling while still inside");
  // leaving resets it
  a = airlockStep(a, r.x - 40, left.ay + 30, 5000, 3500);
  assert.equal(a.phase, "idle");
});
