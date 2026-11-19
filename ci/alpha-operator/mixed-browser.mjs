/** Exercise stock, installed HWC through the operator UI and its restricted own-role read. */
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {launchChromium, launchFirefox} from './mixed-browser-drivers.mjs';

const appId = 'imposter-browser-poc';
const publicKey = /^uhCAk[A-Za-z0-9_-]{48}$/;
const actionHash = /^uhCkk[A-Za-z0-9_-]{48}$/;
const labels = ['CHROMIUM_HOST', 'CHROMIUM_GUEST', 'FIREFOX_GUEST'];
const gatewayCapabilities = host => ['dht_read', 'dht_write', 'k2',
  host ? 'game_role_deliver' : 'game_role_request'];
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

function hash(value, failure = stage) {
  const bytes = value && (Array.isArray(value) ? value : Object.values(value));
  requireCheck(bytes?.length === 39 && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte < 256), failure);
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

async function openSetup(browser, label) {
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
}

async function connect(browser, label) {
  try {
    await until(() => tap(browser, 'connect'), 15000);
    return await until(() => browser.evaluate(() => document.getElementById('public-key')?.value), 28000);
  } catch {
    throw new AcceptanceFailure(`${label}_PROFILE_LAIR_OR_SITE_APPROVAL`);
  }
}

async function setup(browser, label) {
  await openSetup(browser, label);
  return connect(browser, label);
}

function game(browser, fn, payload = null) {
  return browser.evaluate(async ({fn, payload}) => {
    for (const field of ['expected_lobby', 'expected_role_commit', 'expected_recipient']) {
      if (payload?.[field]) payload[field] = Uint8Array.from(payload[field]);
    }
    const result = await window.holochain.callZome({zome_name: 'game', fn_name: fn, payload});
    // CDP and WebDriver serialize typed arrays differently.
    return JSON.parse(JSON.stringify(result, (_key, value) =>
      ArrayBuffer.isView(value) ? Array.from(value) : typeof value === 'bigint' ? value.toString() : value));
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

async function inventory(browser) {
  return browser.evaluate(async id => {
    const info = await window.holochain.appInfo(id);
    return {status: info.status, cells: info.cells?.map(cell => cell.map(value =>
      Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : Object.values(value ?? {})))};
  }, appId).catch(() => null);
}

async function installed(browser, dna, agent) {
  const info = await inventory(browser);
  return info?.status === 'enabled' && info.cells?.length === 1 &&
    hash(info.cells[0][0]) === dna && hash(info.cells[0][1]) === agent;
}

async function preinstalledAgent(browser, label, dna) {
  const info = await inventory(browser);
  const failure = `${label}_INSTALLED_HAPP_MISSING_OR_DIFFERENT`;
  requireCheck(info?.status === 'enabled' && info.cells?.length === 1 &&
    hash(info.cells[0][0], failure) === dna, failure);
  const agent = hash(info.cells[0][1], failure);
  requireCheck(publicKey.test(agent), failure);
  return agent;
}

export async function checkOperatorAdmission(path, agents) {
  const {DatabaseSync} = await import('node:sqlite');
  try {
    const db = new DatabaseSync(path, {readOnly: true});
    try {
      const allowed = db.prepare('SELECT capabilities FROM allowed_agents WHERE agent_pubkey = ?');
      const rows = agents.map(agent => allowed.get(agent));
      requireCheck(rows.every(Boolean), 'GATEWAY_ADMISSION_MISSING');
      requireCheck(rows.every(({capabilities}, index) => {
        const actual = JSON.parse(capabilities);
        return Array.isArray(actual) && gatewayCapabilities(index === 0).every(cap => actual.includes(cap));
      }), 'GATEWAY_ROLE_CAPABILITY_MISSING');
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure('OPERATOR_ADMISSION_STATE_UNREADABLE');
  }
}

async function configureOperatorGateway(browser, gateway) {
  await browser.evaluate(async linkerUrl => {
    await window.holochain.configureNetwork({linkerUrl});
  }, gateway);
}

export function checkUnusedOperatorGame(state, agent) {
  const used = state && (state.code != null || state.roles_dealt === true ||
    state.result != null || (Array.isArray(state.players) && state.players.length > 0));
  requireCheck(!used, 'OPERATOR_LOBBY_ALREADY_EXISTS');
  const unverified = 'OPERATOR_GAME_STATE_UNVERIFIED';
  requireCheck(state?.phase === 'lobby' && state.code === null && state.roles_dealt === false
    && state.result === null && state.my_seat === null && state.player_count === 0
    && Array.isArray(state.players) && state.players.length === 0 && hash(state.me, unverified) === agent,
  unverified);
}

async function provisionStatus(browser) {
  return browser.evaluate(() => {
    const status = document.getElementById('status');
    if (status?.dataset.error !== 'true') return null;
    const text = status.textContent;
    // Report an allowlisted category. The raw page text is never returned.
    if (text.includes('different or disabled game')) return 'HAPP_IDENTITY_OR_DNA';
    if (text.includes('could not install')) return 'HAPP_INSTALLATION';
    if (text.includes('could not read')) return 'HAPP_INVENTORY';
    if (text.includes('checksum differs')) return 'HAPP_CHECKSUM';
    if (text.includes('could not be downloaded')) return 'HAPP_DOWNLOAD';
    if (text.includes('admission is pending')) return 'GATEWAY_ADMISSION';
    if (text.includes('gateway is unreachable')) return 'GATEWAY_UNREACHABLE';
    if (text.includes('could not connect to the gateway')) return 'GATEWAY_CONNECTION';
    if (text.includes('setup files') || text.includes('settings')) return 'SITE_CONFIGURATION';
    return 'PROVISIONING_ERROR';
  }).catch(() => null);
}

async function waitForInstalled(browsers, config, agents) {
  const results = await Promise.all(browsers.map(async (browser, index) => {
    try {
      await until(async () => {
        if (await installed(browser, config.dna, agents[index])) return true;
        const reason = await provisionStatus(browser);
        return reason && {reason};
      }, 60000).then(result => {
        if (result.reason) throw new AcceptanceFailure(result.reason);
      });
      return true;
    } catch (error) {
      const reason = error instanceof AcceptanceFailure ? error.message : 'HAPP_QUERY';
      console.log(labels[index] + '_' + reason + '=FAIL');
      return false;
    }
  }));
  requireCheck(results.every(Boolean));
}

async function allow(config, method, agent, host = false) {
  requireCheck(config.mode === 'fixture' && /^https:\/\/localhost:\d+$/.test(config.gateway));
  const admin = readFileSync(config.fixtureSecret, 'utf8').trim();
  requireCheck(/^[0-9a-f]{64}$/.test(admin));
  const body = {agent_pubkey: agent};
  if (method === 'POST') body.capabilities = gatewayCapabilities(host);
  const response = await fetch('http://127.0.0.1:8090/admin/agents', {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {Authorization: 'Bearer ' + admin, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  requireCheck(response.status === 204);
}

function action(browser, kind, id) {
  return browser.evaluate(({kind, id}) => {
    // Clear the preceding action before the new asynchronous zome call.
    delete window.mixedBrowserAction;
    const receive = ({detail}) => {
      if (detail.kind !== kind) return;
      window.removeEventListener('imposter:action', receive);
      // The event carries a public native action. Keep only its hash.
      window.mixedBrowserAction = kind === 'start'
        ? detail.record.role_commit
        : detail.record.signed_action?.hashed?.hash;
    };
    window.addEventListener('imposter:action', receive);
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
    if (config.mode === 'operator') checkUnusedOperatorGame(state, agents[0]);
    else requireCheck(!state.code && state.players.length === 0, 'OPERATOR_LOBBY_ALREADY_EXISTS');
    await until(() => host.evaluate(() => !document.getElementById('create-lobby').disabled));
    await action(host, 'create', 'create-lobby');
    const lobby = hash(await until(() => host.evaluate(() =>
      window.mixedBrowserAction && Object.values(window.mixedBrowserAction))));
    requireCheck(actionHash.test(lobby));
    return lobby;
  });
  async function lobbyContains(browser, members) {
    const state = await game(browser, 'get_game_state');
    return state.code === config.seed && state.player_count === 3 && state.phase === 'lobby'
      && state.players.length === members.length && members.every(agent =>
        state.players.some(player => hash(player.key) === agent));
  }
  for (const [index, guest] of guests.entries()) {
    const alreadyJoined = agents.slice(0, index + 1);
    const expected = agents.slice(0, index + 2);
    const label = labels[index + 1];
    await step(label + '_DISCOVERED_LOBBY', async () => {
      await until(() => lobbyContains(guest, alreadyJoined));
    });
    await step(label + '_JOINED_NATIVE_SEAT', async () => {
      requireCheck(await tap(guest, 'join-lobby'));
      await Promise.all([guest, host].map(browser => until(() => lobbyContains(browser, expected))));
    });
  }
  await step('THREE_DISTINCT_NATIVE_SEATS', async () => {
    await Promise.all(browsers.map(browser => until(async () =>
      await lobbyContains(browser, agents) && await browser.evaluate(() =>
        document.getElementById('seat-count')?.textContent === '3/3'))));
  });
  const commit = await step('START_ROUND_UI', async () => {
    await until(() => host.evaluate(() => !document.getElementById('start-round').disabled));
    await action(host, 'start', 'start-round');
    const value = hash(await until(() => host.evaluate(() =>
      window.mixedBrowserAction && Object.values(window.mixedBrowserAction))));
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
  } else {
    const previous = browsers[2];
    let firefox;
    await step('OPERATOR_FIREFOX_PROCESS_RESTART', async () => {
      await previous.close();
      await until(async () => {
        try {
          process.kill(previous.processId, 0);
          return false;
        } catch (error) {
          return error.code === 'ESRCH';
        }
      }, 15000);
      firefox = await launchFirefox(config, config.profiles[2]);
      browsers[2] = firefox;
      requireCheck(firefox.processId !== previous.processId);
    });
    await step('OPERATOR_FIREFOX_RETAINED_IDENTITY_AND_FRESH_AUTH', async () => {
      const label = labels[2];
      await openSetup(firefox, label);
      requireCheck(await preinstalledAgent(firefox, label, config.dna) === agents[2]
        && await connect(firefox, label) === agents[2], 'OPERATOR_FIREFOX_IDENTITY_CHANGED');
      await configureOperatorGateway(firefox, config.gateway);
      await until(() => session(firefox, config.gateway), 90000);
    });
    await step('OPERATOR_FIREFOX_FRESH_ENCRYPTED_RECEIPT', async () => {
      await firefox.navigate('/browser-demo.html');
      await until(() => firefox.evaluate(() => document.getElementById('connection-state')?.dataset.status === 'ready'), 45000);
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
  let preinstalled;
  if (config.mode === 'operator') {
    preinstalled = await step('EXISTING_OPERATOR_HAPP_AND_BOUND_HOST', async () => {
      const expected = await Promise.all(browsers.map(async (browser, index) => {
        await openSetup(browser, labels[index]);
        return preinstalledAgent(browser, labels[index], config.dna);
      }));
      requireCheck(expected[0] === config.host, 'HOST_PROFILE_DOES_NOT_MATCH_DEPLOYMENT');
      requireCheck(new Set(expected).size === 3, 'OPERATOR_PROFILE_IDENTITIES_NOT_DISTINCT');
      return expected;
    });
    await step('OPERATOR_GATEWAY_ADMISSION', () => checkOperatorAdmission(config.admissionDb, preinstalled));
  }
  const agents = await step('DISTINCT_LAIR_IDENTITIES_AND_BOUND_HOST', async () => {
    const agents = await Promise.all(browsers.map((browser, index) =>
      preinstalled ? connect(browser, labels[index]) : setup(browser, labels[index])));
    requireCheck(agents.every(agent => publicKey.test(agent)) && new Set(agents).size === 3);
    requireCheck(agents[0] === config.host, 'HOST_PROFILE_DOES_NOT_MATCH_DEPLOYMENT');
    if (preinstalled)
      requireCheck(agents.every((agent, index) => agent === preinstalled[index]), 'OPERATOR_LAIR_IDENTITY_CHANGED');
    return agents;
  });
  if (config.mode === 'fixture') {
    await step('TEMPORARY_GATEWAY_ADMISSION', async () => {
      for (const [index, agent] of agents.entries()) await allow(config, 'POST', agent, index === 0);
      await Promise.all(browsers.map(browser => until(() => tap(browser, 'provision'), 40000)));
    });
  } else {
    // The operator path uses the pre-installed cell and never runs installer UI.
    await step('OPERATOR_GATEWAY_CONFIGURATION', () =>
      Promise.all(browsers.map(browser => configureOperatorGateway(browser, config.gateway))));
  }
  await step('EXACT_HAPP_INSTALLED', async () => {
    await waitForInstalled(browsers, config, agents);
  });
  await step('THREE_AUTHENTICATED_GATEWAY_SESSIONS', async () => {
    await Promise.all(browsers.map(browser => until(() => session(browser, config.gateway), 90000)));
  });
  if (config.mode === 'fixture') {
    await step('THREE_ACKNOWLEDGED_DNA_REGISTRATIONS', async () => {
      const {DatabaseSync} = await import('node:sqlite');
      const db = new DatabaseSync(config.fixtureAdmissionDb, {readOnly: true});
      try {
        const registered = db.prepare('SELECT 1 FROM session_dnas WHERE dna_hash = ? AND agent_pubkey = ?');
        await until(async () => agents.every(agent => registered.get(config.dna, agent)), 30000);
      } finally {
        db.close();
      }
    });
  } else {
    await step('OPERATOR_UNUSED_HOST_BOUND_DEPLOYMENT', async () => {
      const states = await Promise.all(browsers.map(browser => game(browser, 'get_game_state')));
      states.forEach((state, index) => checkUnusedOperatorGame(state, agents[index]));
    });
  }
  if (command === 'round') await round(config, agents);
  report.status = command === 'round' ? 'ROUND_VERIFIED' : 'PREFLIGHT_VERIFIED';
  save();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    const closed = await Promise.allSettled(browsers.map(browser => browser.close()));
    if (report.mode === 'operator' && !process.exitCode && closed.some(result => result.status === 'rejected')) {
      report.status = 'FAILED';
      report.failure = 'OPERATOR_BROWSER_SHUTDOWN_UNVERIFIED';
      save();
      console.error(report.failure + '=FAIL');
      process.exitCode = 1;
    }
  }
}
