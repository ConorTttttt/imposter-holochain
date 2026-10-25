import { test } from "node:test";
import assert from "node:assert/strict";

// A tiny fake localStorage — node:test has no DOM.
class FakeStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
}
(globalThis as any).localStorage = new FakeStorage();

const { gameKey, recordGameXp, totalXp } = await import("./xp.js");

test("recording a game's Xp adds it to the running total", () => {
  assert.equal(totalXp(), 0);
  recordGameXp(gameKey("LOBBY-A", 1), 30);
  assert.equal(totalXp(), 30);
  recordGameXp(gameKey("LOBBY-A", 2), 15);
  assert.equal(totalXp(), 45);
});

test("recording the same game twice doesn't double-count it", () => {
  const key = gameKey("LOBBY-B", 1);
  recordGameXp(key, 40);
  const before = totalXp();
  recordGameXp(key, 999); // even a different (bogus) amount is ignored
  assert.equal(totalXp(), before, "a second record for the same game is a no-op");
});

test("gameKey tells rounds and rooms apart", () => {
  assert.notEqual(gameKey("A", 1), gameKey("A", 2));
  assert.notEqual(gameKey("A", 1), gameKey("B", 1));
});
