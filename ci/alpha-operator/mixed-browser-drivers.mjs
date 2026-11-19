import {createRequire} from 'node:module';
import {join} from 'node:path';

export async function launchChromium(config, profile) {
  const require = createRequire(join(config.hwc, 'package.json'));
  const {chromium} = require('playwright');
  const extension = config.chromiumExtension;
  const args = [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`];
  if (config.mode === 'fixture') {
    // Only the public key of the disposable localhost fixture certificate.
    args.push(`--ignore-certificate-errors-spki-list=${config.fixtureSpki}`);
  }
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, args,
  });
  const page = context.pages()[0] ?? await context.newPage();
  return {
    navigate: path => page.goto(config.frontend + path, {waitUntil: 'domcontentloaded'}),
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    close: () => context.close(),
  };
}

export async function launchFirefox(config, profile) {
  async function request(method, path, body) {
    const response = await fetch('http://127.0.0.1:4444' + path, {
      method,
      headers: {'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(95000),
    });
    const {value} = await response.json();
    if (!response.ok) {
      if (value?.error === 'insecure certificate') throw Error('FIREFOX_CERTIFICATE_TRUST');
      throw Error('Firefox WebDriver request failed');
    }
    return value;
  }
  const {sessionId} = await request('POST', '/session', {capabilities: {alwaysMatch: {
    browserName: 'firefox',
    'moz:firefoxOptions': {
      binary: process.env.FIREFOX_BIN,
      args: ['-headless', '-profile', profile],
      prefs: {
        'extensions.webextensions.keepStorageOnUninstall': true,
        'extensions.webextensions.keepUuidOnUninstall': true,
      },
    },
  }}});
  const call = (method, path, body) => request(method, `/session/${sessionId}${path}`, body);
  const close = () => call('DELETE', '');
  try {
    const addon = await call('POST', '/moz/addon/install', {
      path: config.firefoxExtension, temporary: true,
    });
    if (addon !== 'holochain@holo.host') throw Error('Wrong Firefox add-on identity');
    await call('POST', '/timeouts', {script: 40000});
    return {
      navigate: path => call('POST', '/url', {url: config.frontend + path}),
      async evaluate(fn, arg) {
        const result = await call('POST', '/execute/async', {args: [arg ?? null], script: `
          const done = arguments[arguments.length - 1];
          Promise.resolve().then(() => (${fn.toString()})(arguments[0]))
            .then(value => done({value}), () => done({failed: true}));
        `});
        if (result.failed) throw Error('Firefox application check failed');
        return result.value;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
