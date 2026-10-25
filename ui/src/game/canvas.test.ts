import { test } from "node:test";
import assert from "node:assert/strict";
import { clampCamera } from "./canvas.js";

test("the camera follows the player when they're well inside the map", () => {
  assert.equal(clampCamera(850, 860, 1.7, 1700), 850);
});

test("the camera stops at the map's edge instead of showing past it", () => {
  // the camera can get no closer than half the visible span (viewSize / zoom) to either edge
  const half = 860 / 1.7 / 2;
  assert.equal(clampCamera(10, 860, 1.7, 1700), half);
  assert.equal(clampCamera(1690, 860, 1.7, 1700), 1700 - half);
});

test("a map no bigger than the view centres instead of dividing oddly", () => {
  assert.equal(clampCamera(999, 860, 1.7, 400), 200);
});
