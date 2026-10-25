import { test } from "node:test";
import assert from "node:assert/strict";
import { blockieCells, blockieColors, BLOCKIE_SIZE } from "./blockie.js";

test("the same key always gives the same grid and colors", () => {
  const key = "uhCAkexample-agent-key";
  assert.deepEqual(blockieCells(key), blockieCells(key));
  assert.deepEqual(blockieColors(key), blockieColors(key));
});

test("different keys (almost always) look different", () => {
  const a = blockieCells("uhCAk-alice");
  const b = blockieCells("uhCAk-bob");
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(blockieColors("uhCAk-alice"), blockieColors("uhCAk-bob"));
});

test("the grid is 8x8 and left-right symmetric, so it reads as a face", () => {
  const cells = blockieCells("uhCAk-anyone");
  assert.equal(cells.length, BLOCKIE_SIZE);
  for (const row of cells) {
    assert.equal(row.length, BLOCKIE_SIZE);
    for (let col = 0; col < BLOCKIE_SIZE / 2; col++) {
      assert.equal(row[col], row[BLOCKIE_SIZE - 1 - col], "mirrored columns should match");
    }
  }
});

test("colors and cells don't depend on which is generated first", () => {
  const key = "uhCAk-order-independent";
  const colorsFirst = (blockieColors(key), blockieCells(key));
  const cellsFirst = blockieCells(key);
  assert.deepEqual(colorsFirst, cellsFirst);
});
