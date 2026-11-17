#!/usr/bin/env python3
"""Controlled integrity-invalid Imposter lobby from a THIRD isolated HWC identity.

Only instruments the generated ephemeral CI JavaScript. No app integrity code,
published HWC code or H2HC gateway changes. The malicious author is NOT the
host encoded in the existing host-bound g1.* seed, so the original native Rust
game_integrity::validate_entry must reject a Lobby that this author creates.
"""
from pathlib import Path
import sys

p=Path(sys.argv[1])
s=p.read_text()

def replace(old,new):
    global s
    n=s.count(old)
    if n!=1:
        raise SystemExit(f"negative probe anchor drift {n}: {old[:90]!r}")
    s=s.replace(old,new,1)

replace(
    'let context,server,artifactDir,nativeConductor,nativeRoot,guestContext,guestProfile;',
    'let context,server,artifactDir,nativeConductor,nativeRoot,guestContext,guestProfile,invalidContext,invalidProfile;'
)
replace(
    '  // Do not exit at the first HTTP publish batch.',
    r"""
  await step('INVALID_GAME_LOBBY_ISOLATED_THIRD_HWC_IDENTITY',async()=>{
    // Deliberately use a distinct keystore and Chrome storage for the negative
    // test. This is neither the host nor the independent read-only guest.
    const ext=path.join(HWC,'packages/extension/dist-chrome');
    invalidProfile=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-hwc-invalid-'));
    invalidContext=await chromium.launchPersistentContext(invalidProfile,{
      headless:false,viewport:{width:1000,height:700},
      args:['--disable-extensions-except='+ext,'--load-extension='+ext,
       '--no-first-run','--disable-default-apps','--no-sandbox','--disable-dev-shm-usage']
    });
    const invalidPage=invalidContext.pages()[0]||await invalidContext.newPage();
    await invalidPage.goto(ORIGIN,{waitUntil:'domcontentloaded'});
    await invalidPage.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),
      {timeout:45000});
    const agentBytes=await invalidPage.evaluate(async()=>{
      await window.holochain.connect();
      return Array.from(new Uint8Array(window.holochain.myPubKey||[]));
    });
    must(agentBytes.length===39,'Isolated negative test lacks genuine Lair author');
    const agent=hash(agentBytes);
    must(agent!==host&&agent!==evidence.independent_guest?.agent,
      'Negative test agent MUST differ from real host and independent reader');
    const linker=process.env.H2HC_BASE_URL||'http://127.0.0.1:8090';
    const admin=process.env.H2HC_LINKER_ADMIN_SECRET;
    const grant=await fetch(linker+'/admin/agents',{
      method:'POST',headers:{Authorization:'Bearer '+admin,
        'Content-Type':'application/json'},
      body:JSON.stringify({agent_pubkey:agent,
        capabilities:['dht_read','dht_write','k2'],
        label:'CI-controlled-integrity-invalid-lobby-author'})
    });
    must(grant.status===204,'Cannot authorize isolated negative author '+grant.status);
    const installed=await invalidPage.evaluate(async(expected)=>{
      const hc=window.holochain;
      const data=new Uint8Array(await (await fetch('/imposter-browser-poc.happ')).arrayBuffer());
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),
        b=>b.toString(16).padStart(2,'0')).join('');
      if(actual!==expected)throw Error('Negative identity hApp SHA mismatch');
      await hc.installApp({bundle:data,installedAppId:'imposter-browser-poc'});
      const info=await hc.appInfo('imposter-browser-poc');
      const b64=v=>{
        if(v?.data&&Array.isArray(v.data))v=v.data;
        if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Uint8Array))
          v=Object.keys(v).sort((a,b)=>Number(a)-Number(b)).map(k=>v[k]);
        const bytes=Uint8Array.from(v);
        if(bytes.length!==39)throw Error('Invalid native hash from third HWC');
        return 'u'+btoa(String.fromCharCode(...bytes))
          .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      };
      return {dna:b64(info.cells[0][0]),agent:b64(info.cells[0][1])};
    },m.happ_bundle_sha256);
    must(installed.dna===m.dna_hash&&installed.agent===agent,
      'Invalid author must still use exact host DNA and own genuine Lair key');
    await invalidPage.evaluate(async(url)=>window.holochain.configureNetwork({linkerUrl:url}),linker);
    let status;
    for(let i=0;i<70;i++){
      status=await invalidPage.evaluate(async()=>window.holochain.getConnectionStatus());
      if(status?.authenticated===true)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    must(status?.authenticated,'Invalid author must be H2HC-authenticated before publishing');
    // The *UNCHANGED* game_integrity validator rejects a Lobby whose g1 seed
    // encodes a different host than the signed action's author. HWC's
    // create_entry signs it using this isolated Lair identity.
    let actionHash=null,callError=null;
    try{
      const candidate=await invalidPage.evaluate(async(seed)=>
        window.holochain.callZome({zome_name:'game',fn_name:'create_lobby',
          payload:{code:seed,player_count:3,impostor_count:1,
            task_target:1,display_name:'INVALID AUTHOR CI'}}),m.network_seed);
      actionHash=publicHoloHash(
        candidate?.signed_action?.hashed?.hash ??
        candidate?.signed_action?.hash ??
        candidate?.actionHash);
    }catch(err){callError=String(err).slice(0,400);}
    evidence.negative_isolated_agent=agent;
    evidence.negative_test={
      dna:m.dna_hash,author:agent,lobby_action_hash:actionHash,
      call_error:callError,real_hwc_lair:true,
      authenticated_transport:true,independent_profile:true,
      test_type:'game_integrity Lobby host seed != action author',
      integrity_wasm:'UNCHANGED'
    };
    record('ISOLATED_INVALID_HWC_AUTHOR',
      actionHash?'PASS':'AT_RISK',
      actionHash?
        'Original real game::create_lobby returned an invalid-host lobby action hash':
        'Negative zome call did not return action hash; native author-op audit needed');
  });
  // Do not exit at the first HTTP publish batch."""
)
replace(
    "    host,lobbyActionHash||'null',...incomingIds],{",
    "    host,lobbyActionHash||'null',...incomingIds,'--invalid-agent',evidence.negative_isolated_agent||'null'],{"
)
replace(
    "  record('UNAUTHORIZED_GUEST_REJECTED','NOT RUN',",
    r"""  const allNativeRows=Object.values(evidence.native_dht_sql_audit?.conductors||{})
    .flatMap(x=>x.matched_ops);
  const invalidRows=allNativeRows.filter(x=>
    x.matches_negative_author===true&&x.seq>=4);
  const invalidRejected=invalidRows.some(x=>
    x.table==='ChainOp'&&x.validation_status===2&&x.locally_validated===1 ||
    x.table==='LimboChainOp'&&(
      x.app_validation_status===2||x.sys_validation_status===2));
  const invalidAccepted=invalidRows.some(x=>
    x.table==='ChainOp'&&x.validation_status===1&&x.locally_validated===1);
  evidence.negative_native_result={
    author:evidence.negative_isolated_agent,
    matched_post_genesis_op_count:invalidRows.length,
    rejected:invalidRejected,accepted:invalidAccepted,
    matched_op_hashes:invalidRows.map(x=>x.op_hash),
    native_rows:invalidRows
  };
  record('NATIVE_INTEGRITY_INVALID_LOBBY_REJECTION',
    invalidRejected&&!invalidAccepted?'PASS':'BLOCKED',
    invalidRejected&&!invalidAccepted?
      'Isolated signed invalid-game-lobby chain action rejected by native integrity':
      invalidAccepted?
        'SECURITY REGRESSION: native conductor accepted an invalid-author lobby':
        'No conclusive exact native invalid-app rejection (may be pre-commit or awaiting deps)');
  record('UNAUTHORIZED_GUEST_REJECTED','NOT RUN',"""
)
replace(
    " const publication=evidence.h2hc_dht_result;",
    r"""  // The job may only return success with all three independently anchored
  // proofs, including native negative validation. Never accept generic counters.
  const allP0Green=
    evidence.checks.NATIVE_INTEGRITY_FOR_LOBBY_ACTION?.result==='PASS' &&
    evidence.checks.INDEPENDENT_EXACT_ACTION_GET?.result==='PASS' &&
    evidence.checks.NATIVE_INTEGRITY_INVALID_LOBBY_REJECTION?.result==='PASS' &&
    evidence.checks.INDEPENDENT_HWC_GUEST_AUTHENTICATED?.result==='PASS';
  if(allP0Green){
    record('NATIVE_DHT_END_TO_END','PASS',
      'Genuine host lobby validated+integrated by native 0.7, distinct HWC agent '+
      'retrieved exact hash and body; third authenticated invalid author natively rejected');
    return;
  }
  const publication=evidence.h2hc_dht_result;"""
)
replace(
    " if(guestContext)await guestContext.close().catch(()=>{});",
    """ if(invalidContext)await invalidContext.close().catch(()=>{});
  if(invalidProfile)fs.rmSync(invalidProfile,{recursive:true,force:true});
  if(guestContext)await guestContext.close().catch(()=>{});"""
)
p.write_text(s)
print('Added isolated HWC invalid-app-author probe to generated native JS:',p)
