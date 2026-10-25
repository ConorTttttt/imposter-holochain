import { test } from "node:test";
import assert from "node:assert/strict";
import { currentGame, lobbySeed, newGameSeed, type GameLook } from "./rooms.js";

/** A fake room: seed → game, `null` for a closed game. A seed not listed is a
 *  clone opened fresh, with no lobby yet. */
function room(games: Record<string, GameLook | null>) {
  const looked: string[] = [];
  const look = async (seed: string) => {
    looked.push(seed);
    return seed in games ? games[seed] : { phase: "lobby", code: null };
  };
  return { look, looked };
}
const lobby = (code: string): GameLook => ({ phase: "lobby", code });
const playing = (code: string): GameLook => ({ phase: "playing", code });
const ended = (code: string): GameLook => ({ phase: "ended", code });

test("a room's games are legacy room seeds: the first keeps the bare room code", () => {
  assert.equal(lobbySeed("ROOM", 1), "room1.ROOM");
  assert.equal(lobbySeed("ROOM", 2), "room1.ROOM#2");
});

test("a host's new game seed names the host and a 128-bit random id", () => {
  const key = "uhCAkVNjcdnXfoExk87X1hKArKH43bZnAidlsSgqBqeGvFpOPiUCT";
  const seed = newGameSeed(key);
  assert.match(seed, /^g1\.uhCAk[A-Za-z0-9_-]+\.[0-9a-f]{32}$/);
  assert.equal(seed.split(".")[1], key);
});

test("a host's new game seeds don't repeat", () => {
  const seeds = new Set(Array.from({ length: 1000 }, () => newGameSeed("uhCAkhost")));
  assert.equal(seeds.size, 1000);
});

test("a fresh room starts at its first game", async () => {
  const { look } = room({});
  assert.equal((await currentGame("ROOM", 1, look)).round, 1);
});

test("finished games are skipped", async () => {
  const { look } = room({ [lobbySeed("ROOM", 1)]: ended("ROOM"), [lobbySeed("ROOM", 2)]: ended("ROOM#2"), [lobbySeed("ROOM", 3)]: playing("ROOM#3") });
  const { round, game } = await currentGame("ROOM", 1, look);
  assert.equal(round, 3);
  assert.equal(game.phase, "playing");
});

test("after the last finished game comes a fresh one", async () => {
  const { look } = room({ [lobbySeed("ROOM", 1)]: ended("ROOM") });
  const { round, game } = await currentGame("ROOM", 1, look);
  assert.equal(round, 2);
  assert.equal(game.code, null);
});

test("a game abandoned for a later one is skipped", async () => {
  // its host left mid-game, and someone opened ROOM#2
  const { look } = room({ [lobbySeed("ROOM", 1)]: playing("ROOM"), [lobbySeed("ROOM", 2)]: lobby("ROOM#2") });
  assert.equal((await currentGame("ROOM", 1, look)).round, 2);
});

test("closed games are skipped", async () => {
  const { look } = room({ [lobbySeed("ROOM", 1)]: null, [lobbySeed("ROOM", 2)]: null, [lobbySeed("ROOM", 3)]: lobby("ROOM#3") });
  assert.equal((await currentGame("ROOM", 1, look)).round, 3);
});

test("the walk starts from the last game known", async () => {
  const { look, looked } = room({ [lobbySeed("ROOM", 3)]: lobby("ROOM#3") });
  assert.equal((await currentGame("ROOM", 3, look)).round, 3);
  assert.ok(!looked.includes(lobbySeed("ROOM", 1)), "looked at an earlier game");
});
