/** Exercise stock, installed HWC through the operator UI and its restricted own-role read. */
import {readFileSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {launchChromium, launchFirefox} from './mixed-browser-drivers.mjs';

const appId = 'imposter-browser-poc';
const publicKey = /^uhCAk[A-Za-z0-9_-]{48}$/;
const actionHash = /^uhCkk[A-Za-z0-9_-]{48}$/;
const report = {suite: 'mixed-desktop', status: 'INCOMPLETE', stages: {}};
let reportPath;
let stage = 'CONFIGURATION';
const browsers = [];

function requireCheck(valid, code = stage) {
  if (!valid) throw new AcceptanceFailure(code);
}

class AcceptanceFailure extends Error {}

function save() {
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
}

async function step(name, check) {
  stage = name;
  const result = await check();
  report.stages[name] = 'PASS';
  save();
  console.log(name + '=PASS');
  return result;
}

async function until(check, milliseconds = 120000) {
  const stop = Date.now() + milliseconds;
  do {
    const result = await check().catch(() => null);
    if (result) return result;
    await delay(650);
  } while (Date.now() < stop);
  throw new AcceptanceFailure(stage);
}

function hash(value) {
  const bytes = value && (Array.isArray(value) ? value : Object.values(value));
  requireCheck(bytes?.length === 39 && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte < 256));
  return 'u' + Buffer.from(bytes).toString('base64url');
}

const raw = value => Array.from(Buffer.from(value.slice(1), 'base64url'));

function tap(browser, id) {
  return browser.evaluate(id => {
    const element = document.getElementById(id);
    if (!element || element.disabled || element.hidden) return false;
    element.click();
    return true;
  }, id);
}

async function setup(browser, label) {
  try {
    await browser.navigate('/browser-setup.html');
  } catch (error) {
    throw new AcceptanceFailure(error.message === 'FIREFOX_CERTIFICATE_TRUST'
      ? error.message : `${label}_SETUP_NAVIGATION`);
  }
  try {
    await until(() => browser.evaluate(() => window.holochain?.isWebConductor === true), 20000);
  } catch {
    throw new AcceptanceFailure(`${label}_HWC_INJECTION`);
  }
  try {
    await until(() => tap(browser, 'connect'), 15000);
    return await until(() => browser.evaluate(() => document.getElementById('public-key')?.value), 28000);
  } catch {
    throw new AcceptanceFailure(`${label}_PROFILE_LAIR_OR_SITE_APPROVAL`);
  }
}

function game(browser, fn, payload = null) {
  return browser.evaluate(({fn, payload}) => {
    for (const field of ['expected_lobby', 'expected_role_commit', 'expected_recipient']) {
      if (payload?.[field]) payload[field] = Uint8Array.from(payload[field]);
    }
    return window.holochain.callZome({zome_name: 'game', fn_name: fn, payload});
  }, {fn, payload});
}

function session(browser, gateway) {
  return browser.evaluate(async gateway => {
    const client = window.holochain;
    const health = await client.getConnectionStatus();
    const live = await client.getNetworkStatus();
    return health?.linkerUrl === gateway && live?.linkerUrl === gateway
      && health.authenticated === true && health.wsHealthy === true && live.hasSession === true;
  }, gateway);
}

async function installed(browser, dna, agent) {
  const info = await browser.evaluate(id => window.holochain.appInfo(id), appId).catch(() => null);
  return info?.status === 'enabled' && info.cells?.length === 1 &&
    hash(info.cells[0][0]) === dna && hash(info.cells[0][1]) === agent;
}

async function allow(config, method, agent, host = false) {
  requireCheck(config.mode === 'fixture' && /^https:\/\/localhost:\d+$/.test(config.gateway));
  const admin = readFileSync(config.fixtureSecret, 'utf8').trim();
  requireCheck(/^[0-9a-f]{64}$/.test(admin));
  const body = {agent_pubkey: agent};
  if (method === 'POST') body.capabilities = ['dht_read', 'dht_write', 'k2',
    host ? 'game_role_deliver' : 'game_role_request'];
  const response = await fetch('http://127.0.0.1:8090/admin/agents', {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {Authorization: 'Bearer ' + admin, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  requireCheck(response.status === 204);
}

function action(browser, kind, id) {
  return browser.evaluate(({kind, id}) => {
    window.addEventListener('imposter:action', ({detail}) => {
      if (detail.kind === kind) {
        // The event carries a public native action. Keep only its hash.
        window.mixedBrowserAction = kind === 'start'
          ? detail.record.role_commit
          : detail.record.signed_action?.hashed?.hash;
      }
    });
    document.getElementById(id).click();
  }, {kind, id});
}

async function round(config, agents) {
  await step('GAME_PAGE_READY', async () => {
    await Promise.all(browsers.map(browser => browser.navigate('/browser-demo.html')));
    await Promise.all(browsers.map(browser => until(() => browser.evaluate(() =>
      document.getElementById('connection-state')?.dataset.status === 'ready'), 45000)));
  });
  const [host, ...guests] = browsers;
  const lobby = await step('HOST_CREATED_LOBBY', async () => {
    // A dedicated fixture or unused operator lobby is required. Never resume a played round.
    const state = await game(host, 'get_game_state');
    requireCheck(!state.code && state.players.length === 0, 'OPERATOR_LOBBY_ALREADY_EXISTS');
    await until(() => host.evaluate(() => !document.getElementById('create-lobby').disabled));
    await action(host, 'create', 'create-lobby');
    const lobby = hash(await until(() => host.evaluate(() => window.mixedBrowserAction)));
    requireCheck(actionHash.test(lobby));
    return lobby;
  });
  await step('THREE_DISTINCT_NATIVE_SEATS', async () => {
    for (const guest of guests) {
      await until(async () => (await game(guest, 'get_game_state')).code === config.seed);
      requireCheck(await tap(guest, 'join-lobby'));
      // Serialize the joins so every guest sees the same converged lobby.
      await until(async () => Number.isInteger((await game(guest, 'get_game_state')).my_seat)
        || (await game(guest, 'get_game_state')).players.some(player =>
          hash(player.key) === agents[browsers.indexOf(guest)]));
    }
    await Promise.all(browsers.map(browser => until(() => browser.evaluate(() =>
      document.getElementById('seat-count')?.textContent === '3/3'))));
  });
  const commit = await step('START_ROUND_UI', async () => {
    await until(() => host.evaluate(() => !document.getElementById('start-round').disabled));
    await action(host, 'start', 'start-round');
    const value = hash(await until(() => host.evaluate(() => window.mixedBrowserAction)));
    requireCheck(actionHash.test(value) && value !== lobby);
    return value;
  });
  const views = async () => Promise.all(browsers.map((browser, index) => until(async () => {
    const state = await game(browser, 'get_game_state');
    if (state.phase !== 'playing' || !Number.isInteger(state.my_seat)
        || state.result || state.role_reveals?.length || state.my_role != null
        || state.players.some(player => player.role != null)) return false;
    const view = await game(browser, 'get_authoritative_game_view', {
      expected_lobby: raw(lobby), expected_role_commit: raw(commit),
      expected_recipient: raw(agents[index]), expected_seat: state.my_seat,
    });
    return view.schema_version === 1 && view.phase === 'playing'
      && hash(view.dna) === config.dna && hash(view.host) === agents[0]
      && hash(view.lobby_action) === lobby && hash(view.role_commit_action) === commit
      && view.seats.length === 3 && hash(view.seats[state.my_seat].agent) === agents[index]
      && view.seats.every(seat => agents.includes(hash(seat.agent)))
      && new Set(view.seats.map(seat => hash(seat.agent))).size === 3
      && {seat:state.my_seat, root:Buffer.from(Object.values(view.merkle_root)).toString('hex')};
  })));
  await step('EXACT_NATIVE_ROLE_COMMIT', async () => {
    const rows = await views();
    requireCheck(new Set(rows.map(row => row.seat)).size === 3 &&
      new Set(rows.map(row => row.root)).size === 1 && rows[0].root.length === 64);
  });
  const own = browser => game(browser, 'get_verified_browser_role');
  const roles = await step('HOST_OPENING_AND_TWO_INDEPENDENT_ENCRYPTED_RECEIPTS', async () => {
    const values = await Promise.all(browsers.map(browser => until(async () => {
      const role = await own(browser);
      return role === 0 || role === 1 ? {isCrew: role === 0} : null;
    }, 180000)));
    // Guest reads require a receipt on the current authenticated lease, exact
    // recipient, native seat and RoleCommit. The host verifies its own native opening.
    await views();
    requireCheck(values.filter(role => role.isCrew).length === 2);
    await Promise.all(browsers.map(browser => until(() => browser.evaluate(() =>
      document.getElementById('my-role')?.textContent.startsWith('Your verified role:')))));
    return values;
  });
  if (config.mode === 'fixture') {
    const firefox = browsers[2];
    await step('FIREFOX_GATEWAY_REVOCATION_AND_FRESH_RECEIPT', async () => {
      await allow(config, 'DELETE', agents[2]);
      await until(async () => !await session(firefox, config.gateway), 40000);
      const revoked = await own(firefox).catch(() => null);
      requireCheck(revoked !== 0 && revoked !== 1);
      requireCheck(await session(host, config.gateway) && await session(guests[0], config.gateway));
      await allow(config, 'POST', agents[2]);
      await until(() => session(firefox, config.gateway), 95000);
      await until(async () => {
        const role = await own(firefox);
        return (role === 0 || role === 1) && (role === 0) === roles[2].isCrew;
      }, 180000);
      await views();
    });
  }
  await step('ALIGN_ENGINE_OUTPUT_AND_AUTHORITATIVE_CREW_WIN', async () => {
    const crew = browsers[roles.findIndex(role => role.isCrew)];
    await until(() => tap(crew, 'complete-task'));
    await Promise.all(browsers.map(browser => until(async () => {
      const rendered = await browser.evaluate(() =>
        document.getElementById('round-state')?.textContent === 'Phase: Ended · Crew wins'
        && document.getElementById('task-progress')?.textContent === 'Task completions: 1/1');
      if (!rendered) return false;
      const state = await game(browser, 'get_game_state');
      return state.phase === 'ended' && state.tasks_done === 1 && state.task_target === 1
        && state.result?.outcome === 'crew_win';
    })));
  });
}

async function main(config, command) {
  requireCheck(['fixture', 'operator'].includes(config.mode));
  if (config.mode === 'fixture')
    requireCheck(/^https:\/\/localhost:\d+$/.test(config.frontend));
  else
    requireCheck(config.frontend.startsWith('https://') && !config.fixtureSpki);
  report.mode = config.mode;
  if (command === 'bootstrap') {
    requireCheck(config.mode === 'fixture');
    const host = await launchChromium(config, config.profiles[0]);
    browsers.push(host);
    stage = 'FIXTURE_HOST_IDENTITY';
    const key = await setup(host, 'CHROMIUM_HOST');
    requireCheck(publicKey.test(key));
    writeFileSync(config.hostFile, key + '\n', {mode: 0o600, flag: 'wx'});
    return;
  }
  requireCheck(['preflight', 'round'].includes(command));
  await step('EXTENSIONS_LOADED', async () => {
    browsers.push(await launchChromium(config, config.profiles[0]));
    browsers.push(await launchChromium(config, config.profiles[1]));
    browsers.push(await launchFirefox(config, config.profiles[2]));
  });
  const agents = await step('DISTINCT_LAIR_IDENTITIES_AND_BOUND_HOST', async () => {
    const agents = await Promise.all(browsers.map((browser, index) =>
      setup(browser, ['CHROMIUM_HOST', 'CHROMIUM_GUEST', 'FIREFOX_GUEST'][index])));
    requireCheck(agents.every(agent => publicKey.test(agent)) && new Set(agents).size === 3);
    requireCheck(agents[0] === config.host, 'HOST_PROFILE_DOES_NOT_MATCH_DEPLOYMENT');
    return agents;
  });
  if (config.mode === 'fixture') {
    await step('TEMPORARY_GATEWAY_ADMISSION', async () => {
      for (const [index, agent] of agents.entries()) await allow(config, 'POST', agent, index === 0);
      await Promise.all(browsers.map(browser => until(() => tap(browser, 'provision'), 40000)));
    });
  } else {
    await step('OPERATOR_GATEWAY_ADMISSION', async () => {
      const {DatabaseSync} = await import('node:sqlite');
      const db = new DatabaseSync(config.admissionDb, {readOnly: true});
      try {
        const allowed = db.prepare('SELECT 1 FROM allowed_agents WHERE agent_pubkey = ?');
        requireCheck(agents.every(agent => allowed.get(agent)), 'GATEWAY_ADMISSION_MISSING');
      } finally {
        db.close();
      }
    });
    // Confirm the pre-staged installation before touching the gateway or lobby.
    await step('EXISTING_OPERATOR_HAPP', async () => {
      const results = await Promise.all(browsers.map((browser, i) => installed(browser, config.dna, agents[i])));
      requireCheck(results.every(Boolean), 'INSTALLED_HAPP_MISSING_OR_DIFFERENT');
    });
    await Promise.all(browsers.map(browser => until(() => tap(browser, 'provision'), 40000)));
  }
  await step('EXACT_HAPP_INSTALLED', async () => {
    await Promise.all(browsers.map((browser, index) => until(() => installed(browser, config.dna, agents[index]), 60000)));
  });
  await step('THREE_AUTHENTICATED_GATEWAY_SESSIONS', async () => {
    await Promise.all(browsers.map(browser => until(() => session(browser, config.gateway), 90000)));
  });
  if (command === 'round') await round(config, agents);
  report.status = command === 'round' ? 'ROUND_VERIFIED' : 'PREFLIGHT_VERIFIED';
  save();
}

try {
  const [command, configPath, destination] = process.argv.slice(2);
  reportPath = destination;
  await main(JSON.parse(readFileSync(configPath, 'utf8')), command);
} catch (error) {
  report.status = 'FAILED';
  report.failure = error instanceof AcceptanceFailure ? error.message : stage;
  save();
  console.error(report.failure + '=FAIL');
  process.exitCode = 1;
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
}
