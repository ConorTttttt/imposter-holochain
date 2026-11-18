import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const setup = readFileSync(new URL('../../release/browser-alpha/frontend/browser-setup.js', import.meta.url), 'utf8');
const gateway = 'https://gateway.example.test';
const frontend = 'https://play.example.test';
const dna = Uint8Array.from([0x84, 0x2d, 0x24, ...Array(36).fill(1)]);
const agent = Uint8Array.from([0x84, 0x20, 0x24, ...Array(36).fill(2)]);
const hash = bytes => 'u' + Buffer.from(bytes).toString('base64url');

async function page({installedDna = dna, appMissing = false, http = true, active = gateway,
  authenticated = false, bundle = Uint8Array.of(1, 2, 3)} = {}) {
  const elements = new Map();
  let installs = 0, configurations = 0;
  const get = id => {
    if (!elements.has(id)) {
      const element = {dataset:{}, hidden:true};
      element.addEventListener = (_, handler) => { element.click = handler; };
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const release = {
    app_id: 'imposter-browser-poc', dna_hash: hash(dna), happ_bundle_sha256:'0'.repeat(64),
  };
  runInNewContext(setup, {
    document:{getElementById:get},
    window:{isSecureContext:true, holochain:{
      isWebConductor:true, myPubKey:agent, connect:async () => {},
      appInfo:async () => {
        if (appMissing) throw Error('No hApp installed for ' + frontend);
        return {status:'enabled', cells:[[installedDna, agent]]};
      },
      installApp:async () => { installs++; },
      configureNetwork:async () => { configurations++; },
      getConnectionStatus:async () => ({httpHealthy:http, wsHealthy:authenticated, authenticated, linkerUrl:active}),
      getNetworkStatus:async () => ({hasSession:authenticated, linkerUrl:active}),
    }},
    location:{origin:frontend}, URL, btoa, Uint8Array, crypto,
    setTimeout: callback => queueMicrotask(callback),
    fetch:async path => ({
      ok:true, json:async () => path === '/deployment.json'
        ? release : {frontend_origin:frontend, gateway_origin:gateway},
      arrayBuffer:async () => bundle.buffer,
    }),
  });
  await get('connect').click();
  await get('provision').click();
  return {status:get('status').textContent, lobby:get('lobby').hidden, installs, configurations};
}

test('setup preserves a profile that has a different DNA', async () => {
  const result = await page({installedDna:agent});
  assert.match(result.status, /different or disabled game/);
  assert.equal(result.configurations, 0);
  assert.equal(result.installs, 0);
  assert.equal(result.lobby, true);
});

test('setup checks the downloaded checksum before hApp install', async () => {
  const result = await page({appMissing:true});
  assert.match(result.status, /downloaded hApp checksum differs/);
  assert.equal(result.installs, 0);
  assert.equal(result.lobby, true);
});

test('a reachable gateway without a signed session offers admission guidance', async () => {
  const result = await page();
  assert.match(result.status, /admission is pending/);
  assert.equal(result.lobby, true);
});

test('setup distinguishes connection failures and an unrelated authenticated endpoint', async () => {
  for (const options of [{http:false}, {authenticated:true, active:'https://other.example.test'}]) {
    const result = await page(options);
    assert.match(result.status, /gateway is unreachable/);
    assert.equal(result.lobby, true);
  }
});

test('setup opens the lobby for the matching authenticated gateway and installed DNA', async () => {
  const result = await page({authenticated:true});
  assert.match(result.status, /Secure gateway session ready/);
  assert.equal(result.lobby, false);
});
