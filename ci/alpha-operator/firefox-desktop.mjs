/** Exercise the stock Firefox add-on with a disposable local browser profile. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join, resolve} from 'node:path';

const hwc = resolve(process.argv[2]);
const driver = 'http://127.0.0.1:4444';
const setup = new URL('../../release/browser-alpha/frontend/', import.meta.url);
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
try {
  await new Promise((ready, reject) => {
    site.once('error', reject);
    site.listen(0, '127.0.0.1', ready);
  });
  const result = await webdriver('POST', '/session', {capabilities: {alwaysMatch: {
    browserName: 'firefox',
    'moz:firefoxOptions': {binary: process.env.FIREFOX_BIN, args: ['-headless']},
  }}});
  session = result.sessionId;
  const call = (method, path, body) => webdriver(method, '/session/' + session + path, body);
  const addonId = await call('POST', '/moz/addon/install', {
    path: join(hwc, 'packages/extension/dist-firefox'), temporary: true,
  });
  assert.equal(addonId, 'holochain@holo.host');
  console.log('FIREFOX_DESKTOP_ADDON_LOADED=PASS');
  await call('POST', '/url', {url: `http://127.0.0.1:${site.address().port}/browser-setup.html`});
  await call('POST', '/timeouts', {script: 75000});
  const evidence = await call('POST', '/execute/async', {args: [], script: `
    const done = arguments[0];
    (async () => {
      const delay = () => new Promise(resolve => setTimeout(resolve, 150));
      for (let step = 0; step < 40 && !window.holochain?.isWebConductor; step++) await delay();
      if (!window.holochain?.isWebConductor) throw Error('HWC was not injected');
      document.getElementById('connect').click();
      const key = document.getElementById('public-key');
      for (let step = 0; step < 150 && !key.value; step++) await delay();
      if (!/^uhCAk[A-Za-z0-9_-]{48}$/.test(key.value))
        throw Error(document.getElementById('status').textContent);
      const bundle = new Uint8Array(await (await fetch('/ziptest.happ')).arrayBuffer());
      const app = await window.holochain.installApp({bundle, installedAppId: 'firefox-hwc-test'});
      const blocked = await window.holochain.callZome({
        zome: 'game', function: 'host_role_opening', payload: null,
      }).then(() => null, error => error.message);
      return {identityCreated: true, status: app.status, cells: app.cells.length, blocked};
    })().then(done, error => done({error: error.message}));
  `});
  assert.equal(evidence.error, undefined, evidence.error);
  assert.equal(evidence.identityCreated, true);
  assert.equal(evidence.status, 'enabled');
  assert.equal(evidence.cells, 1);
  assert.equal(evidence.blocked, 'PRIVILEGED_ROLE_OPERATION_DENIED');
  console.log('FIREFOX_LAIR_IDENTITY=PASS');
  console.log('FIREFOX_LOCAL_HAPP_FIXTURE_INSTALL=PASS');
  console.log('FIREFOX_WEBPAGE_PRIVILEGED_ROLE_CALL_DENIED=PASS');
} finally {
  try {
    if (session) await webdriver('DELETE', '/session/' + session);
  } finally {
    await new Promise(resolve => site.close(resolve));
  }
}
