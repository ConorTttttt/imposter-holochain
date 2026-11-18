/** Real Playwright Chromium load of the pinned/modified HWC extension.
 * This is a sender-isolation check, NOT a synthetic installed-cell receipt.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=process.cwd();
const require=createRequire(path.join(root,'package.json'));
const {chromium}=require('playwright');
const extension=path.resolve(root,'packages/extension/dist-chrome');
assert(fs.existsSync(path.join(extension,'manifest.json')),'built HWC Chrome manifest missing');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'hwc-agent2-boundary-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:true,
    args:[`--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`]
  });
  const worker=context.serviceWorkers()[0] ||
    await context.waitForEvent('serviceworker',{timeout:30000});
  const id=new URL(worker.url()).hostname;
  assert.match(id,/^[a-p]{32}$/);
  const page=await context.newPage();
  await page.goto(`chrome-extension://${id}/popup/index.html`,{waitUntil:'domcontentloaded'});
  const result=await page.evaluate(async()=>{
    const frame=JSON.stringify({
      type:'role_delivery_v1',envelope:{},signature:'fake'
    });
    try {
      return await chrome.runtime.sendMessage({
        target:'background',type:'PRIVATE_ROLE_FRAME',frame,
        lease:'untrusted-popup-lease-not-a-websocket'
      });
    } catch(e) {return {error:String(e)};}
  });
  assert.equal(result?.success,false,
    'popup extension page must not reach privileged role receiver');
  assert.equal(result?.error,'PRIVATE_ROLE_SENDER_REJECTED');
  console.log('GENUINE_CHROMIUM_INSTALLED_HWC_BACKGROUND=PASS');
  console.log('PRIVATE_ROLE_POPUP_SENDER_REJECTED=PASS');
  console.log('PAGE_OR_POPUP_EXPOSED_NATIVE_EXECUTOR=NO');
  console.log('GUEST_B_NATIVE_RECEIPT=NOT_YET_TESTED');
} finally {
  await context?.close();
  fs.rmSync(profile,{recursive:true,force:true});
}
