import {names, prepareMovement, checkMovement, checkChat, callEmergencyMeeting, completeEngineTask} from './gameplay-checks.mjs';
/** Use the stock page and installed HWC on a single disposable native network. */
import assert from 'node:assert/strict';

const ids = ['CHROMIUM_HOST', 'CHROMIUM_GUEST_A', 'CHROMIUM_GUEST_B', 'FIREFOX_GUEST'];
const page = '/browser-demo.html';
const actionCode = /^uhCkk[A-Za-z0-9_-]{48}$/;
const raw = value => Array.from(Buffer.from(value.slice(1), 'base64url'));
const hash = value => 'u' + Buffer.from(Object.values(value)).toString('base64url');
const actionHash = record => hash(record.signed_action.hashed.hash);

function game(browser, fn, payload = null) {
  return browser.evaluate(async ({fn, payload}) => {
    if (Array.isArray(payload)) payload = Uint8Array.from(payload);
    for (const field of ['expected_lobby', 'expected_role_commit', 'expected_recipient', 'previous_lobby']) {
      if (payload?.[field]) payload[field] = Uint8Array.from(payload[field]);
    }
    try {
      const result = await window.holochain.callZome({zome_name: 'game', fn_name: fn, payload});
      return {result: JSON.parse(JSON.stringify(result ?? null, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value) : typeof value === 'bigint' ? value.toString() : value))};
    } catch (error) {
      return {error: String(error?.message ?? error)};
    }
  }, {fn, payload});
}

async function native(browser, fn, payload) {
  const {result, error} = await game(browser, fn, payload);
  if (error) throw Error(error);
  return result;
}

async function denied(browser, fn, payload, reason) {
  const {error} = await game(browser, fn, payload);
  assert.match(error, reason);
}

const text = (browser, id) => browser.evaluate(id => document.getElementById(id)?.textContent, id);
const ready = browser => browser.evaluate(() => document.getElementById('connection-state')?.dataset.status === 'ready');
const state = (browser, lobby) => native(browser, 'get_browser_game_state', raw(lobby));

function click(browser, id, kind = null) {
  return browser.evaluate(({id, kind}) => {
    const button = document.getElementById(id);
    if (!button || button.disabled || button.hidden) return false;
    if (kind) {
      delete window.repeatableAction;
      const receive = event => {
        if (event.detail.kind !== kind) return;
        window.removeEventListener('imposter:action', receive);
        const {record} = event.detail;
        window.repeatableAction = Object.values(kind === 'start'
          ? record.role_commit : record.signed_action.hashed.hash);
      };
      window.addEventListener('imposter:action', receive);
    }
    button.click();
    return true;
  }, {id, kind});
}

function typeCode(browser, value) {
  return browser.evaluate(value => {
    const input = document.getElementById('room-code');
    input.value = value;
    input.dispatchEvent(new Event('input', {bubbles: true}));
  }, value);
}

function exactView(browser, lobby, commit) {
  return native(browser, 'get_authoritative_game_view', {
    expected_lobby: raw(lobby), expected_role_commit: raw(commit),
  });
}

function matchesRoster(snapshot, agents) {
  return snapshot.players.length === agents.length
    && agents.every(agent => snapshot.players.some(player => hash(player.key) === agent));
}

export async function acceptRepeatableBrowserLobbies({agents, browsers, dna, step, until, restart, reconnect}) {
  const [host, guestA, guestB, firefox] = browsers;
  await step('FOUR_REAL_INSTALLED_PROFILES_READY', async () => {
    await Promise.all(browsers.map(browser => browser.navigate(page)));
    await Promise.all(browsers.map(browser => until(() => ready(browser), 45000)));
  });

  await Promise.all(browsers.map((browser, i) => prepareMovement(browser, names[[0,1,1,2][i]])));

  async function uiAction(browser, button, kind) {
    await until(() => click(browser, button, kind));
    const value = hash(await until(() => browser.evaluate(() => window.repeatableAction ?? null)));
    assert.match(value, actionCode);
    return value;
  }

  async function waitRoster(browser, lobby, indexes) {
    return until(async () => {
      const snapshot = await state(browser, lobby);
      return snapshot.phase === 'lobby' && snapshot.player_count === 3 &&
        matchesRoster(snapshot, indexes.map(i => agents[i])) && snapshot;
    });
  }

  async function join(index, lobby, code, roster) {
    const browser = browsers[index];
    // Wait for the exact Lobby action to propagate before clicking once.
    await waitRoster(browser, lobby, roster.slice(0, -1));
    await typeCode(browser, code);
    const joinAction = await uiAction(browser, 'join-lobby', 'join');
    await waitRoster(browser, lobby, roster);
    await until(async () => await text(browser, 'active-code') === code);
    return joinAction;
  }

  async function play(prefix, lobby, memberIndexes, duringPlay) {
    await step(prefix + '_LOBBY_CHAT', () => checkChat(memberIndexes.map(i => browsers[i]), until, prefix));
    const commit = await step(prefix + '_START_ROUND_BUTTON_AND_NATIVE_COMMIT', async () => {
      const action = await uiAction(browsers[0], 'start-round', 'start');
      assert.notEqual(action, lobby);
      return action;
    });
    const verifyNative = async () => Promise.all(memberIndexes.map(index => until(async () => {
      const browser = browsers[index];
      const snapshot = await state(browser, lobby);
      if (snapshot.phase !== 'playing' || snapshot.my_seat == null || snapshot.result ||
          snapshot.role_reveals.length || snapshot.players.some(player => player.role != null)) return null;
      const view = await exactView(browser, lobby, commit);
      if (view.phase !== 'playing' || hash(view.dna) !== dna || hash(view.host) !== agents[0] ||
          hash(view.lobby_action) !== lobby || hash(view.role_commit_action) !== commit ||
          JSON.stringify(view.seats.map(seat => hash(seat.agent)).sort()) !==
            JSON.stringify(memberIndexes.map(i => agents[i]).sort()) ||
          hash(view.seats[snapshot.my_seat].agent) !== agents[index]) return null;
      return {root: Buffer.from(Object.values(view.merkle_root)).toString('hex'), seat: snapshot.my_seat};
    })));
    const root = await step(prefix + '_THREE_MATCHING_NATIVE_VIEWS', async () => {
      const views = await verifyNative();
      assert.equal(new Set(views.map(view => view.seat)).size, 3);
      assert.equal(new Set(views.map(view => view.root)).size, 1);
      assert.match(views[0].root, /^[0-9a-f]{64}$/);
      return views[0].root;
    });
    const ownRole = index => until(async () => {
      const role = await native(browsers[index], 'get_browser_lobby_role', raw(lobby));
      return role === 0 || role === 1 ? {role} : null;
    }, 180000);
    const roles = await step(prefix + '_NATIVE_HOST_OPENING_AND_TWO_HPKE_RECEIPTS', async () => {
      const values = await Promise.all(memberIndexes.map(ownRole));
      assert.equal(values.filter(value => value.role === 0).length, 2);
      await verifyNative();
      await Promise.all(memberIndexes.map(index => until(async () =>
        (await text(browsers[index], 'my-role')).startsWith('Your verified role:'))));
      return values;
    });
    if (duringPlay) await duringPlay({commit, root, ownRole, roles, verifyNative});
    const final = await step(prefix + '_ALIGN_ENGINE_AND_NATIVE_CREW_WIN', async () => {
      const players = memberIndexes.map(i => browsers[i]);
      await Promise.all(players.map((browser, i) => prepareMovement(browser, names[i])));
      await checkMovement(players, until);
      const crew = roles.map((value,i) => value.role === 0 ? i : -1).filter(i => i >= 0);
      const caller = roles.findIndex(value => value.role === 1);
      await completeEngineTask(players[crew[0]], names[crew[0]], until);
      await Promise.all(players.map(b => until(async () => (await state(b, lobby)).tasks_done === 1)));
      const eject = prefix === 'GAME_2';
      const target = eject ? (await state(players[caller], lobby)).my_seat : null;
      await callEmergencyMeeting(players[caller], names[caller], until);
      await checkChat(players, until, prefix + ' meeting');
      await Promise.all(players.map(b => until(() => click(b, eject ? 'vote-seat-' + target : 'vote-skip'), 45000)));
      await Promise.all(players.map(b => until(async () => {
        const m = (await state(b, lobby)).active_meeting;
        return m?.committed.length === 3 && m.revealed.length === 3 &&
          m.votes.length === 3 && m.votes.every(v => v.choice === target) &&
          (eject ? m.resolved?.kind === 'ejected' && m.resolved.seat === target : m.resolved?.kind === 'no_ejection');
      }, 60000)));
      if (!eject) {
        await Promise.all(players.map(b => until(() => click(b, 'meeting-back'))));
        await completeEngineTask(players[crew[1]], names[crew[1]], until);
      }
      const completed = eject ? 1 : 2;
      return Promise.all(memberIndexes.map(index => until(async () => {
        const browser = browsers[index];
        if (await text(browser, 'round-state') !== 'Phase: Ended · Crew wins' ||
            await text(browser, 'task-progress') !== `Task completions: ${completed}/2`) return null;
        const snapshot = await state(browser, lobby);
        const view = await exactView(browser, lobby, commit);
        if (snapshot.phase !== 'ended' || snapshot.result?.outcome !== 'crew_win' ||
            snapshot.result.tasks_done !== completed || view.phase !== 'ended') return null;
        assert.equal(snapshot.my_role, roles[memberIndexes.indexOf(index)].role);
        assert.equal(view.seats.length, 3);
        return {result: snapshot.result, roster: view.seats.map(seat => hash(seat.agent))};
      })));
    });
    return {commit, root, final};
  }

  const first = await step('GAME_1_CREATED_BY_CHROMIUM_HOST', async () => {
    const lobby = await uiAction(host, 'create-lobby', 'create');
    const initial = await waitRoster(host, lobby, [0]);
    await until(async () => await text(host, 'active-code') === initial.code);
    return {lobby, code: initial.code};
  });
  await step('UNAUTHORIZED_HOST_OPERATIONS_AND_INVALID_CODE_REJECTED', async () => {
    await denied(guestA, 'create_browser_lobby', {display_name: 'Guest'}, /only the DNA-bound host/i);
    await denied(guestA, 'new_browser_game', {previous_lobby: raw(first.lobby), display_name: 'Guest'}, /only the DNA-bound host/i);
    await denied(guestA, 'start_browser_round', raw(first.lobby), /only the DNA-bound host/i);
    await denied(host, 'new_browser_game', {previous_lobby: raw(first.lobby), display_name: 'Host'}, /completed native game/i);
    await denied(firefox, 'join_browser_lobby', {code: 'b1.invalid', display_name: 'Guest'}, /invalid browser lobby code/i);
    await denied(firefox, 'join_browser_lobby', {code: 'b1.' + 'a'.repeat(32), display_name: 'Guest'}, /not found/i);
  });
  await step('GAME_1_MIXED_GUESTS_DUPLICATE_AND_FOURTH_SEAT', async () => {
    const original = await join(2, first.lobby, first.code, [0, 2]);
    const duplicate = await native(guestB, 'join_browser_lobby', {code: first.code, display_name: 'Duplicate'});
    assert.equal(actionHash(duplicate), original);
    await join(3, first.lobby, first.code, [0, 2, 3]);
    await waitRoster(guestA, first.lobby, [0, 2, 3]);
    await denied(guestA, 'join_browser_lobby', {code: first.code, display_name: 'Guest'}, /game full/i);
  });
  const old = await play('GAME_1', first.lobby, [0, 2, 3]);

  await step('COMPLETED_LOBBY_REJECTS_NEW_MEMBERS_AND_TASKS', async () => {
    await until(async () => (await state(firefox, first.lobby)).phase === 'ended');
    await denied(firefox, 'join_browser_lobby', {code: first.code, display_name: 'Guest'}, /completed/i);
    await denied(guestA, 'complete_browser_task', raw(first.lobby), /completed/i);
  });
  const second = await step('NEW_GAME_BUTTON_CREATES_FRESH_HOST_ONLY_LOBBY', async () => {
    const lobby = await uiAction(host, 'new-game', 'new');
    const snapshot = await waitRoster(host, lobby, [0]);
    assert.notEqual(lobby, first.lobby);
    assert.notEqual(snapshot.code, first.code);
    assert.equal(snapshot.roles_dealt, false);
    assert.equal(snapshot.result, null);
    assert.equal(snapshot.tasks_done, 0);
    assert.equal(snapshot.tasks.length, 0);
    assert.equal(snapshot.role_reveals.length, 0);
    const nativeLobby = await native(host, 'get_authoritative_game_view', {expected_lobby: raw(lobby)});
    assert.equal(nativeLobby.role_commit_action, null);
    assert.equal(await native(host, 'get_browser_lobby_role', raw(first.lobby)), null);
    await until(async () => await text(host, 'active-code') === snapshot.code);
    return {lobby, code: snapshot.code};
  });
  await step('GAME_2_CHROMIUM_AND_FIREFOX_JOIN_WITH_DISTINCT_IDENTITIES', async () => {
    await join(1, second.lobby, second.code, [0, 1]);
    await join(3, second.lobby, second.code, [0, 1, 3]);
    await denied(host, 'start_browser_round', raw(first.lobby), /stale lobby/i);
  });

  await step('GAME_2_RELOAD_RETRY_AND_JOINED_HISTORY_SELECTION', async () => {
    await firefox.navigate(page);
    await until(async () => await text(firefox, 'active-code') === second.code);
    await until(() => click(firefox, 'retry-connection'));
    await until(async () => await text(firefox, 'active-code') === second.code);
    for (const code of [first.code, second.code]) {
      await typeCode(firefox, code);
      await uiAction(firefox, 'reopen-lobby', 'reopen');
      await until(async () => await text(firefox, 'active-code') === code);
    }
  });

  const current = await play('GAME_2', second.lobby, [0, 1, 3], async ({commit, root, ownRole, roles, verifyNative}) => {
    await step('CROSS_LOBBY_COMMIT_AND_STALE_ROLE_READ_REJECTED', async () => {
      assert.notEqual(commit, old.commit);
      assert.notEqual(root, old.root);
      await denied(browsers[0], 'new_browser_game', {previous_lobby: raw(first.lobby), display_name: 'Host'}, /stale lobby/i);
      await denied(browsers[0], 'get_authoritative_game_view', {
        expected_lobby: raw(second.lobby), expected_role_commit: raw(old.commit),
      }, /stale, missing, or substituted/i);
      await denied(browsers[0], 'get_authoritative_game_view', {
        expected_lobby: raw(first.lobby), expected_role_commit: raw(commit),
      }, /stale, missing, or substituted/i);
      assert.equal(await native(guestA, 'get_browser_lobby_role', raw(first.lobby)), null);
    });
    await step('CHROMIUM_HOST_RESTART_RECOVERS_SAME_GAME_AND_ROLE', async () => {
      await restart(0, ids[0]);
      await until(async () => await text(browsers[0], 'active-code') === second.code);
      assert.equal((await ownRole(0)).role, roles[0].role);
      await verifyNative();
    });
    await step('FIREFOX_REAUTHENTICATES_AND_GETS_FRESH_HPKE_RECEIPT', async () => {
      await restart(3, ids[3]);
      await reconnect(3, ids[3], async () => {
        const {result} = await game(browsers[3], 'get_browser_lobby_role', raw(second.lobby));
        assert.notEqual(result, 0);
        assert.notEqual(result, 1);
      });
      await until(async () => await text(browsers[3], 'active-code') === second.code);
      assert.equal((await ownRole(3)).role, roles[2].role);
    });
  });
  await step('BOTH_GAMES_INDEPENDENTLY_VERIFIABLE_AFTER_SECOND_WIN', async () => {
    const oldView = await exactView(browsers[0], first.lobby, old.commit);
    const newView = await exactView(browsers[0], second.lobby, current.commit);
    assert.deepEqual(oldView.seats.map(seat => hash(seat.agent)), old.final[0].roster);
    assert.deepEqual(newView.seats.map(seat => hash(seat.agent)), current.final[0].roster);
    assert(old.final[0].roster.includes(agents[2]));
    assert(!current.final[0].roster.includes(agents[2]));
    assert(current.final[0].roster.includes(agents[3]));
    assert.deepEqual((await state(browsers[0], first.lobby)).result, old.final[0].result);
    assert.deepEqual((await state(browsers[0], second.lobby)).result, current.final[0].result);
    assert.equal(await text(guestB, 'active-code'), first.code);
  });
}
