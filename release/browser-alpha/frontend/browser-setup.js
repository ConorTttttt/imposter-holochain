const get = id => document.getElementById(id);
const appId = 'imposter-browser-poc';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let client;
let publicKey;

function status(message, error = false) {
  get('status').dataset.error = String(error);
  get('status').textContent = message;
}

function holoHash(value) {
  const bytes = value instanceof Uint8Array || Array.isArray(value)
    ? Array.from(value) : Object.values(value ?? {});
  if (bytes.length !== 39 || !bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255))
    throw Error('HWC returned an incomplete identity.');
  return 'u' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchJSON(path) {
  try {
    const response = await fetch(path, {cache:'no-store', redirect:'error'});
    if (response.status === 404) return null;
    if (response.ok) return await response.json();
  } catch {
    // Network and JSON failures use the same actionable setup message.
  }
  throw Error('The operator’s setup files could not be loaded. Refresh after the operator checks the release.');
}

async function connect() {
  get('provision').hidden = true;
  if (!window.isSecureContext) throw Error('Open the operator’s HTTPS site.');
  for (let attempt = 0; attempt < 30 && !window.holochain?.isWebConductor; attempt++)
    await delay(150);
  if (!window.holochain?.isWebConductor)
    throw Error('HWC is unavailable in this profile. Load the operator’s Chromium extension and reload.');
  const hc = window.holochain;
  try {
    await hc.connect();
    publicKey = holoHash(hc.myPubKey);
  } catch {
    throw Error('Open the HWC extension and approve this site, then try again.');
  }
  client = hc;
  get('public-key').value = publicKey;
  get('identity').hidden = false;
  const [settings, release] = await Promise.all([fetchJSON('/browser-config.json'), fetchJSON('/deployment.json')]);
  get('provision').hidden = !(settings && release);
  get('connect').textContent = 'Refresh connection';
  status(settings && release ? 'Your profile is ready for provisioning.'
    : 'Your public identity is ready. The operator has yet to publish this host-bound game.');
}

async function provision() {
  if (!client || !publicKey) throw Error('Connect HWC first.');
  const [settings, release] = await Promise.all([fetchJSON('/browser-config.json'), fetchJSON('/deployment.json')]);
  if (!settings || !release || settings.frontend_origin !== location.origin || release.app_id !== appId ||
      !/^uhC0k[A-Za-z0-9_-]{48}$/.test(release.dna_hash) ||
      !/^[0-9a-f]{64}$/.test(release.happ_bundle_sha256))
    throw Error('The operator’s release settings are missing or do not match this site.');
  let gateway;
  try {
    gateway = new URL(settings.gateway_origin);
  } catch {
    throw Error('The operator must configure a secure HTTPS gateway.');
  }
  if (gateway.protocol !== 'https:' || gateway.origin !== settings.gateway_origin)
    throw Error('The operator must configure a secure HTTPS gateway.');
  let info;
  try {
    info = await client.appInfo(appId);
  } catch (error) {
    if (!String(error.message).includes('No hApp installed for '))
      throw Error('HWC could not read the installed game. Check whether the game is disabled.');
  }
  if (!info) {
    status('Verifying the host-bound hApp…');
    const response = await fetch('/imposter-browser-poc.happ', {cache:'no-store', redirect:'error'});
    if (!response.ok) throw Error('The host-bound hApp could not be downloaded.');
    const bundle = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bundle);
    const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (checksum !== release.happ_bundle_sha256) throw Error('The downloaded hApp checksum differs from the release.');
    try {
      await client.installApp({bundle, installedAppId:appId});
      info = await client.appInfo(appId);
    } catch {
      throw Error('HWC could not install the verified hApp. Open the extension and check this site’s access.');
    }
  }
  if (info.status !== 'enabled' || info.cells?.length !== 1 ||
      holoHash(info.cells[0][0]) !== release.dna_hash || holoHash(info.cells[0][1]) !== publicKey)
    throw Error('This profile already has a different or disabled game. Ask the operator which profile to use.');
  status('Waiting for secure gateway admission…');
  let reachable = false;
  try {
    await client.configureNetwork({linkerUrl:gateway.origin});
    for (let attempt = 0; attempt < 40; attempt++) {
      const connection = await client.getConnectionStatus();
      const network = await client.getNetworkStatus();
      const expectedGateway = connection.linkerUrl === gateway.origin && network.linkerUrl === gateway.origin;
      reachable ||= expectedGateway && (connection.httpHealthy || connection.wsHealthy);
      if (expectedGateway && connection.authenticated && connection.wsHealthy && network.hasSession) {
        get('lobby').hidden = false;
        get('provision').textContent = 'Reconnect';
        status('Expected game DNA verified. Secure gateway session ready.');
        return;
      }
      await delay(350);
    }
  } catch {
    throw Error('HWC could not connect to the gateway. Check the operator’s HTTPS address and reconnect.');
  }
  if (!reachable) throw Error('The gateway is unreachable. Ask the operator to check HTTPS/WSS and reconnect.');
  throw Error('Gateway admission is pending. Ask the operator to admit your public key, then reconnect.');
}

function attach(id, action) {
  const button = get(id);
  button.addEventListener('click', async () => {
    get('connect').disabled = get('provision').disabled = true;
    get('lobby').hidden = true;
    try {
      await action();
    } catch (error) {
      status(error.message, true);
    } finally {
      get('connect').disabled = get('provision').disabled = false;
    }
  });
}
attach('connect', connect);
attach('provision', provision);
get('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(publicKey);
    status('Public player key copied.');
  } catch {
    get('public-key').select();
    status('Select and copy the public player key.');
  }
});
