import { test } from "node:test";
import assert from "node:assert/strict";
import { joystickVector } from "./joystick.js";

test("joystick rests at zero and ignores thumb jitter", () => {
  assert.deepEqual(joystickVector(0, 0, 40), { x: 0, y: 0 });
  assert.deepEqual(joystickVector(4, -4, 40), { x: 0, y: 0 });
});

test("joystick clamps travel beyond the pad", () => {
  assert.deepEqual(joystickVector(100, 0, 40), { x: 1, y: 0 });
  assert.deepEqual(joystickVector(0, -100, 40), { x: 0, y: -1 });
});

test("joystick preserves direction and provides analog strength", () => {
  const v = joystickVector(12, 16, 40);
  assert.ok(Math.abs(v.x / v.y - 0.75) < 1e-10);
  assert.ok(Math.hypot(v.x, v.y) > 0 && Math.hypot(v.x, v.y) < 1);
});

test("bad coordinates never make movement NaN", () => {
  assert.deepEqual(joystickVector(Number.NaN, 4, 40), { x: 0, y: 0 });
  assert.deepEqual(joystickVector(5, 4, 0), { x: 0, y: 0 });
});
