// CI-only malicious content with a valid Holochain 0.7 source chain.
// No production HWC/Imposter/H2HC sources change. Test signing key is ephemeral.
// Never log the signing key, bearer, challenge response or serialized private payload.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

export async function runNativeNegativeFixture({
  HWC, ROOT, OUT_LOG, m, host, evidence, record, publicHoloHash
}) {
  const network = process.env.H2HC_BASE_URL || 'http://127.0.0.1:8090';
  const secret = process.env.H2HC_LINKER_ADMIN_SECRET;
  assert(secret && process.env.H2HC_LINKER_ALLOW_INSECURE_DEV === 'false');
  assert(process.env.H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK === 'false');
  const h=(await import(pathToFileURL(path.join(OUT_LOG,'hwc-op-hash-native.cjs')).href));
  const {hashAction,hashOp,ChainOpType,serializeAction,hashFrom32AndType,HoloHashType,
    computeAppEntryHash,computeAgentEntryHash}=h.default||h;
  const o=(await import(pathToFileURL(path.join(OUT_LOG,'hwc-op-wire-native.cjs')).href));
  const {serializeOpForLinker}=o.default||o;
  const {encode}=createRequire(path.join(HWC,'package.json'))('@msgpack/msgpack');
  const b64=v=>Buffer.from(v).toString('base64');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const dna=Uint8Array.from(Buffer.from(m.dna_hash.slice(1).replace(/-/g,'+').replace(/_/g,'/'),'base64'));
  assert.equal(dna.length,39);
  const signingKey=crypto.randomBytes(32); // ephemeral CI-only, never archived
  const privateKey=crypto.createPrivateKey({
    key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),signingKey]),
    type:'pkcs8',format:'der'
  });
  const public32=crypto.createPublicKey(privateKey).export({type:'spki',format:'der'}).subarray(-32);
  const agent=hashFrom32AndType(new Uint8Array(public32),HoloHashType.Agent);
  const agentString=publicHoloHash(agent);
  assert(agentString && agentString!==host &&
    agentString!==evidence.independent_guest?.agent, 'negative signer must be isolated');

  function sign(bytes) {
    return new Uint8Array(crypto.sign(null,Buffer.from(bytes),privateKey));
  }
  function canonical(info) {
    return '{'+[
      '"agent":'+JSON.stringify(info.agent),
      '"space":'+JSON.stringify(info.space),
      '"createdAt":'+JSON.stringify(info.createdAt),
      '"expiresAt":'+JSON.stringify(info.expiresAt),
      '"isTombstone":'+String(info.isTombstone),
      '"url":'+JSON.stringify(info.url),
      '"storageArc":'+(info.storageArc===null?'null':JSON.stringify(info.storageArc)),
    ].join(',')+'}';
  }
  function makeAction(seq,prev,data,entry=null) {
    const action={
      header:{
        author:agent,timestamp:Date.now()*1000+seq*1000,
        action_seq:seq,prev_action:prev
      },
      data
    };
    const signature=sign(serializeAction(action));
    const signedAction={data:action,signature};
    const actionHash=hashAction(action);
    const variants=data.type==='Create'
      ? [ChainOpType.CreateRecord,ChainOpType.CreateEntry,ChainOpType.AgentActivity]
      : [ChainOpType.CreateRecord,ChainOpType.AgentActivity];
    const ops=variants.map(type=>{
      const op={
        type,signedAction,
        ...(type===ChainOpType.AgentActivity?{}:
          {opEntry:entry?{Present:entry}:{ActionOnly:null}})
      };
      return {
        type,op_hash:publicHoloHash(hashOp(type,action)),
        wire:{
          op_data:b64(serializeOpForLinker(op)),
          signature:b64(signature)
        }
      };
    });
    return {seq,action_hash:publicHoloHash(actionHash),hash_bytes:actionHash,ops};
  }

  // Match the pinned HWC genesis exactly: DNA, AVP, Create Agent, Init.
  const agentEntryHash=computeAgentEntryHash(agent);
  const genesis=[
    {type:'Dna',dna_hash:dna},
    {type:'AgentValidationPkg',membrane_proof:null},
    {type:'Create',entry_type:'AgentPubKey',entry_hash:agentEntryHash},
    {type:'InitZomesComplete'}
  ];
  let previous=null;
  const genesisOps=[];
  for(let seq=0;seq<genesis.length;seq++){
    const entry=seq===2?{entry_type:'Agent',entry:agent}:null;
    const signed=makeAction(seq,previous,genesis[seq],entry);
    previous=signed.hash_bytes;
    genesisOps.push(signed);
  }
  // Original integrity rule: only the host encoded in the g1 seed may
  // author a Lobby. This separate signer is NOT that host.
  assert(m.network_seed.startsWith('g1.'),'host-bound DNA required');
  const lobby={code:m.network_seed,player_count:3,impostor_count:1,task_target:1};
  const entryBytes=new Uint8Array(encode(lobby));
  const entryHash=computeAppEntryHash(entryBytes);
  const invalid=makeAction(4,previous,{
    type:'Create',
    entry_type:{App:{entry_index:0,zome_index:0,visibility:'Public'}},
    entry_hash:entryHash,
  },{entry_type:'App',entry:entryBytes});
  const publicFixture={
    dna:m.dna_hash,author:agentString,action_seq:4,
    target_action:invalid.action_hash,
    expected_integrity_rule:'game seed host does not match lobby author',
    genesis:genesisOps.map(x=>({
      seq:x.seq,action_hash:x.action_hash,
      op_hashes:x.ops.map(o=>({type:o.type,hash:o.op_hash}))
    })),
    invalid_ops:invalid.ops.map(x=>({type:x.type,hash:x.op_hash}))
  };
  evidence.native_signed_negative_fixture=publicFixture;
  record('NEGATIVE_ISOLATED_SIGNED_ACTION','PASS',
    'Separate temporary test signer created 4 genesis actions plus invalid Lobby Create; no source validator modified');

  const granted=await fetch(network+'/admin/agents',{
    method:'POST',
    headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
    body:JSON.stringify({
      agent_pubkey:agentString,capabilities:['dht_read','dht_write','k2'],
      label:'CI-native-negative-controlled-test-signer'
    }),
    signal:AbortSignal.timeout(10000)
  });
  assert.equal(granted.status,204,'operator allowlist of test signer');
  let ws=null;
  let session=null;
  try {
    ws=new WebSocket(network.replace(/^http/,'ws')+'/ws');
    const messages=[];
    let waiter=null;
    ws.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data));
      if(message.type==='sign_agent_info'){
        const signature=message.agent_pubkey===agentString
          ? b64(sign(Buffer.from(canonical(message.agent_info),'utf8'))) : null;
        ws.send(JSON.stringify({type:'sign_response',request_id:message.request_id,
          ...(signature?{signature}:{error:'wrong signer'})}));
        return;
      }
      if(waiter&&waiter.types.includes(message.type)){
        const w=waiter;waiter=null;clearTimeout(w.timer);w.resolve(message);
      }else messages.push(message);
    });
    const next=(types,ms=20000)=>{
      const wanted=Array.isArray(types)?types:[types];
      const i=messages.findIndex(x=>wanted.includes(x.type));
      if(i>=0)return Promise.resolve(messages.splice(i,1)[0]);
      assert(!waiter,'overlapping WS await');
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{waiter=null;reject(Error('WS result not received'))},ms);
        waiter={types:wanted,resolve,timer};
      });
    };
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('WS connect timeout')),10000);
      ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('WS open error'))},{once:true});
    });
    ws.send(JSON.stringify({type:'auth',agent_pubkey:agentString}));
    const challenge=await next(['auth_challenge','auth_error']);
    assert.equal(challenge.type,'auth_challenge');
    ws.send(JSON.stringify({type:'auth_challenge_response',
      signature:b64(sign(Buffer.from(challenge.challenge,'hex')))}));
    const auth=await next(['auth_ok','auth_error']);
    assert.equal(auth.type,'auth_ok');
    assert.match(auth.session_token,/^[a-f0-9]{64}$/);
    session=auth.session_token;
    ws.send(JSON.stringify({type:'register',dna_hash:m.dna_hash,agent_pubkey:agentString}));
    const reg=await next(['registered','error'],30000);
    assert.equal(reg.type,'registered');
    record('NEGATIVE_H2HC_TRANSPORT_AUTHENTICATION','PASS',
      'Signed challenge accepted, same DNA, authorized isolated signer and fresh bearer');

    async function publish(items) {
      const res=await fetch(network+'/dht/'+m.dna_hash+'/publish',{
        method:'POST',
        headers:{Authorization:'Bearer '+session,'Content-Type':'application/json'},
        body:JSON.stringify({ops:items.map(x=>x.wire)}),
        signal:AbortSignal.timeout(25000),
      });
      assert.equal(res.status,200,'authenticated gateway DHT publish status');
      const body=await res.json();
      assert.equal(body.failed,0,'gateway signature/owner/DNA preflight failed');
      assert.equal(body.queued,items.length,'signed native DhtOps not queued');
      return {http:res.status,queued:body.queued,failed:body.failed,published:body.published};
    }
    evidence.negative_native_genesis_publish=[];
    for(const act of genesisOps){
      evidence.negative_native_genesis_publish.push({
        seq:act.seq,...await publish(act.ops)
      });
      await sleep(1300);
    }
    record('NEGATIVE_GENESIS_TRANSPORT_PUBLICATION','PASS',
      'All 4 chain genesis actions correctly signed, H2HC preflight accepted each DhtOp');

    function nativeRows() {
      const result={};
      for(const [conductor,port] of [['conductor-a',33555],['conductor-b',33557]]){
        const env={...process.env};delete env.H2HC_LINKER_ADMIN_SECRET;
        const cmd=spawnSync('nix',['develop','--no-write-lock-file','--command','hc',
          'client','call','--port',String(port),'dump-op-timings',
          m.dna_hash,'--limit','2000'],{
          cwd:ROOT,env,encoding:'utf8',timeout:35000,maxBuffer:12*1024*1024
        });
        const rows=[];
        if(cmd.status===0){
          const parsed=JSON.parse(cmd.stdout);
          for(const row of (parsed.timings||[])){
            const hash=publicHoloHash(row.op_hash);
            if(hash)rows.push({
              hash,validation_status:row.validation_status??null,
              locally_validated:row.locally_validated??null,
              integrated:row.when_integrated!==null && row.when_integrated!==undefined,
              abandoned:row.abandoned_at??null
            });
          }
        }
        result[conductor]={exit:cmd.status,rows};
      }
      return result;
    }
    const valid=row=>row?.validation_status==='Accepted'&&
      row.locally_validated===true&&row.integrated===true;
    const genesisActivity=genesisOps.map(a=>a.ops.find(o=>o.type===ChainOpType.AgentActivity).op_hash);
    let nativeGenesis=null,genesisAccepted=false;
    for(let i=0;i<18;i++){
      nativeGenesis=nativeRows();
      const all=Object.values(nativeGenesis).flatMap(c=>c.rows);
      genesisAccepted=genesisActivity.every(hash=>all.some(row=>row.hash===hash&&valid(row)));
      if(genesisAccepted)break;
      await sleep(2500);
    }
    evidence.negative_native_genesis_validation={
      exact_op_hashes:genesisActivity,
      accepted_integrated_all:genesisAccepted,
      observed:Object.fromEntries(Object.entries(nativeGenesis).map(([k,v])=>[
        k,{exit:v.exit,rows:v.rows.filter(r=>genesisActivity.includes(r.hash))}])),
    };
    record('NEGATIVE_GENESIS_NATIVE_SYSTEM_DEPENDENCIES',
      genesisAccepted?'PASS':'BLOCKED',
      genesisAccepted?'Four signed genesis AgentActivity operations accepted and integrated by real native authorities':
        'Signed genesis transport passed but exact native chain dependencies not yet all accepted/integrated');

    const invalidPublish=await publish(invalid.ops);
    evidence.negative_native_invalid_publish=invalidPublish;
    record('NEGATIVE_H2HC_INVALID_CONTENT_PUBLICATION',
      invalidPublish.published>0?'PASS':'NO_CONFIRMED_DELIVERY',
      'Signed structurally valid invalid-content Create DhtOps passed H2HC preflight; native verdict pending');
    const invalidHashes=new Set(invalid.ops.map(x=>x.op_hash));
    const entryOp=invalid.ops.find(x=>x.type===ChainOpType.CreateEntry);
    let nativeInvalid=null,entryRejected=false;
    for(let i=0;i<22;i++){
      nativeInvalid=nativeRows();
      const observed=Object.values(nativeInvalid).flatMap(c=>c.rows)
        .filter(x=>invalidHashes.has(x.hash));
      entryRejected=observed.some(x=>x.hash===entryOp.op_hash &&
        x.validation_status==='Rejected'&&x.locally_validated===true);
      if(entryRejected)break;
      await sleep(2000);
    }
    const observed=Object.values(nativeInvalid).flatMap(c=>c.rows)
      .filter(x=>invalidHashes.has(x.hash));
    const integratedInvalid=observed.filter(x=>valid(x));
    const log=fs.readFileSync(path.join(OUT_LOG,'native-holochain-0.7.log'),'utf8');
    const reasonVisible=log.includes('game seed host does not match lobby author');
    evidence.negative_native_invalid_verdict={
      exact_entry_op_hash:entryOp.op_hash,
      native_receipt:observed.length>0,
      system_dependency_chain_valid:genesisAccepted,
      native_app_entry_rejected:entryRejected,
      native_integrity_reason_visible:reasonVisible,
      accepted_integrated_invalid_ops:integratedInvalid,
      per_conductor:Object.fromEntries(Object.entries(nativeInvalid).map(([k,v])=>[
        k,{exit:v.exit,rows:v.rows.filter(r=>invalidHashes.has(r.hash))}])),
    };
    record('NEGATIVE_NATIVE_OPERATION_RECEIPT',observed.length>0?'PASS':'BLOCKED',
      'Native official admin timing rows matched exact signed invalid operation hashes: '+observed.length);
    record('NEGATIVE_NATIVE_SYSTEM_VALIDATION',genesisAccepted?'PASS':'BLOCKED',
      genesisAccepted?'Native independently accepted and integrated all initial chain dependencies':
        'Genesis dependencies missing; no application-integrity inference permitted');
    record('NATIVE_INTEGRITY_INVALID_LOBBY_REJECTION',
      genesisAccepted&&entryRejected&&integratedInvalid.length===0?'PASS':'BLOCKED',
      genesisAccepted&&entryRejected&&integratedInvalid.length===0?
        'Exact Holochain 0.7 native CreateEntry op Rejected after integrated genesis; none of its invalid op variants accepted/integrated':
        'Native app rejection NOT established: dependency status, rejection, or accepted-invalid-content guard failed');
    record('NEGATIVE_ORIGINAL_VALIDATION_REASON',
      reasonVisible?'SEEN_IN_NATIVE_LOG':'NOT_LOGGED',
      'Per-op native verdict is authoritative; reason requires native validator logging and cannot be inferred from gateway');
  } finally {
    // The short-lived bearer/signing key are never written to artifacts.
    if(ws)ws.close();
    session=null;
    signingKey.fill(0);
  }
}
