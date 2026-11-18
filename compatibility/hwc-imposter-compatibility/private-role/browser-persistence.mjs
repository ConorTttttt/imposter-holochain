/** Standalone real-Chromium keystore/replay platform acceptance, NOT HWC delivery. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const root=resolve('compatibility/hwc-imposter-compatibility/private-role');
const requireFromHwc=createRequire(resolve('hwc/package.json'));
const {chromium}=requireFromHwc('playwright');
const files=new Map([['/browser-store.html','text/html'],['/store.mjs','text/javascript'],['/hpke.mjs','text/javascript'],['/wire.mjs','text/javascript']]);
const server=http.createServer(async(req,res)=>{
 try { const p=new URL(req.url,'http://127.0.0.1').pathname;
  if(!files.has(p)){res.writeHead(404);res.end();return;}
  const body=await readFile(join(root,p.slice(1)));
  res.writeHead(200,{'content-type':files.get(p),'cache-control':'no-store'});res.end(body);
 }catch{res.writeHead(500);res.end();}
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
const port=server.address().port;
const profile=await mkdtemp(join(tmpdir(),'agent2-role-key-browser-'));
try{
  for(const phase of ['register','restart','revoked-restart']){
    // Two independent Chromium processes reuse one persisted disk profile.
    const ctx=await chromium.launchPersistentContext(profile,{headless:true,args:['--no-sandbox']});
    try{
      const page=ctx.pages()[0]??await ctx.newPage();
      await page.goto('http://127.0.0.1:'+port+'/browser-store.html?phase='+phase);
      await page.waitForFunction(()=>document.body?.textContent?.startsWith('{'),null,{timeout:30000});
      const result=JSON.parse(await page.locator('body').textContent());
      assert.equal(result.status,'PASS',phase+' browser stage failed');
      assert.equal(result.nonextractable,true);
      if(phase!=='register')assert.equal(result.actionPinsRetained,true);
      if(phase==='revoked-restart'){
        assert.equal(result.revokedFloorRetained,true);
        assert.equal(result.replayDenied,true);
        assert.equal(result.epoch,2);
      }
      if(phase==='restart'){
        assert.equal(result.replayDenied,true);
        assert.equal(result.rotationDenied,true);
        assert.equal(result.revokedKeyDenied,true);
        assert.equal(result.epoch,2);
      }
    } finally {await ctx.close();}
  }
  console.log('CHROMIUM_ROLE_KEYSTORE_TWO_PROCESS_RESTART_PASS');
  console.log('CHROMIUM_NON_EXTRACTABLE_KEY_REPLAY_ROTATION_PASS');
  console.log('CHROMIUM_PERSISTED_SIGNED_RECIPIENT_EPOCH_REVOCATION_PASS');
  console.log('CHROMIUM_PERSISTED_REVOKED_EPOCH_FLOOR_THREE_PROCESS_PASS');
  console.log('CHROMIUM_LOBBY_ROLECOMMIT_ACTION_PIN_RESTART_PASS');
} finally {await new Promise(ok=>server.close(ok));await rm(profile,{recursive:true,force:true});}
