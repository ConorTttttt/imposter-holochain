#!/usr/bin/env node
/**
 * Agent 4 real HWC three-profile extension. Runs INSIDE the same headed
 * Chromium job as the host-bound Imposter WASM. No mocks, copied keys,
 * bearer-token export, localStorage transfer, or simulated DHT records.
 * H2HC's authenticated queue is not a native 0.7 DHT validation authority.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT=process.env.GITHUB_WORKSPACE||process.cwd();
const OUTPUT=path.join(ROOT,'runtime-evidence');
const GATEWAY=process.env.H2HC_BASE_URL||'http://127.0.0.1:8090';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const b64=v=>'u'+Buffer.from(v).toString('base64url');
function requireTrue(x,msg){if(!x)throw Error(msg);}
function asBytes(v){
 if(v instanceof Uint8Array)return v;
 if(Array.isArray(v))return new Uint8Array(v);
 if(v&&typeof v==='object'){
  const keys=Object.keys(v).sort((a,b)=>Number(a)-Number(b));
  if(keys.length&&keys.every((k,i)=>k===String(i)))return new Uint8Array(keys.map(k=>v[k]));
 }
 throw Error('Unrecognized Chrome HWC hash response');
}
function getServerLines(){
 const f=process.env.H2HC_SERVER_LOG;
 requireTrue(f&&fs.existsSync(f),'H2HC server log absent; cannot prove signed challenge');
 return fs.readFileSync(f,'utf8').replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/);
}
async function allowlist(agent,label){
 requireTrue(process.env.H2HC_LINKER_ALLOW_INSECURE_DEV==='false'
   &&process.env.H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK==='false',
   'Insecure H2HC auth or local authority fallback enabled');
 const secret=process.env.H2HC_LINKER_ADMIN_SECRET;
 requireTrue(secret&&secret.length>=32,'No operator-only H2HC allowlist secret');
 const response=await fetch(GATEWAY+'/admin/agents',{
  method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
  body:JSON.stringify({agent_pubkey:agent,capabilities:['dht_read','dht_write','k2'],label})
 });
 requireTrue(response.status===204,label+' not operator-allowlisted: '+response.status);
}
async function connectIdentity(page){
 return page.evaluate(async()=>{
  await window.holochain.connect();
  const x=new Uint8Array(window.holochain.myPubKey||[]);
  if(x.length!==39)throw Error('Not an authentic 39-byte HWC/Lair pubkey');
  return 'u'+btoa(String.fromCharCode(...x)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 });
}
async function joinGateway(page,agent,dna,label,evidence,record){
 await page.evaluate(async u=>window.holochain.configureNetwork({linkerUrl:u}),GATEWAY);
 let status,network,proof=false;
 for(let i=0;i<110;i++){
  status=await page.evaluate(async()=>window.holochain.getConnectionStatus());
  if(status?.wsHealthy&&status?.authenticated){
   network=await page.evaluate(async()=>window.holochain.getNetworkStatus());
   const lines=getServerLines();
   proof=lines.some(l=>l.includes('Auth OK for agent '+agent))
     &&lines.some(l=>l.includes('registered for DNA')&&l.includes(agent)&&l.includes(dna));
   if(proof)break;
  }
  await sleep(400);
 }
 requireTrue(status?.wsHealthy===true&&status?.authenticated===true&&proof,
   label+' missing server-confirmed signed H2HC auth and exact own-agent/DNA registration');
 evidence.h2hc_profile_sessions??={};
 evidence.h2hc_profile_sessions[label]={agent,dna,authenticated:true,ws_healthy:true,
    server_signed_challenge:true,server_registered_for_dna:true,
    background_has_session:network?.hasSession===true};
 if(network?.hasSession!==true)
  record('H2HC_BACKGROUND_SESSION_'+label,'BLOCKED',
    'Offscreen signed session verified by gateway; background hasSession is false');
}
async function checkApp(page,agent,dna){
 const info=await page.evaluate(async()=>{
  const i=await window.holochain.appInfo('imposter-browser-poc');
  return {status:i?.status,cells:i?.cells,agent:i?.agentPubKey};
 });
 requireTrue(info.status==='enabled'&&info.cells?.length===1,'App not installed in profile');
 const cell=info.cells[0].map(x=>b64(asBytes(x)));
 requireTrue(cell[0]===dna&&cell[1]===agent,
  'Profile installed DNA/cell agent does not match host-bound deployment');
 return {agent,dna:cell[0]};
}
async function install(page,agent,dna,happSha){
 await page.evaluate(async expected=>{
  const response=await fetch('/imposter-browser-poc.happ',{cache:'no-store'});
  if(!response.ok)throw Error('Independent guest bundle unavailable');
  const bundle=new Uint8Array(await response.arrayBuffer());
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bundle)),
    x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!==expected)throw Error('Independent guest got different hApp bytes');
  await window.holochain.installApp({bundle,installedAppId:'imposter-browser-poc'});
 },happSha);
 await checkApp(page,agent,dna);
}
async function getState(page){
 return page.evaluate(async()=>window.holochain.callZome({
  zome_name:'game',fn_name:'get_game_state',payload:null}));
}
/**
 * The three profiles are distinct Playwright persistent user-data directories.
 * The same unpacked extension binary is loaded by three separate Chrome
 * processes; no signing material or H2HC session token crosses their boundary.
 */
export async function prepareThreeProfiles({
 chromium,launchOptions,origin,hostPage,hostAgent,dna,happSha,networkSeed,
 record,evidence,snapshotFor,snapshotCursor,verifyChain
}){
 const profiles=[];
 try{
  await allowlist(hostAgent,'ephemeral-hwc-host');
  await joinGateway(hostPage,hostAgent,dna,'host',evidence,record);
  for(const label of ['guest_b','guest_c']){
   const profile=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-hwc-'+label+'-'));
   const context=await chromium.launchPersistentContext(profile,launchOptions);
   const item={label,profile,context,page:null,agent:null,chain:null};
   profiles.push(item);
   item.page=context.pages()[0]||await context.newPage();
   await item.page.goto(origin,{waitUntil:'domcontentloaded'});
   await item.page.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
   item.agent=await connectIdentity(item.page);
   requireTrue(/^uhCAk[A-Za-z0-9_-]{48}$/.test(item.agent),
     label+' has invalid Holochain agent key');
   requireTrue(item.agent!==hostAgent&&profiles.every(p=>p===item||p.agent!==item.agent),
     'Lair identity reused in isolated profile');
   await allowlist(item.agent,label);
   await install(item.page,item.agent,dna,happSha);
   await joinGateway(item.page,item.agent,dna,label,evidence,record);
   await getState(item.page); // genuine WASM coordinator init in that guest
   item.chain=await snapshotFor(item.agent);
   verifyChain(item.chain);
  }
  requireTrue(new Set([hostAgent,...profiles.map(p=>p.agent)]).size===3,
    'Not three independently authored HWC/Lair identities');
  requireTrue(new Set(profiles.map(p=>p.profile)).size===2,'Chromium profile path collision');
  evidence.three_browser_topology={
   identities:{host:hostAgent,guest_b:profiles[0].agent,guest_c:profiles[1].agent},
   dna_hash:dna,network_seed:networkSeed,happ_sha256:happSha,
   distinct_profile_directories:true,distinct_h2hc_ws_agents:true,
   producer:'genuine Playwright Chromium + pinned HWC + actual coordinator WASM'};
  record('THREE_INDEPENDENT_HWC_LAIR_IDENTITIES','PASS','Three HWC/Lair keys; one host-bound DNA and hApp digest');
  record('THREE_SIGNED_H2HC_WEBSOCKET_IDENTITIES','PASS',
    'Gateway independently authenticated/registered host, guest B and guest C');
  // Deny *before* legitimate host creation, at the real Rust integrity validator.
  const guest=profiles[0];
  await (async()=>{
   const test=await guest.page.evaluate(async()=>{
    try{
     await window.holochain.callZome({zome_name:'game',fn_name:'create_lobby',
      payload:{code:'UNAUTH-P0',player_count:3,impostor_count:1,task_target:1,display_name:'Guest B'}});
     return {allowed:true};
    }catch(e){return {allowed:false,error:String(e)};}
   });
   requireTrue(!test.allowed&&/game seed host does not match lobby author/.test(test.error),
    'Guest B rejection was not native Rust host-binding validation');
   return test;
  })();
  const chain=await snapshotFor(guest.agent,0,x=>x.fn==='create_lobby');
  requireTrue(chain.actions.map(x=>x.hash).join(',')===guest.chain.actions.map(x=>x.hash).join(','),
   'Unauthorized guest authored source-chain action');
  evidence.unauthorized_guest_rejection='Rust integrity author-mismatch; no authored action';
  record('UNAUTHORIZED_GUEST_REJECTED','PASS',
   'Guest B native Rust validation rejected unbound host; chain unchanged');
  return {
   profiles,
   async restart(){
    for(const item of profiles){
     const before=item.chain.actions.map(x=>x.hash).join(',');
     await item.context.close();
     item.context=await chromium.launchPersistentContext(item.profile,launchOptions);
     item.page=item.context.pages()[0]||await item.context.newPage();
     await item.page.goto(origin,{waitUntil:'domcontentloaded'});
     await item.page.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
     requireTrue(await connectIdentity(item.page)===item.agent,
       item.label+' Lair signing identity changed on full browser restart');
     await checkApp(item.page,item.agent,dna);
     await joinGateway(item.page,item.agent,dna,item.label,evidence,record);
     const beforeRestartProbe=snapshotCursor();
     await getState(item.page);
     const snapshot=await snapshotFor(item.agent,beforeRestartProbe,
       x=>x.fn==='get_game_state'&&x.actions.length>=item.chain.actions.length);
     verifyChain(snapshot,false);
     requireTrue(before===snapshot.actions.map(x=>x.hash).join(','),
       item.label+' source chain mutated on read-only browser restart');
    }
    record('THREE_PROFILE_IDENTITY_RESTART_PERSISTENCE','PASS',
      'Both guest HWC/Lair profiles, installed DNA and authored chains survive Chrome restart (host separately checked)');
   },
   async probeNetwork(){
    let rows=[];
    for(let i=0;i<65;i++){
     rows=getServerLines().filter(l=>l.includes('Publish request completed'));
     if(rows.length)break;
     await sleep(400);
    }
    const batches=rows.map(l=>l.match(/queued=(\d+)\s+failed=(\d+)\s+published=(\d+)/))
      .filter(Boolean).map(m=>({queued:Number(m[1]),failed:Number(m[2]),published:Number(m[3])}));
    requireTrue(batches.length>0&&batches.some(b=>b.queued>0)&&batches.every(b=>b.failed===0),
       'No genuine accepted HWC signed operations in secure H2HC gateway log');
    evidence.h2hc_publish_batches=batches;
    record('H2HC_AUTHENTICATED_DHT_QUEUE','PASS',
      'Real signed HWC operations accepted; this is NOT remote receipt/validation');
    evidence.independent_guest_reads={};
    for(const item of profiles){
     try{
      const s=await getState(item.page);
      evidence.independent_guest_reads[item.label]={
       sees_seed:s?.code===networkSeed,
       player_count:Array.isArray(s?.players)?s.players.length:null,
       source:'independent real game::get_game_state coordinator call',
       native_validation:'NOT_PROVEN'};
     }catch(e){
      evidence.independent_guest_reads[item.label]={error:String(e).slice(0,200)};
     }
    }
    evidence.native_dht_handoff={
      source:'Agent 3 ci/agent3-h2hc-security-validation @ 7e13ca05d2cd5b57016e55049c11f5337bb26c25',
      external_workflow:44192859072,
      native_conductors:2,
      current_storage_arcs:'FULL (external CI)',
      h2hc_queued:2,h2hc_published:2,h2hc_failed:0,
      authority_validation:'NOT_PROVEN',independent_browser_get:'NOT_PROVEN',
      same_run_browser_native_receipt:false,
      note:'External transport evidence is NOT a runtime authority grant or a validated record'};
    record('NATIVE_DHT_AUTHORITY_VALIDATED','BLOCKED',
      'Agent 3 run 44192859072: two native 0.7 FULL arcs and transport publication 2; native integrity verdict and independent read NOT proven');
    record('THREE_BROWSER_VALIDATED_LOBBY_CONVERGENCE','BLOCKED',
      'H2HC accepted queued ops; cannot infer native ValidationStatus::Valid or remote DHT receipt');
    record('GUEST_B_NATIVE_DHT_LOBBY_DISCOVERY','BLOCKED',
      'Requires independent validated non-null HWC DHT read of the host Lobby action hash');
    record('GUEST_B_LOBBY_JOIN','BLOCKED','Cannot invoke real join_game before verified lobby retrieval');
    record('GUEST_C_NATIVE_DHT_LOBBY_DISCOVERY','BLOCKED',
      'Requires validated independent Guest C remote read');
    record('GUEST_C_LOBBY_JOIN','BLOCKED','Cannot invoke real join_game before verified lobby retrieval');
    record('THREE_PLAYER_LOBBY_STATE_AGREEMENT','BLOCKED','No two independently validated guest joins');
    record('GUEST_B_SEAT_RECOVERY','BLOCKED','No real guest seat exists to recover yet');
    record('HOST_POST_RESTART_SHARED_LOBBY_RECOVERY','BLOCKED','Native-validated shared state not established');
    record('AGENT2_PRODUCTION_SAME_HASH_COLLISION_EVIDENCE','PASS',
      'Issue #7 closed; separate two genuine Lair / one OPFS / same entry hash headed run 44191974895 PASS; not rerun here');
    record('THREE_PROFILE_SAME_HASH_COLLISION_RETEST','NOT RUN',
      'Three-browser job uses separate OPFS; Agent 2 independently accepted collision / restart on one OPFS');
   },
   async close(){
    for(const item of profiles){
     await item.context?.close().catch(()=>{});
     fs.rmSync(item.profile,{recursive:true,force:true});
    }
   }
  };
 }catch(e){
  for(const item of profiles){
   await item.context?.close().catch(()=>{});
   fs.rmSync(item.profile,{recursive:true,force:true});
  }
  throw e;
 }
}
