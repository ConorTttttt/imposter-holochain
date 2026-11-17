#!/usr/bin/env python3
"""Add action/operation correlation and an independent real-HWC guest probe.

Applied ONLY to the ephemeral Agent 4/Agent 3 browser harness after
instrument_native_authority.py. The production game, integrity WASM, HWC,
H2HC binary and security policy are unchanged. Probe results fail closed.
"""
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()

def replace_once(old: str, new: str) -> None:
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"Convergence probe anchor drift ({n}): {old[:100]!r}")
    s = s.replace(old, new, 1)

replace_once(
    "let context,server,artifactDir,nativeConductor,nativeRoot;",
    "let context,server,artifactDir,nativeConductor,nativeRoot,guestContext,guestProfile;"
)
replace_once(
    " await step('HOST_LOBBY_CREATION',async()=>{",
    " const createdLobby=await step('HOST_LOBBY_CREATION',async()=>{"
)
replace_once(
    " record('UNAUTHORIZED_GUEST_REJECTED','NOT RUN','Separate independent guest profile and integrity rejection needed');",
    r"""
  // Do not infer a lobby action hash from a publish counter. HWC's zome
  // result is a native Record; its public action hash is the correlation key.
  const lobbyHashCandidate=createdLobby?.signed_action?.hashed?.hash ??
    createdLobby?.signedAction?.hashed?.hash ??
    createdLobby?.signed_action?.hash ??
    createdLobby?.action?.hash ??
    createdLobby?.actionHash;
  const publicHoloHash=(raw)=>{
    if(typeof raw==='string'&&raw.startsWith('u'))return raw;
    if(raw?.data&&Array.isArray(raw.data))raw=raw.data;
    if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&!(raw instanceof Uint8Array)){
      const keys=Object.keys(raw).sort((a,b)=>Number(a)-Number(b));
      if(keys.length&&keys.every((k,i)=>k===String(i)))raw=keys.map(k=>raw[k]);
    }
    const bytes=raw instanceof Uint8Array?raw:
      Array.isArray(raw)?Uint8Array.from(raw):null;
    return bytes?.length===39?hash(bytes):null;
  };
  evidence.host_lobby_record_shape={
    record_keys:Object.keys(createdLobby||{}),
    action_keys:Object.keys(createdLobby?.signed_action||{}),
    hashed_keys:Object.keys(createdLobby?.signed_action?.hashed||{})
  };
  const lobbyActionHash=publicHoloHash(lobbyHashCandidate);
  evidence.host_lobby_action_hash=lobbyActionHash;
  record('HOST_LOBBY_ACTION_HASH',lobbyActionHash?'PASS':'BLOCKED',
    lobbyActionHash||'create_lobby returned a Record but its action hash could not be parsed');

  // Independent browser profile means a fresh Lair keystore, source chain,
  // extension storage, WebSocket challenge, agent and authenticated DHT path.
  await step('INDEPENDENT_HWC_GUEST_IDENTITY_AND_APP',async()=>{
    const ext=path.join(HWC,'packages/extension/dist-chrome');
    guestProfile=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-hwc-guest-'));
    guestContext=await chromium.launchPersistentContext(guestProfile,{
      headless:false,viewport:{width:1100,height:800},
      args:['--disable-extensions-except='+ext,'--load-extension='+ext,
        '--no-first-run','--disable-default-apps','--no-sandbox',
        '--disable-dev-shm-usage']
    });
    const guestPage=guestContext.pages()[0]||await guestContext.newPage();
    await guestPage.goto(ORIGIN,{waitUntil:'domcontentloaded'});
    await guestPage.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),
      {timeout:45000});
    const agentBytes=await guestPage.evaluate(async()=>{
      await window.holochain.connect();
      return Array.from(new Uint8Array(window.holochain.myPubKey||[]));
    });
    must(agentBytes.length===39,'Guest Lair did not produce a full Holochain agent key');
    const agent=hash(agentBytes);
    must(agent!==host,'Guest unexpectedly shares the host signing identity');
    must(!(evidence.native_authority_config?.native_agents||[]).includes(agent),
      'Guest unexpectedly shares a native conductor identity');
    const linker=process.env.H2HC_BASE_URL||'http://127.0.0.1:8090';
    const admin=process.env.H2HC_LINKER_ADMIN_SECRET;
    must(Boolean(admin)&&admin.length>=32,'Operator credential missing for guest allowlist');
    const granted=await fetch(linker+'/admin/agents',{
      method:'POST',headers:{Authorization:'Bearer '+admin,
        'Content-Type':'application/json'},
      body:JSON.stringify({agent_pubkey:agent,
        capabilities:['dht_read','dht_write','k2'],label:'ephemeral-isolated-HWC-guest'})
    });
    must(granted.status===204,'Cannot allowlist genuine separate HWC guest: HTTP '+granted.status);
    const guestInstalled=await guestPage.evaluate(async(expected)=>{
      const hc=window.holochain;
      const response=await fetch('/imposter-browser-poc.happ',{cache:'no-store'});
      if(!response.ok)throw Error('Guest hApp fetch returned '+response.status);
      const bytes=new Uint8Array(await response.arrayBuffer());
      const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
        b=>b.toString(16).padStart(2,'0')).join('');
      if(sha!==expected)throw Error('Guest hApp checksum differs from host');
      await hc.installApp({bundle:bytes,installedAppId:'imposter-browser-poc'});
      const info=await hc.appInfo('imposter-browser-poc');
      if(info?.cells?.length!==1)throw Error('Guest did not install one expected cell');
      const b64=(v)=>{
        if(v?.data&&Array.isArray(v.data))v=v.data;
        if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Uint8Array))
          v=Object.keys(v).sort((a,b)=>Number(a)-Number(b)).map(k=>v[k]);
        const a=Uint8Array.from(v);
        if(a.length!==39)throw Error('Guest HoloHash has unexpected size');
        return 'u'+btoa(String.fromCharCode(...a)).replace(/\+/g,'-')
          .replace(/\//g,'_').replace(/=+$/,'');
      };
      return {agent:b64(info.agentPubKey),dna:b64(info.cells[0][0]),
        cell_agent:b64(info.cells[0][1])};
    },m.happ_bundle_sha256);
    must(guestInstalled.agent===agent&&guestInstalled.cell_agent===agent,
      'Installed guest cell author differs from Lair identity');
    must(guestInstalled.dna===m.dna_hash,
      'Guest is on a DIFFERENT DNA, not the host-bound Imposter network');
    await guestPage.evaluate(async(url)=>
      window.holochain.configureNetwork({linkerUrl:url}),linker);
    let status;
    for(let i=0;i<70;i++){
      status=await guestPage.evaluate(async()=>window.holochain.getConnectionStatus());
      if(status?.authenticated===true)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    must(status?.authenticated===true,
      'Guest did not authenticate HWC WS to H2HC');
    evidence.independent_guest={agent,dna:guestInstalled.dna,
      distinct_profile:true,authenticated:true,has_no_shared_browser_store:true};
    record('INDEPENDENT_HWC_GUEST_AUTHENTICATED','PASS',
      'Separate HWC browser/Lair identity; exact host DNA; signed H2HC session');
    evidence.guest_page_active=true;
    // This function reads the REAL Imposter game index through get_links
    // (network) and the linked records through get (network). It must not
    // read local host state or a queue fixture.
    let match=false,latest=null,firstError=null;
    for(let i=0;i<50;i++){
      try{
        const v=await guestPage.evaluate(async()=>window.holochain.callZome({
          zome_name:'game',fn_name:'get_game_state',payload:null
        }));
        latest={code:v?.code,player_count:v?.player_count,
          impostor_count:v?.impostor_count,is_host:v?.is_host,
          player_agents:Array.isArray(v?.players)?v.players.length:null,
          result_keys:Object.keys(v||{})};
        if(v?.code===m.network_seed&&v?.player_count===3&&
          v?.impostor_count===1&&v?.is_host===false){
          match=true;break;
        }
      }catch(err){firstError??=String(err).slice(0,300);}
      await new Promise(resolve=>setTimeout(resolve,1200));
    }
    evidence.independent_guest_lobby_view={matched:match,last:latest,
      first_error:firstError,
      proof:'game::get_game_state uses network GetLinks + network Get on independent guest'};
    record('INDEPENDENT_HWC_LOBBY_VIEW',match?'PASS':'BLOCKED',
      match?'Guest returned real public lobby code/config via network GetLinks/Get':
      'No matching public lobby observed in separate guest HWC during bounded poll');
  });

  // Do not exit at the first HTTP publish batch. Initial HWC operations may
  // be genesis or a partial chain; later lobby create/link ops can follow.
  await new Promise(resolve=>setTimeout(resolve,25000));
  const gatewayLog=fs.readFileSync(process.env.H2HC_SERVER_LOG,'utf8')
    .replace(/\u001b\[[0-9;]*m/g,'');
  const batches=[...gatewayLog.matchAll(
    /Publish request completed[^\n]*queued=(\d+)[^\n]*failed=(\d+)[^\n]*published=(\d+)/g)]
    .map(x=>({queued:Number(x[1]),failed:Number(x[2]),published:Number(x[3])}));
  evidence.h2hc_publish_batches=batches;
  const nativeLog=fs.readFileSync(path.join(OUT_LOG,'native-holochain-0.7.log'),'utf8')
    .replace(/\u001b\[[0-9;]*m/g,'');
  const incoming=[...nativeLog.matchAll(/incoming publish ops[^\n]*op_ids=\[([^\]]+)\]/g)]
    .flatMap(x=>x[1].split(',').map(s=>s.trim()));
  const processed=[...nativeLog.matchAll(/processed incoming ops with op ids \[([^\]]+)\]/g)]
    .flatMap(x=>x[1].split(',').map(s=>s.trim()));
  const incomingIds=[...new Set(incoming)];
  const fetchedIds=[...new Set(processed)];
  const retainedIds=incomingIds.filter(id=>fetchedIds.includes(id));
  const appAccepted=[...nativeLog.matchAll(
    /(\d+) out of (\d+) validated: (\d+) accepted, (\d+) awaiting deps, (\d+) rejected/g)]
    .map(x=>({accepted:Number(x[3]),awaiting:Number(x[4]),rejected:Number(x[5])}));
  evidence.native_wire_probe={incoming_op_hashes:incomingIds,
    native_fetched_op_hashes:fetchedIds,
    native_received_and_fetched:retainedIds,
    generic_app_validation_batches:appAccepted,
    note:'Per-operation validation status is not derivable from unlabelled workflow aggregates'};
  record('NATIVE_RECEIPT_AND_FETCH',retainedIds.length?'PASS':'BLOCKED',
    'Native HWC-origin publish and fetch op IDs: '+retainedIds.join(', '));
  // Read-only actual native SQLite DHT integration verdict by action and op.
  // Unlike workflow aggregate counters, this joins exact ChainOp -> Action.
  const dbAudit=spawnSync('python3',[
    'agent3-kit/ci/agent3-h2hc-kit/audit_native_dht.py',nativeRoot,
    host,lobbyActionHash||'null',...incomingIds],{
    cwd:ROOT,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024
  });
  if(dbAudit.status!==0){
    record('NATIVE_DHT_SQL_READONLY_AUDIT','BLOCKED',
      'Audit exited '+dbAudit.status+'; '+String(dbAudit.stderr||'').slice(-400));
  }else{
    evidence.native_dht_sql_audit=JSON.parse(dbAudit.stdout);
    const nativeRecords=Object.values(evidence.native_dht_sql_audit.conductors)
      .flatMap(c=>c.matched_ops);
    const integratedLobby=nativeRecords.filter(x=>
      x.matched_lobby_action&&x.exact_native_valid_integrated);
    evidence.native_valid_lobby_ops=integratedLobby;
    record('NATIVE_DHT_SQL_READONLY_AUDIT',nativeRecords.length?'PASS':'BLOCKED',
      'Exact hashed native operations matched: '+nativeRecords.length);
    record('NATIVE_INTEGRITY_FOR_LOBBY_ACTION',
      integratedLobby.length?'PASS':'BLOCKED',
      integratedLobby.length?
        'Exact lobby DhtOp validated locally and integrated by native conductor':
        'No exact native accepted+locally_validated+integrated lobby ChainOp row');
  }
  const getReqs=[...gatewayLog.matchAll(
    /Preparing GetReq message[^\\n]*msg_id=(\\d+)[^\\n]*hash=(uhCkk[^\\s]+)/g)]
    .filter(x=>x[2]===lobbyActionHash).map(x=>Number(x[1]));
  const getResponses=[...gatewayLog.matchAll(
    /Got GetRes response[^\\n]*msg_id=(\\d+)/g)].map(x=>Number(x[1]));
  const confirmedGetReqIds=getReqs.filter(x=>getResponses.includes(x));
  evidence.independent_exact_action_query={
    action_hash:lobbyActionHash,dna:m.dna_hash,guest_agent:evidence.independent_guest?.agent,
    native_targeted_get_req_ids:getReqs,native_replied_get_res_ids:confirmedGetReqIds,
    nonnull_game_lobby_view:Boolean(evidence.independent_guest_lobby_view?.matched)
  };
  const gotExact=confirmedGetReqIds.length>0 &&
    evidence.independent_guest_lobby_view?.matched &&
    evidence.native_valid_lobby_ops?.length>0;
  record('INDEPENDENT_EXACT_ACTION_GET',gotExact?'PASS':'BLOCKED',
    gotExact?
      'Distinct authenticated HWC guest requested exact host lobby action from native '+
       'and received GetRes plus matching non-null game::get_game_state':
      'Missing exact lobby native-valid row, GetRes correlation, or guest non-null lobby view');
  record('UNAUTHORIZED_GUEST_REJECTED','NOT RUN',
    'Do not confuse normal guest read access with an isolated invalid-op rejection proof');
"""
)
replace_once(
    " record('H2HC_AUTHENTICATED_CONVERGENCE','NOT RUN','Requires Agent 3 deployment + tested registration, not just cargo security CI');",
    """ record('H2HC_AUTHENTICATED_CONVERGENCE',
    evidence.independent_guest_lobby_view?.matched?'PARTIAL_VIEW_ONLY':'BLOCKED',
    'Strict exact action hash/native validity/negative-op requirements remain open');"""
)
replace_once(
    " if(nativeConductor?.pid){",
    """ if(guestContext)await guestContext.close().catch(()=>{});
  if(guestProfile)fs.rmSync(guestProfile,{recursive:true,force:true});
  if(nativeConductor?.pid){"""
)
p.write_text(s)
print('Injected independent authenticated guest DHT read and per-op native log probe',p)
