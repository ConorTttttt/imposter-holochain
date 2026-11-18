/** Exercise the stock Firefox add-on with a disposable local browser profile. */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const hwc = resolve(process.argv[2]);
const driver = 'http://127.0.0.1:4444';
const setup = new URL('../../release/browser-alpha/frontend/', import.meta.url);
const profile = await mkdtemp(join(tmpdir(), 'hwc-firefox-'));
const files = new Map([
  ['/browser-setup.html', [new URL('browser-setup.html', setup), 'text/html']],
  ['/browser-setup.js', [new URL('browser-setup.js', setup), 'text/javascript']],
  ['/ziptest.happ', [join(hwc, 'fixtures/ziptest.happ'), 'application/octet-stream']],
]);
const site = createServer(async (request, response) => {
  const file = files.get(request.url);
  if (!file) return response.writeHead(404).end();
  try {
    const [source, contentType] = file;
    response.writeHead(200, {'Content-Type': contentType}).end(await readFile(source));
  } catch {
    response.destroy();
  }
});

async function webdriver(method, path, body) {
  const response = await fetch(driver + path, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(95000),
  });
  const {value} = await response.json();
  if (!response.ok) throw new Error(value.message);
  return value;
}

let session;
const call = (method, path, body) => webdriver(method, '/session/' + session + path, body);

async function startFirefox() {
  const result = await webdriver('POST', '/session', {capabilities: {alwaysMatch: {
    browserName: 'firefox',
    'moz:firefoxOptions': {
      binary: process.env.FIREFOX_BIN,
      args: ['-headless', '-profile', profile],
      prefs: {
        // Mozilla's restart-testing settings for unsigned temporary add-ons.
        'extensions.webextensions.keepStorageOnUninstall': true,
        'extensions.webextensions.keepUuidOnUninstall': true,
      },
    },
  }}});
  session = result.sessionId;
  const addonId = await call('POST', '/moz/addon/install', {
    path: join(hwc, 'packages/extension/dist-firefox'), temporary: true,
  });
  assert.equal(addonId, 'holochain@holo.host');
  await call('POST', '/url', {url: `http://127.0.0.1:${site.address().port}/browser-setup.html`});
  await call('POST', '/timeouts', {script: 75000});
}

async function stopFirefox() {
  if (!session) return;
  await webdriver('DELETE', '/session/' + session);
  session = undefined;
}

async function browserCheck(operation) {
  const result = await call('POST', '/execute/async', {args: [], script: `
    const done = arguments[0];
    (${operation.toString()})().then(value => done({value}), error => done({error: error.message}));
  `});
  if (result.error) throw new Error(result.error);
  return result.value;
}

async function connectHwc() {
  const delay = () => new Promise(resolve => setTimeout(resolve, 150));
  for (let step = 0; step < 40 && !window.holochain?.isWebConductor; step++) await delay();
  if (!window.holochain?.isWebConductor) throw Error('HWC was not injected');
  document.getElementById('connect').click();
  const key = document.getElementById('public-key');
  for (let step = 0; step < 150 && !key.value; step++) await delay();
  if (!/^uhCAk[A-Za-z0-9_-]{48}$/.test(key.value))
    throw Error(document.getElementById('status').textContent);
  return key.value;
}

async function readFixture() {
  const things = await window.holochain.callZome({
    zome: 'ziptest', function: 'get_things', payload: null,
  });
  return Array.isArray(things) && things.length === 0;
}

try {
  await new Promise((ready, reject) => {
    site.once('error', reject);
    site.listen(0, '127.0.0.1', ready);
  });
  await startFirefox();
  console.log('FIREFOX_DESKTOP_ADDON_LOADED=PASS');
  const initialIdentity = await browserCheck(connectHwc);
  console.log('FIREFOX_LAIR_IDENTITY=PASS');
  const app = await browserCheck(async () => {
    const bundle = new Uint8Array(await (await fetch('/ziptest.happ')).arrayBuffer());
    const result = await window.holochain.installApp({bundle, installedAppId: 'firefox-hwc-test'});
    return {status: result.status, cells: result.cells.length};
  });
  assert.deepEqual(app, {status: 'enabled', cells: 1});
  console.log('FIREFOX_LOCAL_HAPP_FIXTURE_INSTALL=PASS');
  assert.equal(await browserCheck(async () => window.holochain.callZome({
    zome: 'game', function: 'host_role_opening', payload: null,
  }).then(() => null, error => error.message)), 'PRIVILEGED_ROLE_OPERATION_DENIED');
  console.log('FIREFOX_WEBPAGE_PRIVILEGED_ROLE_CALL_DENIED=PASS');
  assert.equal(await browserCheck(readFixture), true, 'Local fixture read returned an unexpected result');
  console.log('FIREFOX_LOCAL_HAPP_FIXTURE_ZOME_CALL=PASS');
  await stopFirefox();
  await startFirefox();
  const recoveredIdentity = await browserCheck(connectHwc);
  assert(recoveredIdentity === initialIdentity, 'Firefox did not retain its Lair identity');
  assert.equal(await browserCheck(readFixture), true, 'Installed fixture hApp was unavailable after restart');
  console.log('FIREFOX_LOCAL_PROFILE_AND_HAPP_RESTART=PASS');
} finally {
  try {
    await stopFirefox();
  } finally {
    await new Promise(resolve => site.close(resolve));
    await rm(profile, {recursive: true, force: true});
  }
}
