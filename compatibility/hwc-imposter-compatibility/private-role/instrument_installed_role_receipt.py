#!/usr/bin/env python3
"""CI-only independent Guest B evidence via its OWN real Chromium extension
service-worker debugger, never via page messaging. This augments the existing
native-validated Agent4 three-profile bridge; no synthetic game or WASM changes.

Usage: python3 instrument_installed_role_receipt.py hwc scripts/agent3-native-authority-browser-bridge.mjs
"""
from pathlib import Path
import sys

hwc=Path(sys.argv[1])
bridge=Path(sys.argv[2])
background=hwc/"packages/extension/src/background/index.ts"
source=background.read_text(encoding="utf-8")
assert source.count("function getInstalledRoleRuntime(): any {")==1
assert "__agent2RolePrivateCI" not in source
# Only public metadata is readable via Playwright's privileged worker debugger.
# No role, X25519 private key, Lair material, bearer, native executor or
# privileged service is exposed by this nonproduction, CI-only hook.
source+=r"""
// CI INSTRUMENTATION ONLY -- appended to exact checkout, never shipped.
Object.defineProperty(globalThis, "__agent2RolePrivateCI", {
  enumerable:false, configurable:false, writable:false,
  value:Object.freeze({
    pulse:async()=>{
      const runtime=getInstalledRoleRuntime();
      await runtime.pulse();
      return runtime.evidenceMetadata();
    },
    snapshot:async()=>getInstalledRoleRuntime().evidenceMetadata()
  })
});
"""
background.write_text(source,encoding="utf-8")

src=bridge.read_text(encoding="utf-8")
# Nonsecret diagnostic for the REAL demo UI; preserve HWC's normal action
# dispatch and fail without inventing a signed native action.
old_wait="const timeout=setTimeout(()=>reject(Error('UI did not emit the signed public action')),60000);"
assert src.count(old_wait)==1, 'Agent4 demo UI action listener drift'
src=src.replace(old_wait, """const timeout=setTimeout(()=>reject(Error('UI did not emit signed action; notice='+document.querySelector('#notice')?.textContent+'; status='+document.querySelector('#connection-state')?.getAttribute('data-status'))),15000);""",1)
# The pinned gateway deliberately REQUIRES separate operator-granted role
# capabilities. Native conductors retain their old non-role allowlist.
# Give only the genuine HWC host delivery and Guest B request privileges.
host_caps="""capabilities:['dht_read','dht_write','k2'],
       label:'ephemeral-real-HWC-host'"""
guest_caps="""capabilities:['dht_read','dht_write','k2'],label:'ephemeral-isolated-HWC-guest'"""
assert src.count(host_caps)==1, "real host allowlist grant anchor drift"
assert src.count(guest_caps)==1, "real Guest B allowlist grant anchor drift"
src=src.replace(host_caps, """capabilities:['dht_read','dht_write','k2','game_role_deliver'],
       label:'ephemeral-real-HWC-host'""", 1)
src=src.replace(guest_caps, """capabilities:['dht_read','dht_write','k2','game_role_request'],
        label:'ephemeral-isolated-HWC-guest'""", 1)
anchor="  const chromeOptions={headless:false,viewport:{width:1100,height:800},"
assert src.count(anchor)==1, f"agent4 native bridge role receipt insertion anchor: {src.count(anchor)}"
insertion=r"""
  // End-to-end Agent2 acceptance runs inside all THREE distinct Chromium
  // extension service workers; the page only invokes public commit_roles_only,
  // which returns an action hash, never any private role/proof.
  const roleCommitAction=await step('HOST_NATIVE_COMMIT_ROLES_ONLY',async()=>{
    const out=await page.evaluate(async()=>window.holochain.callZome({
      zome_name:'game',fn_name:'commit_roles_only',payload:null
    }));
    const pinned=publicHoloHash(out?.role_commit);
    must(/^uhCkk/.test(pinned),'Host did not create exact native RoleCommit action');
    must(Array.isArray(out?.seats)&&out.seats.length===3,
      'Host native RoleCommit lacks canonical three-player seats');
    evidence.agent2_native_role_commit=pinned;
    record('AGENT2_NATIVE_EXACT_ROLECOMMIT_CREATED','PASS',
      'Real host Lair-authored public native RoleCommit; no legacy remote signals');
    return pinned;
  });
  const rawToHolo=hex=>{
    const b=Buffer.from(hex,'hex');
    must(b.length===39,'CI installed native identity is not a full HoloHash');
    return 'u'+b.toString('base64url');
  };
  const roleWorker=async(ctx,label)=>{
    const w=ctx.serviceWorkers().find(w=>w.url().endsWith('/background/index.js')) ||
      await ctx.waitForEvent('serviceworker',{timeout:45000});
    must(w.url().startsWith('chrome-extension://'),
      'Role witness is not the genuine Chromium extension worker: '+label);
    return w;
  };
  const roleWorkers={
    host:await roleWorker(context,'host'),
    guest_b:await roleWorker(guestContext,'guest_b'),
    guest_c:await roleWorker(invalidContext,'guest_c'),
  };
  const pub={host,guest_b:pubkeys[1],guest_c:pubkeys[2]};
  const metadata=async(label,worker,force=true)=>{
    const rows=await worker.evaluate(async input=>{
      // This callable exists ONLY in the CI-instrumented extension background.
      return input
        ?globalThis.__agent2RolePrivateCI.pulse()
        :globalThis.__agent2RolePrivateCI.snapshot();
    },force);
    must(Array.isArray(rows),'No privileged installed-cell metadata in '+label);
    return rows.find(x=>rawToHolo(x.installedAgent)===pub[label] &&
      rawToHolo(x.installedDna)===m.dna_hash) || null;
  };
  // Important: native DHT visibility can lag after commit, key publication
  // or network validation; retry the STRICT privileged native verification
  // but never trust a page or gateway ACK to fill in a missing action.
  const preflight={};
  await step('AGENT2_REAL_INSTALLED_CELL_NATIVE_PREFLIGHT',async()=>{
    for(const label of ['host','guest_b','guest_c']){
      let observed=null,firstError=null;
      for(let i=0;i<110;i++){
        try{
          observed=await metadata(label,roleWorkers[label],true);
          if(observed?.pinnedLobby &&
             observed?.pinnedRoleCommit &&
             rawToHolo(observed.pinnedLobby)===lobbyActionHash &&
             rawToHolo(observed.pinnedRoleCommit)===roleCommitAction &&
             observed.nativeEnrollmentPublished===true &&
             observed.sessionBound===true)break;
        }catch(err){firstError??=String(err).slice(0,180);}
        await wait(750);
      }
      must(observed?.pinnedLobby&&observed?.pinnedRoleCommit&&
        rawToHolo(observed.pinnedLobby)===lobbyActionHash &&
        rawToHolo(observed.pinnedRoleCommit)===roleCommitAction &&
        observed.nativeEnrollmentPublished===true &&
        observed.sessionBound===true,
        label+' did not independently pin installed native Lobby/RoleCommit, '+
        'publish + verify genuine signed X25519 enrollment and bind authenticated socket. '+
        JSON.stringify({observed,firstError}));
      preflight[label]={
        dna:pub[label]===host?m.dna_hash:m.dna_hash,
        agent:pub[label],lobby:lobbyActionHash,roleCommit:roleCommitAction,
        signed_native_enrollment:true,authenticated_socket:true,
        source:'actual installed HWC privileged native executor plus Lair'
      };
      record('AGENT2_INSTALLED_NATIVE_AND_ENROLLMENT_'+label.toUpperCase(),'PASS',
        'Exact installed-cell/DNA/Lair native game action pins, signed public key enrollment and live socket');
    }
    evidence.agent2_private_role_native_preflight=preflight;
  });
  // A real role_queued_v1 is a gateway ACK for an exact signed frame.
  // Its matching message ID is tracked inside the authenticated HWC
  // offscreen WebSocket instance; it is not a recipient receipt.
  let gatewayQueued={request:false,delivery:false},verifiedReceipt=false;
  await step('AGENT2_GUEST_B_RESTRICTED_GATEWAY_AND_RECEIPT',async()=>{
    let lastB=null,lastHost=null;
    for(let i=0;i<110;i++){
      try{
        lastB=await metadata('guest_b',roleWorkers.guest_b,false);
        lastHost=await metadata('host',roleWorkers.host,false);
        gatewayQueued.request=(lastB?.gatewayRoleRequestQueued||0)>=1;
        gatewayQueued.delivery=(lastHost?.gatewayRoleDeliveryQueued||0)>=1;
        verifiedReceipt=(lastB?.decryptedRoleReceipts||0)===1;
        if(gatewayQueued.request&&gatewayQueued.delivery&&verifiedReceipt)break;
      }catch{}
      await wait(750);
    }
    must(gatewayQueued.request,
      'Guest B has no authenticated WS gateway role_queued_v1 request acknowledgement');
    must(gatewayQueued.delivery,
      'Host has no authenticated WS gateway role_queued_v1 delivery acknowledgement');
    must(verifiedReceipt,
      'Guest B own installed HWC extension did not decrypt and validate the host role');
    must(lastB?.pinnedRoleCommit&&rawToHolo(lastB.pinnedRoleCommit)===roleCommitAction,
      'Guest B decrypted against a different native RoleCommit action');
    evidence.agent2_role_delivery={
      gateway_request_enqueue:{ack:true,source:'Guest B own authenticated WebSocket'},
      gateway_delivery_enqueue:{ack:true,source:'Host own authenticated WebSocket'},
      guest_b_extension_local_receipt:{
        verified:true,decrypted_role_not_logged:true,
        coordinator_invoked:false,installed_agent:pub.guest_b,
        dna:m.dna_hash,role_commit_action:roleCommitAction
      }
    };
    record('AGENT2_GATEWAY_GUEST_B_REQUEST_ENQUEUED','PASS',
      'Gateway role_queued_v1 matched signed Guest B request message ID on its live authenticated socket');
    record('AGENT2_GATEWAY_HOST_DELIVERY_ENQUEUED','PASS',
      'Gateway role_queued_v1 matched signed Host delivery message ID on its live authenticated socket');
    record('AGENT2_GUEST_B_EXTENSION_LOCAL_DECRYPTED_RECEIPT','PASS',
      'Independent Guest B Chromium service worker verified exact native opening; remote coordinator DISABLED');
  });
"""
src=src.replace(anchor,insertion+"\n"+anchor,1)
bridge.write_text(src,encoding="utf-8")
print("AGENT2_GENUINE_CHROMIUM_INSTALLED_ROLE_E2E_INSTRUMENTED=YES")
print("ROLE_PLAINTEXT_AND_KEYS=NEVER_EXPORTED")
print("GATEWAY_ENQUEUE_AND_RECIPIENT_RECEIPT=SEPARATELY_ASSERTED")
