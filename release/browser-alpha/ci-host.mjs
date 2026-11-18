/** Produce only the public key of an ephemeral real HWC profile. */
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';

const hwc = resolve(process.argv[2]);
const {chromium} = createRequire(join(hwc, 'packages/e2e/package.json'))('@playwright/test');
const extension = join(hwc, 'packages/extension/dist-chrome');
const profile = await mkdtemp(join(tmpdir(), 'alpha-verification-'));
const server = createServer((_, response) => {
  response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  response.end('<!doctype html><title>Ephemeral HWC build verification</title>');
});
let context;
try {
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  context = await chromium.launchPersistentContext(profile, {
    headless:true, channel:'chromium',
    args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`http://localhost:${server.address().port}`);
  await page.waitForFunction(() => window.holochain?.isWebConductor, null, {timeout:15000});
  const publicBytes = await page.evaluate(async () => {
    await window.holochain.connect();
    return Array.from(new Uint8Array(window.holochain.myPubKey));
  });
  const host = 'u' + Buffer.from(publicBytes).toString('base64url');
  if (!/^uhCAk[A-Za-z0-9_-]{48}$/.test(host)) throw Error('Real Lair public key unavailable');
  console.log(host);
} finally {
  await context?.close();
  server.close();
  await rm(profile, {recursive:true, force:true});
}
