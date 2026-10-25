import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ejectionText,
  lobbyReadiness,
  emergencyStatus,
  meetingClock,
  taskBarText,
  voteGroups,
  vitalsStatus,
  type Model,
  type StateV,
} from "./ui.js";
import { DEFAULT_SETTINGS, maxImpostors, type GameSettings } from "./settings.js";

/** Just enough of a game state for `meetingClock`: a meeting opened at t = 0. */
function meeting(settings: Partial<GameSettings>, extra: Partial<NonNullable<StateV["active_meeting"]>> = {}): StateV {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    active_meeting: { opened_at_ms: 0, candidates: null, resolved: null, ...extra },
  } as StateV;
}

test("a meeting starts with the discussion, then voting counts down", () => {
  const s = meeting({ discussion_s: 15, voting_s: 60 });
  const talking = meetingClock(s, 5_000);
  assert.equal(talking.discussing, true);
  assert.match(talking.text, /voting opens in 10s/);
  const voting = meetingClock(s, 20_000);
  assert.equal(voting.discussing, false);
  assert.equal(voting.votingEndsAt, 75_000);
  assert.match(voting.text, /Voting ends in 55s/);
  assert.match(meetingClock(s, 80_000).text, /closed/);
});

test("a tie breaker skips the discussion", () => {
  const s = meeting({ discussion_s: 30 }, { candidates: [0, 1] });
  assert.equal(meetingClock(s, 1_000).discussing, false);
});

test("no voting time means no deadline", () => {
  const clock = meetingClock(meeting({ discussion_s: 0, voting_s: 0 }), 500_000);
  assert.equal(clock.votingEndsAt, null);
  assert.equal(clock.discussing, false);
});

test("a resolved meeting has no clock", () => {
  const clock = meetingClock(meeting({}, { resolved: { kind: "no_ejection" } }), 1_000);
  assert.equal(clock.text, "");
});

test("impostors always start outnumbered", () => {
  for (const [players, most] of [[3, 1], [4, 1], [5, 2], [6, 2], [7, 3], [10, 4]]) {
    assert.equal(maxImpostors(players), most, `${players} players`);
    assert.ok(most < players - most, `${players} players: crew must outnumber impostors`);
  }
});

test("the task bar shows only what the host's setting allows", () => {
  const s = (task_bar: number) =>
    ({ settings: { ...DEFAULT_SETTINGS, task_bar }, tasks_done: 5, tasks_done_at_meeting: 2, task_target: 9 }) as StateV;
  assert.equal(taskBarText(s(0)), "Tasks 5/9");
  assert.match(taskBarText(s(1)), /^Tasks 2\/9 /);
  assert.equal(taskBarText(s(2)), "Tasks: hidden");
});

/** Four players in seats 0–3, two of them impostors. */
function game(settings: Partial<GameSettings>, extra: Partial<StateV> = {}): StateV {
  const players = ["Red", "Blue", "Green", "Pink"].map((name, seat) => ({
    key: null,
    keyB64: `k${seat}`,
    name,
    seat,
    dead: false,
    is_host: seat === 0,
    role: null,
    color: seat,
  }));
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players,
    impostor_count: 2,
    role_reveals: [],
    active_meeting: null,
    ...extra,
  } as StateV;
}

test("the ejection screen confirms the role only when the host's settings say so", () => {
  const ejected = (confirm_ejects: boolean, role: number) => {
    const s = game({ confirm_ejects }, { role_reveals: confirm_ejects ? [[1, role]] : [] });
    s.players[1].dead = true;
    return ejectionText(s, 1);
  };
  assert.deepEqual(ejected(true, 0), {
    line: "Blue was voted out of the network.",
    details: ["Blue was not an Impostor.", "2 Impostors remain."],
  });
  assert.deepEqual(ejected(true, 1), {
    line: "Blue was voted out of the network.",
    details: ["Blue was an Impostor.", "1 Impostor remains."],
  });
  assert.deepEqual(ejected(false, 1), { line: "Blue was voted out of the network.", details: [] });
  assert.deepEqual(ejectionText(game({}), null), { line: "No one was removed from the network.", details: ["(Skipped)"] });
});

test("the tally groups votes by option, most first; anonymous votes have no voters", () => {
  const votes = [
    { voter: 0, choice: 2 },
    { voter: 1, choice: null },
    { voter: 3, choice: 2 },
  ];
  const meeting = (vs: { voter: number | null; choice: number | null }[]) =>
    ({ votes: vs }) as unknown as StateV["active_meeting"];
  assert.deepEqual(voteGroups(game({}, { active_meeting: meeting(votes) })), [
    { choice: 2, voters: [0, 3] },
    { choice: null, voters: [1] },
  ]);
  const anonymous = votes.map((v) => ({ ...v, voter: null }));
  assert.deepEqual(voteGroups(game({ anonymous_votes: true }, { active_meeting: meeting(anonymous) }))[0], {
    choice: 2,
    voters: [null, null],
  });
});

test("vitals: dead as soon as a kill is recorded, disconnected once PeerKit loses a player", () => {
  const s = game({});
  s.players[2].dead = true;
  const m = { state: s, myKeyB64: "k0", peerkit: { relayUp: true, livePlayers: ["k1", "k2"] } } as unknown as Model;
  assert.deepEqual(
    s.players.map((p) => vitalsStatus(m, p)),
    ["ok", "ok", "dead", "disconnected"],
  );
  m.peerkit.relayUp = false;
  assert.equal(vitalsStatus(m, s.players[3]), "ok", "no PeerKit: nobody can tell who's gone");
});

test("no emergency meetings means no emergency button", () => {
  const m = { state: game({ emergency_meetings: 0 }, { emergencies_left: 0 }), near: { atEmergency: true } } as unknown as Model;
  assert.deepEqual(emergencyStatus(m, 0), { ready: false, label: "No emergency meetings" });
});

// Registry errors must clear readiness even if a previous probe found a lobby.
test("room lookup failures show understandable messages and block joining", async () => {
  const { ROOM_NOT_FOUND, ROOM_UNAVAILABLE, ROOM_CONFLICT } = await import("./registry.js");
  for (const error of [ROOM_NOT_FOUND, ROOM_UNAVAILABLE, ROOM_CONFLICT, "Invalid room code. Use 4–32 letters, numbers or hyphens."]) {
    const model = { probe: { code: "ROOM", round: 1, status: "looking", since: 0, state: {code:"stale"}, error } } as Model;
    const ready = lobbyReadiness(model, 1000);
    assert.equal(ready.canJoin, false);
    assert.equal(ready.canCreate, error === ROOM_NOT_FOUND);
    assert.equal(ready.detail, error);
  }
});
