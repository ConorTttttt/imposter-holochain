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

"""
# Keep the saved bearer in the offscreen closure only, not in extension storage.
decl = "let agent2CiSavedBearer: string | null = null;\n"
first = original.find("chrome.runtime.onMessage.addListener(\n  (\n    message: any,")
assert first >= 0, "Offscreen receiver declaration drift"
changed = original[:first] + decl + original[first:]
changed = changed.replace(anchor, probe + anchor, 1)
offscreen.write_text(changed)

src = bridge.read_text()
begin = "           await step('AGENT2_SERVER_SIDE_AGENT_SESSION_REVOCATION',async()=>{"
after_delete = "           await step('AGENT2_REVOKED_BROWSER_SESSION_INVALIDATES',async()=>{"
end = "           record('AGENT2_TRUE_TOKEN_EXPIRY','NOT RUN',"
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
src = src.replace(after_delete, after + after_delete, 1)
src = src.replace(end, restore + end, 1)
bridge.write_text(src)
print("Injected status-only offscreen protected-HTTP revocation probe and reauthorization gates")
