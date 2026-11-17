#!/usr/bin/env node
/**
 * REAL patched-HWC browser smoke, no mocks and NO private key export.
 * Run from the isolated Agent 4 CI with a headed Chromium + Xvfb and pinned Nix.
 * A CI browser profile's genuine Lair key is ephemeral: bundle NOT DEPLOYABLE.
 * Stops at FIRST meaningful failure; evidence never marks skipped gates PASS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT=process.env.GITHUB_WORKSPACE || path.resolve(import.meta.dirname,'..');
const HWC=path.resolve(ROOT,'hwc');
const chromium=createRequire(path.join(HWC,'packages/e2e/package.json'))('@playwright/test').chromium;
const ORIGIN='http://localhost:8765';
const OUT_LOG=path.join(ROOT,'runtime-evidence');
fs.mkdirSync(OUT_LOG,{recursive:true});
const PROFILE=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-hwc-ephemeral-'));
const evidence={
 schema_version:1,mode:'REAL_HWC_EPHEMERAL_BROWSER',deployment_ready:false,
 source_head:process.env.GITHUB_SHA || 'unknown',hwc_base:'0c391226e78769d44ccb4661881ed8998b15f903',
 profile:'EPHEMERAL_DELETED_ON_RUNNER_EXIT',origin:ORIGIN,checks:{},
 prohibited_gameplay:'roles/kills/sabotage/votes not exercised'
};
let context,server,artifactDir;
function record(k,result,details){
 evidence.checks[k]={result, ...(details?{details:String(details).slice(0,2500)}:{})};
 fs.writeFileSync(path.join(OUT_LOG,'runtime-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log('P0_GATE',k,result,details?String(details).slice(0,900):'');
}
function must(cond,message){if(!cond)throw Error(message);}
const hash=b=>'u'+Buffer.from(b).toString('base64url');
function run(cmd,args,label,timeoutMs){
 const file=path.join(OUT_LOG,label+'.log');
 const r=spawnSync(cmd,args,{cwd:ROOT,env:{...process.env,BROWSER_POC_IDENTITY_SOURCE:'EPHEMERAL_HWC_BROWSER_PROFILE'},encoding:'utf8',timeout:timeoutMs,maxBuffer:8*1024*1024});
 fs.writeFileSync(file,(r.stdout||'')+'\n---STDERR---\n'+(r.stderr||''));
 if(r.error||r.status!==0)throw Error(label+' failed (exit '+r.status+'): '+(r.error?.message||r.stderr||r.stdout||'').slice(-1300));
 return r.stdout||'';
}
function site(req,res){
 const pathname=new URL(req.url,ORIGIN).pathname;
 if(pathname==='/'||pathname==='/index.html'){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   res.end('<!DOCTYPE html><html><head><title>Imposter P0 real HWC smoke</title></head><body><h1>Imposter HWC P0 smoke</h1><p>No gameplay or keys are exposed here.</p></body></html>');return;
 }
 const lookup={
  '/deployment.json':artifactDir&&path.join(artifactDir,'deployment.json'),
  '/imposter-browser-poc.happ':artifactDir&&path.join(artifactDir,'app/imposter-browser-poc.happ')
 };
 const file=lookup[pathname];
 if(file&&fs.existsSync(file)){
   res.writeHead(200,{'Content-Type':pathname.endsWith('.json')?'application/json':'application/gzip','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   fs.createReadStream(file).pipe(res);return;
 }
 res.writeHead(404);res.end('Not found');
}
async function step(name,fn){
 try{const data=await fn();record(name,'PASS');return data;}
 catch(err){record(name,'FAIL',err?.stack||String(err));throw err;}
}
function safeRuntimeError(v){return String(v||'').slice(0,500).replace(/(?:[A-Za-z0-9_/-]{90,})/g,'[LONG_TOKEN_REDACTED]');}
async function main(){
 server=http.createServer(site);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8765,'127.0.0.1',resolve);});
 const ext=path.join(HWC,'packages/extension/dist-chrome');
 must(fs.existsSync(path.join(ext,'manifest.json')),'patched HWC Chrome dist missing');
 context=await chromium.launchPersistentContext(PROFILE,{
    headless:false,viewport:{width:1100,height:800},
    args:['--disable-extensions-except='+ext,'--load-extension='+ext,'--no-first-run','--disable-default-apps','--no-sandbox','--disable-dev-shm-usage']
 });
 const page=context.pages()[0]||await context.newPage();
 page.on('pageerror',err=>{fs.appendFileSync(path.join(OUT_LOG,'page-errors.log'),safeRuntimeError(err)+'\n');});
 await page.goto(ORIGIN,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
 const host=await step('HWC_AUTHENTIC_HOST_KEY',async()=>{
    const k=await page.evaluate(async()=>{
      const hc=window.holochain;
      await hc.connect(); // Origin permission auto-approved for localhost
      const b=new Uint8Array(hc.myPubKey||[]);
      if(b.length!==39)throw Error('connect() returned no 39-byte AgentPubKey');
      return 'u'+btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    });
    must(/^uhCAk[A-Za-z0-9_-]{48}$/.test(k),'Invalid HWC AgentPubKey syntax');
    const b=Buffer.from(k.slice(1),'base64url');
    must(b.length===39 && b.toString('base64url')===k.slice(1),'Non-canonical AgentPubKey');
    evidence.host_agent_pub_key=k;
    await page.reload();
    await page.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
    const k2=await page.evaluate(async()=>{
      const hc=window.holochain; await hc.connect();
      return 'u'+btoa(String.fromCharCode(...new Uint8Array(hc.myPubKey||[])))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    });
    must(k===k2,'HWC Lair host identity changed across reload');
    return k;
 });
 const m=await step('REAL_HOST_BOUND_PACKAGE',async()=>{
    const seed=run('sh',['scripts/browser-poc-seed.sh',host],'host-bound-seed',30000).trim();
    evidence.network_seed=seed;
    must(seed.startsWith('g1.'+host+'.'),'Seed not bound to actual HWC key');
    const tag=crypto.createHash('sha256').update(seed).digest('hex').slice(0,16);
    artifactDir=path.join(ROOT,'target/browser-poc',tag);
    run('nix',['-L','develop','--no-write-lock-file','--command','bash','scripts/browser-poc-build.sh',seed],'host-bundle-build',600000);
    run('nix',['-L','develop','--no-write-lock-file','--command','bash','scripts/browser-poc-verify.sh',artifactDir],'host-bundle-verify',180000);
    const metadata=JSON.parse(fs.readFileSync(path.join(artifactDir,'deployment.json'),'utf8'));
    must(metadata.host_agent_pub_key===host,'bundle host identity changed');
    must(metadata.host_identity_source==='EPHEMERAL_HWC_BROWSER_PROFILE'&&metadata.deployment_ready===false,'improper deployment status');
    evidence.dna_hash=metadata.dna_hash;
    evidence.happ_sha256=metadata.happ_bundle_sha256;
    // CI keystore is destroyed. Thus this real-host-key bundle is ephemeral, NOT deployable.
    fs.writeFileSync(path.join(artifactDir,'NOT_DEPLOYABLE-EPHEMERAL-HWC-PROFILE.txt'),
      'A real HWC Lair profile generated the host identity, but GitHub CI destroys that keystore. NOT DEPLOYABLE.\n');
    return metadata;
 });
 const info=await step('PATCHED_HWC_INSTALL_APP',async()=>{
    return await page.evaluate(async(expected)=>{
      const hc=window.holochain;
      const m=await (await fetch('/deployment.json',{cache:'no-store'})).json();
      const response=await fetch('/imposter-browser-poc.happ',{cache:'no-store'});
      if(!response.ok)throw Error('hApp fetch failed: HTTP '+response.status);
      const bytes=new Uint8Array(await response.arrayBuffer());
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(digest!==expected||digest!==m.happ_bundle_sha256)throw Error('hApp SHA mismatch');
      await hc.installApp({bundle:bytes,installedAppId:'imposter-browser-poc'});
      const info=await hc.appInfo('imposter-browser-poc');
      if(!info?.cells||info.cells.length!==1)throw Error('appInfo lacks one provisioned cell');
      const b64=b=>'u'+btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      return {agent:b64(info.agentPubKey),dna:b64(info.cells[0][0]),status:info.status,
        contextId:info.contextId,cellAgent:b64(info.cells[0][1])};
    },m.happ_bundle_sha256);
 });
 await step('HWC_INSTALLED_DNA_AND_AGENT',async()=>{
   must(info.agent===host&&info.cellAgent===host,'HWC installed cell agent changed from origin host');
   must(info.dna===m.dna_hash,'HWC installed DNA hash differs from pinned native hc hash');
   must(info.status==='enabled','Installed hApp is not enabled: '+info.status);
   evidence.hwc_cell_id=[info.dna,info.agent];
   return info;
 });
 await step('REAL_IMPOSTER_GET_GAME_STATE_INIT',async()=>{
   // This first real zome call MUST run genesis and coordinator init/cap grants.
   // HWC source-chain genesis/cap records need separate extension storage inspection.
   const v=await page.evaluate(async()=>{
     return await window.holochain.callZome({
       zome_name:'game',fn_name:'get_game_state',payload:null
     });
   });
   evidence.init_zome_result_kind=typeof v;
   // Returning a value is a WASM execution pass, NOT proof grants persisted.
   record('CAP_GRANT_RECORD_PERSISTENCE','BLOCKED','No authorized read-only source-chain grant inspector exposed by page API');
 });
 await step('HOST_LOBBY_CREATION',async()=>{
   const v=await page.evaluate(async(seed)=>{
     return await window.holochain.callZome({zome_name:'game',fn_name:'create_lobby',
      payload:{code:seed,player_count:3,impostor_count:1,task_target:1,display_name:'HWC CI Host'}});
   },m.network_seed);
   evidence.host_create_result_kind=typeof v;
   return v;
 });
 // Authorized host acceptance is the priority. Guest negative creation needs a
 // second browser profile; do not silently infer it from host acceptance.
 record('UNAUTHORIZED_GUEST_REJECTED','NOT RUN','Separate independent guest profile and integrity rejection needed');
 record('H2HC_AUTHENTICATED_CONVERGENCE','NOT RUN','Requires Agent 3 deployment + tested registration, not just cargo security CI');
 record('SEAT_RECONNECT','NOT RUN','Requires guest and host DHT state');
}
try{await main();}
catch(e){console.error('FIRST_RUNTIME_FAILURE:',safeRuntimeError(e?.stack||e));process.exitCode=1;}
finally{
 if(context)await context.close().catch(()=>{});
 if(server)await new Promise(res=>server.close(res));
 fs.rmSync(PROFILE,{recursive:true,force:true});
 if(artifactDir&&fs.existsSync(artifactDir)){
   // Do not upload a full hApp with an ephemeral deleted host identity to be
   // mistaken for an operator deployment package; evidence contains hashes.
   fs.copyFileSync(path.join(artifactDir,'deployment.json'),path.join(OUT_LOG,'ephemeral-deployment.json'));
 }
 fs.writeFileSync(path.join(OUT_LOG,'runtime-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
}
