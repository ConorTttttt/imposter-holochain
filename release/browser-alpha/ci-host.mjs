/** Produce only the public key of an ephemeral real HWC profile. */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';

const hwc = resolve(process.argv[2]);
const {chromium} = createRequire(join(hwc, 'packages/e2e/package.json'))('@playwright/test');
const extension = join(hwc, 'packages/extension/dist-chrome');
const profile = await mkdtemp(join(tmpdir(), 'alpha-verification-'));
const server = createServer(async (request, response) => {
  const file = request.url?.slice(1);
  if (file === 'browser-setup.html' || file === 'browser-setup.js') {
    response.writeHead(200, {'Content-Type':file.endsWith('.js') ? 'text/javascript' : 'text/html'});
    response.end(await readFile(new URL('./frontend/' + file, import.meta.url)));
  } else {
    response.writeHead(404).end();
  }
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
  await page.goto(`http://localhost:${server.address().port}/browser-setup.html`);
  await page.locator('#connect').click();
  await page.waitForFunction(() => /^uhCAk[A-Za-z0-9_-]{48}$/.test(document.querySelector('#public-key').value),
    null, {timeout:15000});
  const host = await page.locator('#public-key').inputValue();
  assert(await page.locator('#provision').isHidden(), 'Bootstrap site must wait for the operator hApp');
  assert(await page.locator('#lobby').isHidden(), 'Bootstrap site must wait for gateway admission');
  console.log(host);
} finally {
  await context?.close();
  server.close();
  await rm(profile, {recursive:true, force:true});
}
