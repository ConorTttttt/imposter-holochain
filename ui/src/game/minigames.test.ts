import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIAL_DEG_PER_MS,
  HITS_NEEDED,
  inZone,
  needleAngle,
  PUMPS_NEEDED,
  startMiniGame,
  WAYPOINTS,
} from "./minigames.js";

const half = () => 0.5;
const zero = () => 0;
const click = (mg: string, extra: Record<string, string> = {}) => ({ mg, ...extra }) as DOMStringMap;

test("each console gets its own game, and unknown ones a plain confirm", () => {
  const titles = [0, 1, 2, 3, 4].map((id) => startMiniGame(id, `task ${id}`, 0, half).html(0));
  assert.equal(new Set(titles).size, 5, "two consoles share a game");
  const other = startMiniGame(99, "new console", 0, half);
  assert.equal(other.act(click("confirm"), 0), true);
});

test("Align: locking only works once the slider is on the marker", () => {
  const game = startMiniGame(0, "align", 0, half); // marker at 15 + floor(0.5 × 71) = 50
  assert.equal(game.act(click("lock"), 0), false, "locked while off the marker");
  game.input!(52);
  assert.equal(game.act(click("lock"), 0), true, "didn't lock when within tolerance");
});

test("Fuel: done after enough pumps", () => {
  const game = startMiniGame(1, "fuel", 0, half);
  for (let i = 1; i < PUMPS_NEEDED; i++) assert.equal(game.act(click("pump"), 0), false, `done after ${i} pumps`);
  assert.equal(game.act(click("pump"), 0), true);
});

test("Calibrate: the needle turns, and stopping it in the zone counts", () => {
  assert.equal(needleAngle(1000, 1000), 0);
  assert.equal(needleAngle(0, 90 / DIAL_DEG_PER_MS), 90);
  assert.ok(inZone(10, 340, 50), "the zone should wrap past the top");
  assert.ok(!inZone(100, 340, 50));

  const game = startMiniGame(2, "calibrate", 0, zero); // every zone starts at 0°
  assert.equal(game.act(click("stop"), 180 / DIAL_DEG_PER_MS), false, "counted a miss at 180°");
  for (let i = 1; i <= HITS_NEEDED; i++) {
    const at = 360 / DIAL_DEG_PER_MS + 20 / DIAL_DEG_PER_MS; // 20° into the zone
    assert.equal(game.act(click("stop"), at), i === HITS_NEEDED, `hit ${i}`);
  }
});

test("Shields: done once every red cell is primed", () => {
  const game = startMiniGame(3, "shields", 0, half);
  assert.equal(game.act(click("nothing"), 0), false, "done before priming anything");
  let done = false;
  for (let i = 0; i < 8; i++) done = game.act(click("cell", { i: String(i) }), 0);
  assert.equal(done, true);
});

test("Chart Course: waypoints in order; a wrong one starts it over", () => {
  const game = startMiniGame(4, "course", 0, half);
  assert.equal(game.act(click("point", { n: "2" }), 0), false);
  assert.equal(game.act(click("point", { n: "1" }), 0), false);
  assert.equal(game.act(click("point", { n: "3" }), 0), false, "skipped a waypoint");
  let done = false;
  for (let n = 1; n <= WAYPOINTS; n++) done = game.act(click("point", { n: String(n) }), 0);
  assert.equal(done, true);
});
