#!/usr/bin/env python3
"""Instrument a TEMPORARY Agent 4 browser harness checkout for Agent 3 wire proof.
Never modify the actual Agent 2 HWC extension or source repo. Fail on anchor drift.
"""
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
host_anchor=" const m=await step('REAL_HOST_BOUND_PACKAGE',async()=>{"
allowlist=r"""
 await step('H2HC_OPERATOR_ALLOWLIST',async()=>{
   const url=process.env.H2HC_BASE_URL||'http://127.0.0.1:8090';
   const admin=process.env.H2HC_LINKER_ADMIN_SECRET;
   must(Boolean(admin)&&admin.length>=32,'Missing operator-admin H2HC secret');
   const response=await fetch(url+'/admin/agents',{
     method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},
     body:JSON.stringify({
       agent_pubkey:host,
       capabilities:['dht_read','dht_write','k2'],
       label:'ephemeral-real-HWC-host'
     })
   });
   must(response.status===204,'H2HC operator could not allowlist real HWC host; HTTP '+response.status);
   evidence.linker_allowlisted_agent=host; // pubkey, never Lair signing key
 });
"""
net_anchor=" await step('REAL_IMPOSTER_GET_GAME_STATE_INIT',async()=>{"
network=r"""
 await step('H2HC_REAL_HWC_SIGNED_CHALLENGE_AND_REGISTRATION',async()=>{
   const url=process.env.H2HC_BASE_URL||'http://127.0.0.1:8090';
   await page.evaluate(async(h2hc)=>window.holochain.configureNetwork({linkerUrl:h2hc}),url);
   let last,net;
   for(let i=0;i<80;i++){
     last=await page.evaluate(async()=>window.holochain.getConnectionStatus());
     if(last?.authenticated===true){
       net=await page.evaluate(async()=>window.holochain.getNetworkStatus());
       if(net?.hasSession===true)break;
     }
     await new Promise(resolve=>setTimeout(resolve,500));
   }
   must(last?.authenticated===true,
     'Real HWC never authenticated to H2HC; flags '+JSON.stringify({
       wsHealthy:last?.wsHealthy,authenticated:last?.authenticated,hasSession:net?.hasSession,
       lastError:last?.lastError
     }));
   // Browser background and offscreen signer are two components; a false
   // background hasSession is a propagation risk, not proof the WS challenge
   // failed. Prove the actual H2HC server issued session and registered DNA.
   const evidenceLogPath=process.env.H2HC_SERVER_LOG;
   let serverProof='';
   for(let i=0;i<15;i++){
     serverProof=fs.existsSync(evidenceLogPath)?fs.readFileSync(evidenceLogPath,'utf8'):'';
     if(serverProof.includes('Auth OK for agent '+host)
         && serverProof.includes('Browser agent joined kitsune2 space')
         && serverProof.includes('dna=') )break;
     await new Promise(resolve=>setTimeout(resolve,300));
   }
   must(serverProof.includes('Auth OK for agent '+host)
     && serverProof.includes('Browser agent joined kitsune2 space'),
     'Browser status reported authenticated, but the H2HC server did not prove agent challenge + join');
   evidence.authenticated_h2hc={
     linker_url:url,auth:true,server_ws_challenge_confirmed:true,
     background_has_session:Boolean(net?.hasSession),installed_dna:info.dna,agent:info.agent
   };
   if(net?.hasSession!==true)
     record('H2HC_BACKGROUND_BEARER_PROPAGATION','AT_RISK',
       'H2HC issued authenticated WS session; browser getNetworkStatus.hasSession=false, verifying with real publish next');
   // Verify installed DNA and public agent - never extract private keys or tokens.
   must(info.agent===host&&info.dna===m.dna_hash,'Cell identity drift while linking');
 });
"""
after_host_create=" record('UNAUTHORIZED_GUEST_REJECTED','NOT RUN','Separate independent guest profile and integrity rejection needed');"
publish=r"""
 await step('H2HC_GENUINE_HWC_PUBLISH_OBSERVATION',async()=>{
   const logPath=process.env.H2HC_SERVER_LOG;
   must(Boolean(logPath),'Missing H2HC server log path');
   // Worker publication can be queued asynchronously; poll for a real linker POST.
   let log='';
   for(let i=0;i<50;i++){
     log=fs.existsSync(logPath)?fs.readFileSync(logPath,'utf8'):'';
     if(log.includes('Publish request completed'))break;
     await new Promise(resolve=>setTimeout(resolve,400));
   }
   log=log.replace(/\u001b\[[0-9;]*m/g,'');
   if(!log.includes('Publish request completed')){
     record('H2HC_REMOTE_SIGNED_OP','BLOCKED','HWC publisher did not reach real H2HC HTTP publish endpoint (20s)');
     throw Error('HWC real create_lobby produced no observable H2HC DHT publish POST');
   }
   const found=log.match(/Publish request completed[^\n]*queued=(\d+)[^\n]*failed=(\d+)[^\n]*published=(\d+)/);
   if(!found)throw Error('H2HC publish log missing queued/failed/published counters');
   const [queued,failed,published]=found.slice(1).map(Number);
   evidence.h2hc_dht_result={queued,failed,published,
      authority_validation:'NOT_PROVEN',separate_agent_get:'NOT_RUN'};
   must(queued>0&&failed===0,'HWC signed op was rejected by authenticated H2HC');
   record('H2HC_REAL_HWC_OP_ACCEPTED_INTO_QUEUE','PASS',JSON.stringify(evidence.h2hc_dht_result));
   record('H2HC_REMOTE_DELIVERY',
     published>0?'TRANSPORT_ACK_ONLY':'BLOCKED',
     published>0?'Peer transport ACK, NOT native validation':'No authority peer, queued but not published');
 });
"""
for anchor,name,insert in [(host_anchor,'host',allowlist),(net_anchor,'network',network),(after_host_create,'publish',publish)]:
    if s.count(anchor)!=1: raise SystemExit(f"Agent4 {name} injection anchor drift: {s.count(anchor)}")
    s=s.replace(anchor,insert+anchor,1)
out=p.with_name('agent3-h2hc-real-browser-bridge.mjs')
if out.exists():raise SystemExit("refuse overwrite existing bridge")
out.write_text(s)
print(f"Created temporary Agent3 browser bridge: {out} (Agent4 and HWC originals untouched)")
