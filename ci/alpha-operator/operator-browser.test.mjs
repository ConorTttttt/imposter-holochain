import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {checkOperatorAdmission, checkUnusedOperatorGame} from './mixed-browser.mjs';
import {launchFirefox} from './mixed-browser-drivers.mjs';

test('unused deployment requires a complete native view for the bound browser identity', () => {
  const me = [0x84, 0x20, 0x24, ...Array(36).fill(7)];
  const agent = 'u' + Buffer.from(me).toString('base64url');
  const state = {me, code: null, phase: 'lobby', players: [], roles_dealt: false,
    my_seat: null, player_count: 0, result: null};
  checkUnusedOperatorGame(state, agent);
  for (const altered of [{code: 'existing'}, {roles_dealt: true}, {result: {}}, {players: [{}]}]) {
    assert.throws(() => checkUnusedOperatorGame({...state, ...altered}, agent), /OPERATOR_LOBBY_ALREADY_EXISTS/);
  }
  for (const altered of [{code: undefined}, {me: []}, {my_seat: 1}, {phase: 'ended'}]) {
    assert.throws(() => checkUnusedOperatorGame({...state, ...altered}, agent), /OPERATOR_GAME_STATE_UNVERIFIED/);
  }
});

test('admission reads only existing allowlist and role capabilities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imposter-admission-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'local.sqlite');
  const agents = ['fixture-host', 'fixture-chromium', 'fixture-firefox'];
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE allowed_agents (agent_pubkey TEXT PRIMARY KEY, capabilities TEXT)');
  const insert = db.prepare('INSERT INTO allowed_agents VALUES (?, ?)');
  const base = ['dht_read', 'dht_write', 'k2'];
  insert.run(agents[0], JSON.stringify([...base, 'game_role_deliver']));
  insert.run(agents[1], JSON.stringify([...base, 'game_role_request']));
  insert.run(agents[2], JSON.stringify(base));
  db.close();
  const bytes = await readFile(path);
  await assert.rejects(checkOperatorAdmission(path, agents), /GATEWAY_ROLE_CAPABILITY_MISSING/);
  await assert.rejects(checkOperatorAdmission(path, [...agents.slice(0, 2), 'absent']), /GATEWAY_ADMISSION_MISSING/);
  assert.deepEqual(await readFile(path), bytes);
  const update = new DatabaseSync(path);
  update.prepare('UPDATE allowed_agents SET capabilities = ? WHERE agent_pubkey = ?')
    .run(JSON.stringify([...base, 'game_role_request']), agents[2]);
  update.close();
  const updated = await readFile(path);
  await checkOperatorAdmission(path, agents);
  assert.deepEqual(await readFile(path), updated);
  await assert.rejects(checkOperatorAdmission(join(root, 'absent.sqlite'), agents), /OPERATOR_ADMISSION_STATE_UNREADABLE/);
});

test('operator Firefox requires WebDriver to report the exact profile and a browser process', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'imposter-operator-profile-'));
  t.after(() => rm(profile, {recursive: true, force: true}));
  const config = {mode: 'operator', frontend: 'https://fixture.example', firefoxExtension: '/test/addon'};
  const calls = [];
  let capabilities = {'moz:profile': profile, 'moz:processID': 12345};
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    calls.push([options.method, path]);
    const value = path === '/session' ? {sessionId: 'test', capabilities}
      : path.endsWith('/install') ? 'holochain@holo.host' : null;
    return {ok: true, json: async () => ({value})};
  });
  const browser = await launchFirefox(config, profile);
  assert.equal(browser.processId, 12345);
  await browser.close();
  await browser.close();
  assert.equal(calls.filter(([method]) => method === 'DELETE').length, 1);
  capabilities = {'moz:profile': profile};
  await assert.rejects(launchFirefox(config, profile), /FIREFOX_PROFILE_OR_PROCESS_UNVERIFIED/);
  capabilities = {'moz:profile': tmpdir(), 'moz:processID': 12345};
  await assert.rejects(launchFirefox(config, profile), /FIREFOX_PROFILE_OR_PROCESS_UNVERIFIED/);
  assert.equal(calls.filter(([method]) => method === 'DELETE').length, 3);
});
