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
import { prepareThreeProfiles } from './browser-poc-hwc-three-profiles.mjs';

const ROOT=process.env.GITHUB_WORKSPACE || path.resolve(import.meta.dirname,'..');
const HWC=path.resolve(ROOT,'hwc');
const chromium=createRequire(path.join(HWC,'packages/e2e/package.json'))('@playwright/test').chromium;
const ORIGIN='http://localhost:8765';
const OUT_LOG=path.join(ROOT,'runtime-evidence');
fs.mkdirSync(OUT_LOG,{recursive:true});
const PROFILE=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-hwc-ephemeral-'));
const ciSnapshots=[];
const evidence={
 schema_version:1,mode:'REAL_HWC_EPHEMERAL_BROWSER',deployment_ready:false,
 source_head:process.env.GITHUB_SHA || 'unknown',
 agent2_hwc_patch:'bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39',
 h2hc_secure_artifact_run:44165793922,hwc_base:'0c391226e78769d44ccb4661881ed8998b15f903',
 profile:'EPHEMERAL_DELETED_ON_RUNNER_EXIT',origin:ORIGIN,checks:{},
 prohibited_gameplay:'roles/kills/sabotage/votes not exercised'
};
let context,threeProfiles,server,artifactDir;
function record(k,result,details){
 evidence.checks[k]={result, ...(details?{details:String(details).slice(0,2500)}:{})};
 fs.writeFileSync(path.join(OUT_LOG,'runtime-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log('P0_GATE',k,result,details?String(details).slice(0,900):'');
}
function must(cond,message){if(!cond)throw Error(message);}
const hash=b=>'u'+Buffer.from(b).toString('base64url');
function run(cmd,args,label,timeoutMs){
 const file=path.join(OUT_LOG,label+'.log');
 const childEnv={...process.env,BROWSER_POC_IDENTITY_SOURCE:'EPHEMERAL_HWC_BROWSER_PROFILE'};
 // The runner alone owns the H2HC allowlist admin credential. Subprocess
 // compilers/builders must never inherit it.
 delete childEnv.H2HC_LINKER_ADMIN_SECRET;
 const r=spawnSync(cmd,args,{cwd:ROOT,env:childEnv,encoding:'utf8',timeout:timeoutMs,maxBuffer:8*1024*1024});
 fs.writeFileSync(file,(r.stdout||'')+'\n---STDERR---\n'+(r.stderr||''));
 if(r.error||r.status!==0)throw Error(label+' failed (exit '+r.status+'): '+(r.error?.message||r.stderr||r.stdout||'').slice(-1300));
 return r.stdout||'';
}
function site(req,res){
 const pathname=new URL(req.url,ORIGIN).pathname;
 if(pathname==='/__ci_source_chain'){
   const h={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type',
     'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Private-Network':'true'};
   if(req.method==='OPTIONS'){res.writeHead(204,h);res.end();return;}
   if(req.method!=='POST'){res.writeHead(405,h);res.end();return;}
   let data='';
   req.on('data',c=>{data+=c;if(data.length>100000)req.destroy();});
   req.on('end',()=>{
     try{
       const obj=JSON.parse(data);
       if(obj.marker!=='IMPOSTER_CI_PRIVATE_INSPECTOR'||!Array.isArray(obj.actions)||
         obj.actions.length>200)throw Error('invalid CI metadata');
       ciSnapshots.push(obj);
       fs.writeFileSync(path.join(OUT_LOG,'ci-source-chain-metadata.json'),
         JSON.stringify(ciSnapshots,null,2)+'\n');
       res.writeHead(204,h);res.end();
     }catch(_){res.writeHead(400,h);res.end();}
   });return;
 }
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
async function snapshotFor(agent,after=0,filter=()=>true){
 for(let i=0;i<100;i++){
   const snap=ciSnapshots.slice(after).filter(x=>x.agent===agent&&filter(x)).at(-1);
   if(snap)return snap;
   await new Promise(r=>setTimeout(r,100));
 }
 throw Error('No production worker CI source-chain metadata available for selected HWC identity');
}
function verifyChain(snap,requireNewSignatures=true){
 const a=snap.actions;
 must(snap.storage_class==='DirectSQLiteStorage'&&snap.backend==='OPFS_SAHPOOL',
      'Production HWC worker not using persistent DirectSQLiteStorage/OPFS');
 must(snap.chrome_lair_signing,'Browser worker missing Lair signing buffers');
 if(requireNewSignatures)must(snap.lair_signatures>0,'Initial authoring did not exercise real Lair signing');
 must(a.slice(0,3).map(x=>x.type).join(',')==='Dna,AgentValidationPkg,Create',
      'Unexpected first three source-chain actions');
 must(a[3]?.type==='Create'&&a[3]?.entry_type==='CapGrant','Private CapGrant not at source-chain index 3');
 must(a[4]?.type==='InitZomesComplete','InitZomesComplete not after CapGrant');
 must(a.filter(x=>x.type==='InitZomesComplete').length===1,'InitZomesComplete duplicated');
 must(a.every((x,i)=>x.seq===i&&(i===0?!x.prev:x.prev===a[i-1].hash)&&x.signature_length===64),
      'Broken source chain sequence, hash linkage or signature lengths');
 must(snap.capgrant_count===1&&snap.capgrant_stored&&snap.capgrant_wire_hidden,
      'Private CapGrant missing or exposed in network-facing record conversion');
}
async function main(){
 await step('HWC_FINAL_MIGRATION_SOURCE_VERIFIED',async()=>{
  const contents=fs.readFileSync(path.join(OUT_LOG,'hwc-migration-provenance.txt'),'utf8');
  must(contents.includes('agent2_migration_patch=bc55d2a2fd9cc4da6c384f086e261f3ffa27cb39') &&
       contents.includes('upstream_hwc=0c391226e78769d44ccb4661881ed8998b15f903') &&
       contents.includes('migration_schema=composite_cell_id_entry_hash'),
       'CI runtime provenance does not match migrated HWC sources');
 });
 server=http.createServer(site);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8765,'127.0.0.1',resolve);});
 const ext=path.join(HWC,'packages/extension/dist-chrome');
 must(fs.existsSync(path.join(ext,'manifest.json')),'patched HWC Chrome dist missing');
 const browserEnv={...process.env};
 // Never inherit the H2HC operator secret in a Chromium child process.
 delete browserEnv.H2HC_LINKER_ADMIN_SECRET;
 const launchOptions={env:browserEnv,headless:false,viewport:{width:1100,height:800},
    args:['--disable-extensions-except='+ext,'--load-extension='+ext,'--no-first-run',
      '--disable-default-apps','--no-sandbox','--disable-dev-shm-usage']};
 context=await chromium.launchPersistentContext(PROFILE,launchOptions);
 let page=context.pages()[0]||await context.newPage();
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
      // HWC's extension messaging serializes Uint8Array as numeric-key objects
      // on Chrome; new Uint8Array(object) silently yields ZERO bytes.
      const toBytes=v=>{
        if(v instanceof Uint8Array)return v;
        if(Array.isArray(v))return new Uint8Array(v);
        if(v && typeof v==='object' && Array.isArray(v.data))return new Uint8Array(v.data);
        if(v && typeof v==='object'){
          const keys=Object.keys(v).sort((a,b)=>Number(a)-Number(b));
          if(keys.length && keys.every((k,i)=>k===String(i) && Number.isInteger(v[k]) && v[k]>=0 && v[k]<256))
            return new Uint8Array(keys.map(k=>v[k]));
        }
        throw Error('HWC returned unsupported byte encoding');
      };
      const b64=v=>{
        const b=toBytes(v);
        if(b.length!==39)throw Error('HWC installed HoloHash length '+b.length+' not 39');
        return 'u'+btoa(String.fromCharCode(...b))
          .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      };
      return {agent:b64(info.agentPubKey),dna:b64(info.cells[0][0]),status:info.status,
        contextId:info.contextId,cellAgent:b64(info.cells[0][1])};
    },m.happ_bundle_sha256);
 });
 evidence.installed_public_identity={agent:info.agent,dna:info.dna,cell_agent:info.cellAgent,status:info.status};
 await step('HWC_INSTALLED_DNA_AND_AGENT',async()=>{
   must(info.agent===host&&info.cellAgent===host,'HWC installed cell agent changed from origin host; public comparison: '+JSON.stringify(evidence.installed_public_identity));
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
   // Grant persistence is verified independently by the CI-only internal worker inspector.
 });
 // All three independent Chromium/Lair agents initialize the same actual game DNA.
 // Operator-only H2HC allowlisting happens in Node; no bearer/secret enters the page.
 threeProfiles=await step('THREE_PROFILE_REAL_HWC_H2HC_SETUP',async()=>await prepareThreeProfiles({
   chromium,launchOptions,origin:ORIGIN,hostPage:page,hostAgent:host,
   dna:m.dna_hash,happSha:m.happ_bundle_sha256,networkSeed:m.network_seed,
   record,evidence,snapshotFor,snapshotCursor:()=>ciSnapshots.length,verifyChain
 }));
 await step('HOST_LOBBY_CREATION',async()=>{
   const v=await page.evaluate(async(seed)=>{
     return await window.holochain.callZome({zome_name:'game',fn_name:'create_lobby',
      payload:{code:seed,player_count:3,impostor_count:1,task_target:1,display_name:'HWC CI Host'}});
   },m.network_seed);
   evidence.host_create_result_kind=typeof v;
   return v;
 });
 const authored=await step('CI_READ_ONLY_CHAIN_GENESIS_AND_PRIVACY',async()=>{
   const s=await snapshotFor(host,0,x=>x.links>=2);
   verifyChain(s);
   record('CAP_GRANT_RECORD_PERSISTENCE','PASS','Single private CapGrant at seq=3; hidden in DHT record conversion');
   must(s.links>=2,'Host lobby call did not author lobby and join link actions');
   const lobbyActions=s.actions.filter(x=>x.type==='Create'
      &&x.entry_type&&typeof x.entry_type==='object'
      &&x.entry_type.entry_index===0&&x.entry_type.visibility==='Public');
   must(lobbyActions.length===1,'Cannot uniquely identify the real authored public lobby action');
   evidence.host_lobby_action_hash=lobbyActions[0].hash;
   evidence.host_source_chain_actions=s.actions.map(x=>({seq:x.seq,type:x.type,hash:x.hash,
      public_entry_index:x.entry_type?.visibility==='Public'?x.entry_type.entry_index:null}));
   evidence.host_link_count=s.links;
   return s;
 });
 await step('REAL_BROWSER_RESTART_PERSISTENCE',async()=>{
   const start=ciSnapshots.length;
   await context.close();
   context=await chromium.launchPersistentContext(PROFILE,launchOptions);
   page=context.pages()[0]||await context.newPage();
   await page.goto(ORIGIN,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
   const again=await page.evaluate(async()=>{
     await window.holochain.connect();
     const b=new Uint8Array(window.holochain.myPubKey||[]);
     return 'u'+btoa(String.fromCharCode(...b))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   });
   must(again===host,'Authentic browser Lair host key changed after full restart');
   await page.evaluate(async()=>await window.holochain.callZome({
     zome_name:'game',fn_name:'get_game_state',payload:null
   }));
   const s=await snapshotFor(host,start);
   verifyChain(s,false); // read-only reload should not sign any new actions
   must(s.actions.map(x=>x.hash).join(',')===authored.actions.map(x=>x.hash).join(','),
     'Source chain mutated or restarted after full Chrome process/profile restart');
 });
 await step('TWO_GUEST_FULL_CHROMIUM_RESTARTS',async()=>await threeProfiles.restart());
 await step('REAL_AUTHENTICATED_H2HC_QUEUE_AND_DHT_GATE',async()=>await threeProfiles.probeNetwork());
}
try{await main();}
catch(e){console.error('FIRST_RUNTIME_FAILURE:',safeRuntimeError(e?.stack||e));process.exitCode=1;}
finally{
 if(threeProfiles)await threeProfiles.close().catch(()=>{});
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
