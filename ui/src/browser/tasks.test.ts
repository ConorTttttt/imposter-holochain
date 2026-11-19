import assert from "node:assert/strict";
import { test } from "node:test";
import { TASKS } from "../game/world.js";
import { BROWSER_TASK_COUNTS, browserAssignments, browserTaskList, nearbyTask } from "./tasks.js";

test("browser plans use native console IDs and give every seat its whole pool", () => {
  for (const count of BROWSER_TASK_COUNTS) {
    const pool = browserTaskList(count * 2, 2);
    assert.deepEqual(pool.map(({ id }) => id), TASKS.slice(0, count).map(({ id }) => id));
    assert.deepEqual(browserAssignments(pool, count * 2, 2), TASKS.slice(0, count));
  }
  assert.deepEqual(browserAssignments(TASKS, 2, 2), []);
  assert.deepEqual(browserAssignments([TASKS[0]], 1, 2), [TASKS[0]]);
});

test("console interaction requires reach and line of sight and excludes completed tasks", () => {
  const task = TASKS[0];
  const point = { x: task.x - 30, y: task.y };
  assert.equal(nearbyTask(point, [task], new Set(), []), task);
  assert.equal(nearbyTask({ x: task.x - 80, y: task.y }, [task], new Set(), []), undefined);
  assert.equal(nearbyTask(point, [task], new Set([task.id]), []), undefined);
  assert.equal(nearbyTask(point, [task], new Set(), [
    { ax: task.x - 15, ay: task.y - 15, bx: task.x - 15, by: task.y + 15 },
  ]), undefined);
});
