#!/usr/bin/env python3
"""CI-only HWC/H2HC acceptance probes; never part of the accepted HWC patch.

The original HWC patch remains pinned. This script instruments only the
throwaway runner checkout. The former browser bearer is held *inside* the
privileged offscreen document for two HTTP requests; it is never serialized,
returned to a page, printed, or written to an artifact.
"""
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: agent2-security-acceptance-inject.py HWC_DIR BRIDGE_JS")
hwc = Path(sys.argv[1])
bridge = Path(sys.argv[2])
offscreen = hwc / "packages/extension/src/offscreen/index.ts"
original = offscreen.read_text()
anchor = '    if (message.type === "GET_WS_STATE") {'
assert original.count(anchor) == 1, "Offscreen handler anchor drift"

probe = r"""
    // Agent2 test-only: no bearer is exposed to JS outside the offscreen
    // extension document. Never commit this temporary hook to production HWC.
    if (message.type === "AGENT2_CI_PROTECTED_HTTP_PROBE") {
      (async () => {
        const phase = message.phase;
        if (phase !== "before" && phase !== "after" && phase !== "fresh") {
          sendResponse({ success: false, error: "INVALID_PHASE" } as any); return;
        }
        if (phase === "before") agent2CiSavedBearer = sessionToken;
        const bearer = phase === "after" ? agent2CiSavedBearer : sessionToken;
        if (phase === "after") agent2CiSavedBearer = null;
        if (!bearer || !linkerUrl || typeof message.dna !== "string" ||
            !/^uhC0k[A-Za-z0-9_-]{48}$/.test(message.dna)) {
          sendResponse({ success: false, error: "MISSING_AUTH_OR_DNA" } as any); return;
        }
        // Intentional invalid record ID: authorization must precede record
        // parsing and any native DHT lookup. Status only is returned.
        const url = linkerUrl.replace(/\/$/, "") +
          "/dht/" + encodeURIComponent(message.dna) +
          "/record/invalid-action-hash";
        try {
          const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: "Bearer " + bearer },
            signal: AbortSignal.timeout(10000),
          });
          sendResponse({ success: true, status: res.status } as any);
        } catch {
          sendResponse({ success: false, error: "PROTECTED_REQUEST_FAILED" } as any);
        }
      })();
      return true;
    }


    // Real Chromium HWC WebSocket parser + original Lair signer callback:
    // inject the foreign-DNA server frame, intercept any response inside
    // offscreen, and return only whether a signing attempt was denied.
    if (message.type === "AGENT2_CI_FOREIGN_DNA_SIGN") {
      if (!wsService?.isAuthenticated() || !wsService?.isConnected() ||
          typeof message.agent !== "string") {
        sendResponse({ success: false, error: "NOT_AUTHENTICATED" } as any);
        return true;
      }
      const service = wsService as any;
      const id = "agent2-ci-foreign-dna";
      const raw = Uint8Array.from(atob(message.agent.slice(1).replace(/-/g, "+").replace(/_/g, "/")),
        c => c.charCodeAt(0));
      if (raw.length !== 39) {
        sendResponse({ success: false, error: "INVALID_AGENT" } as any);
        return true;
      }
      const encodeCore = (value: Uint8Array) =>
        btoa(String.fromCharCode(...value)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
      const now = BigInt(Date.now()) * 1000n;
      const request = {
        type: "sign_agent_info", request_id: id, agent_pubkey: message.agent,
        agent_info: {
          agent: encodeCore(raw.slice(3, 35)),
          space: encodeCore(new Uint8Array(32).fill(123)),
          createdAt: now.toString(),
          expiresAt: (now + 1200000000n).toString(),
          isTombstone: false,
          url: linkerUrl.replace(/^http/, "ws").replace(/\\/$/, "") + "/ws",
          storageArc: null
        }
      };
      const originalSend = service.send.bind(service);
      let complete = false;
      service.send = (packet: any) => {
        if (packet?.type === "sign_response" && packet.request_id === id) {
          complete = true;
          // Never return signature bytes. A defective signer must not send a
          // forged request's response to the real H2HC WebSocket, either.
          sendResponse({
            success: true, denied: !!packet.error && !packet.signature,
            attemptedSignature: !!packet.signature
          } as any);
          return;
        }
        originalSend(packet);
      };
      service.handleMessage({ data: JSON.stringify(request) });
      setTimeout(() => {
        if (!complete) {
          sendResponse({ success: false, error: "NO_SIGN_RESPONSE" } as any);
        }
      }, 8000);
      return true;
    }

    // The authenticated B socket attempts to register A. It must receive a
    // denial from the *real* H2HC server; no bearer leaves the guest extension.
    if (message.type === "AGENT2_CI_FOREIGN_REGISTRATION") {
      const socket = (wsService as any)?.ws as WebSocket | undefined;
      if (!wsService?.isConnected() || !wsService?.isAuthenticated() ||
          !socket || socket.readyState !== WebSocket.OPEN) {
        sendResponse({ success: false, error: "GUEST_NOT_AUTHENTICATED" } as any);
        return true;
      }
      let completed = false;
      const onMessage = (event: MessageEvent) => {
        try {
          const response = JSON.parse(String(event.data));
          if (response.type !== "error") return;
          if (completed) return;
          completed = true;
          socket.removeEventListener("message", onMessage);
          wsService?.unregisterAgent(message.dna, message.foreignAgent);
          sendResponse({ success: true, rejected: true } as any);
        } catch {}
      };
      socket.addEventListener("message", onMessage);
      wsService.registerAgent(message.dna, message.foreignAgent);
      setTimeout(() => {
        if (completed) return;
        completed = true;
        socket.removeEventListener("message", onMessage);
        wsService?.unregisterAgent(message.dna, message.foreignAgent);
        sendResponse({ success: true, rejected: false } as any);
      }, 6000);
      return true;
    }

"""
# Keep the saved bearer in the offscreen closure only, not in extension storage.
decl = "let agent2CiSavedBearer: string | null = null;\n"
first = original.find("chrome.runtime.onMessage.addListener(\n  (\n    message: any,")
assert first >= 0, "Offscreen receiver declaration drift"
changed = original[:first] + decl + original[first:]
changed = changed.replace(anchor, probe + anchor, 1)
offscreen.write_text(changed)

src = bridge.read_text()
begin = "await step('AGENT2_SERVER_SIDE_AGENT_SESSION_REVOCATION',async()=>{"
after_delete = "await step('AGENT2_REVOKED_BROWSER_SESSION_INVALIDATES',async()=>{"
end = "record('AGENT2_TRUE_TOKEN_EXPIRY','NOT RUN',"
for a in (begin, after_delete, end):
    assert src.count(a) == 1, "Bridge injection anchor drift: " + a

setup = r"""
           // Invoke the protected endpoint only from the real extension
           // offscreen document. The test sees status codes, NEVER a bearer.
           const agent2Probe = async phase => {
             const worker = context.serviceWorkers()[0] ||
               await context.waitForEvent('serviceworker',{timeout:15000});
             const answer = await worker.evaluate(async ({dna,phase}) =>
               chrome.runtime.sendMessage({
                 target:'offscreen',type:'AGENT2_CI_PROTECTED_HTTP_PROBE',
                 dna,phase
               }),{dna:m.dna_hash,phase});
             must(answer?.success === true,
               'Privileged bearer probe failed without disclosing credentials: ' +
               String(answer?.error || 'NO_RESPONSE'));
             must(Number.isInteger(answer.status),
               'Server did not provide a protected HTTP status');
             return answer.status;
           };
           await step('AGENT2_PROTECTED_HTTP_BEFORE_REVOCATION',async()=>{
             const status = await agent2Probe('before');
             evidence.agent2_protected_http_before = status;
             must(status !== 401 && status !== 403,
               'The browser bearer was not authorized before revocation: '+status);
           });

"""
after = r"""
           await step('AGENT2_PROTECTED_HTTP_AFTER_REVOCATION',async()=>{
             const status = await agent2Probe('after');
             evidence.agent2_protected_http_after = status;
             // Old bearer deliberately retained ONLY within test-only offscreen
             // closure so this remains meaningful if WebSocket already closed.
             must(status === 401,
               'Revoked bearer still accepted by protected H2HC HTTP: '+status);
           });

"""
restore = r"""
           await step('AGENT2_REVOKED_IDENTITY_CANNOT_REAUTHENTICATE',async()=>{
             // In addition to the WS close, the removed allowlist identity must
             // not receive another signed session during reconnect attempts.
             for(let i=0;i<12;i++){
               const status = await lifecycleStatus();
               must(status.connection?.authenticated !== true &&
                    status.network?.hasSession !== true,
                 'Revoked Lair identity reauthenticated without allowlisting');
               await new Promise(r=>setTimeout(r,500));
             }
           });
           await step('AGENT2_REAUTHORIZE_FRESH_SIGNED_CHALLENGE',async()=>{
             const secret=process.env.H2HC_LINKER_ADMIN_SECRET;
             const r=await fetch(process.env.H2HC_BASE_URL+'/admin/agents',{
               method:'POST',
               headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
               body:JSON.stringify({
                 agent_pubkey:host,
                 capabilities:['dht_read','dht_write','k2'],
                 label:'ephemeral-reauthorized-hwc-host'
               })
             });
             must(r.status===204,'Failed to restore operator allowlist: '+r.status);
             await waitForSession(true);
             const status=await agent2Probe('fresh');
             must(status!==401 && status!==403,
               'New signed browser session cannot authorize HTTP: '+status);
             evidence.agent2_reauthorization='FRESH_H2HC_SIGNED_SESSION';
           });

"""
src = src.replace(begin, setup + begin, 1)

extra = r"""
           await step('AGENT2_REAL_CHROMIUM_FOREIGN_DNA_SIGNING_REJECTED', async()=>{
             const worker = context.serviceWorkers()[0] ||
               await context.waitForEvent('serviceworker',{timeout:15000});
             const response = await worker.evaluate(async agent =>
               chrome.runtime.sendMessage({
                 target:'offscreen',type:'AGENT2_CI_FOREIGN_DNA_SIGN',agent
               }),host);
             must(response?.success === true && response?.denied === true &&
                  response?.attemptedSignature !== true,
               'Actual browser WS signer did not deny unregistered foreign DNA');
             evidence.agent2_foreign_dna='BROWSER_WS_HANDLER_DENIED_NO_LAIR_SIGNATURE';
           });
           await step('AGENT2_PERSISTED_LINKER_CONFIG_HAS_NO_CREDENTIALS',async()=>{
             const worker=context.serviceWorkers()[0] ||
               await context.waitForEvent('serviceworker',{timeout:15000});
             const keys=await worker.evaluate(async()=>{
               const value=(await chrome.storage.local.get('hwc_linker_config')).hwc_linker_config;
               return Object.keys(value||{});
             });
             must(keys.length===1 && keys[0]==='linkerUrl',
               'Persisted linker configuration contains more than the endpoint URL');
           });
           await step('AGENT2_TWO_GENUINE_LAIR_IDENTITIES_CROSS_REGISTER_DENIED',async()=>{
             const guestProfile=fs.mkdtempSync(path.join(os.tmpdir(),'agent2-lair-guest-'));
             let guestContext;
             try {
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
               const other=await guestPage.evaluate(async()=>{
                 const hc=window.holochain;
                 await hc.connect();
                 return 'u'+btoa(String.fromCharCode(...new Uint8Array(hc.myPubKey||[])))
                   .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
               });
               must(/^uhCAk[A-Za-z0-9_-]{48}$/.test(other) && other!==host,
                 'Second browser was not a distinct real Lair signer');
               const secret=process.env.H2HC_LINKER_ADMIN_SECRET;
               const allow=await fetch(process.env.H2HC_BASE_URL+'/admin/agents',{
                 method:'POST',
                 headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
                 body:JSON.stringify({
                   agent_pubkey:other,capabilities:['dht_read','dht_write','k2'],
                   label:'independent-ci-lair-guest'
                 })
               });
               must(allow.status===204,'Could not allowlist genuine second Lair identity');
               await guestPage.evaluate(async digest=>{
                 const res=await fetch('/imposter-browser-poc.happ',{cache:'no-store'});
                 if(!res.ok)throw Error('Guest hApp unavailable');
                 const bundle=new Uint8Array(await res.arrayBuffer());
                 const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bundle)),
                   b=>b.toString(16).padStart(2,'0')).join('');
                 if(actual!==digest)throw Error('Guest hApp bytes differ');
                 await window.holochain.installApp({bundle,installedAppId:'imposter-browser-poc'});
               },m.happ_bundle_sha256);
               await guestPage.evaluate(async url =>
                 window.holochain.configureNetwork({linkerUrl:url}),process.env.H2HC_BASE_URL);
               let ready=false;
               for(let i=0;i<100;i++){
                 const statuses=await guestPage.evaluate(async()=>({
                   connection:await window.holochain.getConnectionStatus(),
                   network:await window.holochain.getNetworkStatus()
                 }));
                 if(statuses.connection?.authenticated===true &&
                    statuses.network?.hasSession===true){ready=true;break;}
                 await new Promise(r=>setTimeout(r,500));
               }
               must(ready,'Independent Lair guest did not authenticate H2HC');
               const guestWorker=guestContext.serviceWorkers()[0] ||
                 await guestContext.waitForEvent('serviceworker',{timeout:15000});
               const denied=await guestWorker.evaluate(async data =>
                 chrome.runtime.sendMessage({
                   target:'offscreen',type:'AGENT2_CI_FOREIGN_REGISTRATION',
                   dna:data.dna,foreignAgent:data.foreignAgent
                 }),{dna:m.dna_hash,foreignAgent:host});
               must(denied?.success===true && denied.rejected===true,
                 'Real H2HC allowed guest-B WebSocket to register host-A identity');
               evidence.agent2_two_real_lair='TWO_DISTINCT_SIGNERS_SERVER_REJECTED_FOREIGN_WS_REGISTER';
             } finally {
               if(guestContext)await guestContext.close().catch(()=>{});
               fs.rmSync(guestProfile,{recursive:true,force:true});
             }
           });
"""
src = src.replace(begin, extra + begin, 1)
src = src.replace(after_delete, after + after_delete, 1)
src = src.replace(end, restore + end, 1)
bridge.write_text(src)
print("Injected status-only offscreen protected-HTTP revocation probe and reauthorization gates")
