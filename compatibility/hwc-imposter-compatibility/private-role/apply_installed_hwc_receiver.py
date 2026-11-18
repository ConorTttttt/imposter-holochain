#!/usr/bin/env python3
"""Extension-only restricted-role receiver after the accepted HWC patch AND
the staged authenticated-WebSocket patch. No generic remote coordinator route.

Applied to the exact upstream commit; does not mutate apply.py or its migration.
"""
import argparse
import difflib
from pathlib import Path
import subprocess
from apply_restricted_hwc_handler import replace_once, UPSTREAM

PRIVATE_FILES = (
    "hpke.mjs", "wire.mjs", "merkle.mjs", "store.mjs",
    "native-state.mjs", "native-authority.mjs", "native-enrollment.mjs",
    "installed-cell.mjs", "installed-native-enrollment.mjs",
    "request-attestation.mjs", "trusted-receiver.mjs",
    "hwc-installed-runtime.mjs",
)

def build_changes(root: Path) -> list[tuple[Path, str, str]]:
    changes = []
    def edit(path: str, old: str, new: str):
        f = root / path
        prior = next((newer for p, _, newer in changes if p == f), None)
        initial = f.read_text(encoding="utf-8") if prior is None else prior
        after = replace_once(initial, old, new, path)
        for i, (p, original, _) in enumerate(changes):
            if p == f:
                changes[i] = (f, original, after)
                break
        else:
            changes.append((f, initial, after))

    core = "packages/core/src/network/websocket-service.ts"
    edit(core, '''  private restrictedRoleLease: string | null = null;
  private restrictedRoleRegistrations = new Set<string>();''',
'''  private restrictedRoleLease: string | null = null;
  private restrictedRoleRegistrations = new Set<string>();
  private authenticatedAgent: string | null = null;
  private restrictedRoleSessionChanged: (() => void) | null = null;''')
    edit(core, '''  getRestrictedRoleLease(): string | null {
    return this.isConnected() ? this.restrictedRoleLease : null;
  }''',
'''  onRestrictedRoleSessionChanged(callback: () => void): void {
    this.restrictedRoleSessionChanged = callback;
  }

  // Read ACTUAL WebSocket-owned auth and registered ACK state. Offscreen
  // responds to a fresh internal background probe; a forwarded lease never
  // proves authentication in isolation.
  getRestrictedRoleState() {
    return {
      lease: this.getRestrictedRoleLease(),
      authenticatedAgent: this.isConnected() ? this.authenticatedAgent : null,
      registrations: [...this.restrictedRoleRegistrations].map(value => {
        const index = value.indexOf(":");
        return { dna_hash: value.slice(0, index), agent_pubkey: value.slice(index + 1) };
      }),
      authenticated: this.isAuthenticated(),
      isConnected: this.isConnected(),
    };
  }

  getRestrictedRoleLease(): string | null {
    return this.isConnected() ? this.restrictedRoleLease : null;
  }''')
    edit(core, '''      frame.envelope?.dna_hash, frame.envelope?.sender_agent) ||
        typeof frame.signature !== "string") {''',
'''      frame.envelope?.dna_hash, frame.envelope?.sender_agent) ||
        frame.envelope?.sender_agent !== this.authenticatedAgent ||
        typeof frame.signature !== "string") {''')
    edit(core, '''            this.restrictedRoleRegistrations.add(message.dna_hash + ':' + message.agent_pubkey);
          }''',
'''            this.restrictedRoleRegistrations.add(message.dna_hash + ':' + message.agent_pubkey);
            this.restrictedRoleSessionChanged?.();
          }''')
    edit(core, '''          this.restrictedRoleRegistrations.delete(message.dna_hash + ':' + message.agent_pubkey);
          break;''',
'''          this.restrictedRoleRegistrations.delete(message.dna_hash + ':' + message.agent_pubkey);
          this.restrictedRoleSessionChanged?.();
          break;''')
    edit(core, '''  private handleAuthOk(message: Extract<ServerMessage, { type: "auth_ok" }>): void {
    log.debug("Authenticated");''',
'''  private handleAuthOk(message: Extract<ServerMessage, { type: "auth_ok" }>): void {
    // Never accept a replayed/unsolicited OK as authenticated role identity.
    if (!this.pendingAuthAgent) {
      this.disconnect();
      return;
    }
    log.debug("Authenticated");''')
    edit(core, '''    this.restrictedRoleLease = crypto.randomUUID();''',
'''    this.restrictedRoleLease = crypto.randomUUID();
    this.restrictedRoleSessionChanged?.();''')
    edit(core, '''    this.restrictedRoleRegistrations.clear();
    this.failedAuthAgents.clear();''',
'''    this.restrictedRoleRegistrations.clear();
    this.restrictedRoleSessionChanged?.();
    this.failedAuthAgents.clear();''')
    edit(core, '''    if (this.isConnected()) {
      this.send({ type: "unregister", dna_hash, agent_pubkey });
    }''',
'''    this.restrictedRoleRegistrations.delete(dna_hash + ':' + agent_pubkey);
    this.restrictedRoleSessionChanged?.();
    if (this.isConnected()) {
      this.send({ type: "unregister", dna_hash, agent_pubkey });
    }''')
    offscreen="packages/extension/src/offscreen/index.ts"
    edit(offscreen, '''  // Set up state change callback for logging and auto-retry
  wsService.onStateChange((state: ConnectionState) => {''',
'''  // Any auth/registration change invalidates background correlation. The
  // background still probes THIS actual socket before accepting an envelope.
  wsService.onRestrictedRoleSessionChanged(() => {
    chrome.runtime.sendMessage({
      target: "background", type: "PRIVATE_ROLE_SESSION_CHANGE"
    }).catch(() => {});
  });
  // Re-observe installed games as native DHT convergence progresses. No
  // webpage message or generic remote call initiates a role request.
  // This timer is in the persistent Chrome offscreen extension compartment.
  if (!(globalThis as any).__hwcRestrictedRolePulse) {
    (globalThis as any).__hwcRestrictedRolePulse = setInterval(() => {
      if (wsService?.getRestrictedRoleLease()) {
        chrome.runtime.sendMessage({
          target: "background", type: "PRIVATE_ROLE_PULSE"
        }).catch(() => {});
      }
    }, 4500);
  }

  // Set up state change callback for logging and auto-retry
  wsService.onStateChange((state: ConnectionState) => {''')
    edit(offscreen, '''    if (message.type === "CONFIGURE_NETWORK") {''',
'''    // Role-only internal IPC. Chrome background service worker is the sole
    // permitted caller; content scripts, popup and public message forwarding
    // cannot obtain a lease or transmit ciphertext through this route.
    if (message.type === "PRIVATE_ROLE_SESSION_PROBE" ||
        message.type === "PRIVATE_ROLE_SEND_FRAME") {
      const backgroundUrl = chrome.runtime.getURL("background/index.js");
      if (sender.id !== chrome.runtime.id || sender.tab !== undefined ||
          (sender.url !== undefined && sender.url !== backgroundUrl)) {
        sendResponse({success:false,error:"PRIVATE_ROLE_INTERNAL_SENDER_DENIED"});
        return false;
      }
      if (message.type === "PRIVATE_ROLE_SESSION_PROBE") {
        sendResponse({success:true,state:wsService?.getRestrictedRoleState() ?? {
          lease:null,authenticatedAgent:null,registrations:[],
          authenticated:false,isConnected:false
        }});
        return false;
      }
      const current = wsService?.getRestrictedRoleState();
      const frame = message.frame;
      if (!current?.lease || message.lease !== current.lease ||
          !current.authenticated || !current.isConnected ||
          !frame || !["role_request_v1","role_delivery_v1"].includes(frame.type) ||
          typeof frame.envelope?.dna_hash !== "string" ||
          typeof frame.envelope?.sender_agent !== "string" ||
          frame.envelope.sender_agent !== current.authenticatedAgent ||
          !wsService?.hasRestrictedRoleRegistration(
            frame.envelope.dna_hash,frame.envelope.sender_agent)) {
        sendResponse({success:false,error:"PRIVATE_ROLE_SESSION_REVOKED"});
        return false;
      }
      try {
        wsService.sendRestrictedRole(frame);
        sendResponse({success:true,queuedOnly:true});
      } catch {
        sendResponse({success:false,error:"PRIVATE_ROLE_SEND_REJECTED"});
      }
      return false;
    }

    if (message.type === "CONFIGURE_NETWORK") {''')
    background="packages/extension/src/background/index.ts"
    edit(background, '''import { encodeHashToBase64, type AgentPubKey, type CellId } from "@holochain/client";''',
'''import { encodeHashToBase64, hashFrom32AndType, HoloHashType, type AgentPubKey, type CellId } from "@holochain/client";
// Bundled only into the Chrome background IIFE. These JS modules are never
// included in content scripts, page inject, a public API or chrome.storage.
// @ts-ignore - pinned private-role JS module has no declaration file
import { createInstalledHwcRoleRuntime } from "../private-role/hwc-installed-runtime.mjs";''')
    edit(background, '''const executor: ZomeExecutor = createExecutor();''',
'''const executor: ZomeExecutor = createExecutor();

// Lazy because the browser can be locked or lack a real installed game cell.
// The privileged service is never an exported page or runtime RPC handler.
let installedRoleRuntime: any = null;
function getInstalledRoleRuntime(): any {
  if (typeof __BROWSER__ === "undefined" || __BROWSER__ !== "chrome")
    throw new Error("restricted private role requires Chromium offscreen");
  if (installedRoleRuntime) return installedRoleRuntime;
  const identical = (a: Uint8Array, b: Uint8Array) =>
    a.length===b.length && a.every((v,i)=>v===b[i]);
  installedRoleRuntime = createInstalledHwcRoleRuntime({
    contextManager: happContextManager,
    getLair: getLairClient,
    encodeHash: encodeHashToBase64,
    canonicalHash: (b: Uint8Array,kind: string) =>
      new Uint8Array(hashFrom32AndType(b.slice(3,35),
        kind==="dna" ? HoloHashType.Dna :
        kind==="agent" ? HoloHashType.Agent : HoloHashType.Action)),
    probeSocket: async () => {
      await executor.initialize();
      const response = await chrome.runtime.sendMessage({
        target:"offscreen",type:"PRIVATE_ROLE_SESSION_PROBE"
      });
      if (!response?.success) throw new Error("private role WS probe unavailable");
      return response.state;
    },
    sendSocket: async ({frame,lease}: any) => {
      await executor.initialize();
      return chrome.runtime.sendMessage({
        target:"offscreen",type:"PRIVATE_ROLE_SEND_FRAME",frame,lease
      });
    },
    nativeZomeCall: async ({contextId,cellId,zome,fn,payload,provenance}: any) => {
      if (zome!=="game" || ![
        "get_authoritative_game_view","host_role_opening",
        "publish_signed_recipient_key_attestation","lookup_recipient_key"
      ].includes(fn)) throw new Error("private native function not allowlisted");
      const ctx = await happContextManager.getContext(contextId);
      const a=toUint8Array(ctx?.agentPubKey || []),d=toUint8Array(ctx?.dnas?.[0]?.hash || []);
      const requestedDna=toUint8Array(cellId[0]);
      const requestedAgent=toUint8Array(cellId[1]);
      if (!ctx?.enabled || ctx.dnas.length!==1 ||
          !identical(d,requestedDna) || !identical(a,requestedAgent) ||
          !identical(a,toUint8Array(provenance)))
        throw new Error("privileged native execution requires exact installed cell");
      await preloadSigningKeyIfNeeded(a);
      const request: ZomeCallRequest = {
        dnaWasm:new Uint8Array(0),cellId:[d,a],
        zome:"game",fn,
        payload:new Uint8Array(encode(normalizeUint8Arrays(payload))),
        provenance:a,dnaManifest:undefined,
      };
      // The private host_role_opening return crosses only extension-owned
      // offscreen -> background IPC and is NEVER serialized to a content tab.
      const output=await executor.executeZomeCall(contextId,request);
      if (output.signals?.length) throw new Error("role-only native emitted signals");
      const fresh=await happContextManager.getContext(contextId);
      if(!fresh?.enabled || !identical(a,toUint8Array(fresh.agentPubKey)))
        throw new Error("installed native identity revoked during execution");
      return normalizeUint8Arrays(output.result);
    },
    onReceipt: (receipt: any) => {
      // Metadata only; this callback never receives the private decrypted role.
      log.info("HWC_EXTENSION_LOCAL_ENCRYPTED_ROLE_RECEIPT_VERIFIED", {
        seat:receipt.seat,roleCommit:receipt.roleCommit,
        coordinatorInvoked:false
      });
    }
  });
  return installedRoleRuntime;
}''')
    edit(background, '''    const { result: transportSafeResult, signals, didWrite } = await executor.executeZomeCall(context.id, zomeCallRequest);
    const afterOffscreen = performance.now();''',
'''    const { result: transportSafeResult, signals, didWrite } = await executor.executeZomeCall(context.id, zomeCallRequest);
    // Pin Lobby ONLY from the native installed-cell signed Create/PlayerJoin
    // result. A page-provided action hash is never accepted. Do this before
    // forwarding the ordinary public result to the caller.
    if (zome_name === "game" && ["create_lobby","join_lobby"].includes(fn_name)) {
      await getInstalledRoleRuntime().pinLobbyFromNativeRecord(
        context.id,fn_name,normalizeUint8Arrays(transportSafeResult),
        (raw: Uint8Array) => decode(raw)
      );
    }
    if (zome_name === "game" && fn_name === "commit_roles_only") {
      void getInstalledRoleRuntime().pulse().catch(() => {});
    }
    const afterOffscreen = performance.now();''')
    edit(background, '''// RESERVED extension-owned entry point for Agent 2's restricted receiver.
// Until the independently native-validated current-round game-state bridge
// and authenticated WS lease are installed, deny EVERY private-role frame.
// The page/content-script cannot spoof sender.id/sender.url/sender.tab.
// This intentionally does NOT invoke executeZomeCall or call_info() and
// never substitutes the local ChainAuthor for a remote caller.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as { target?: string; type?: string; frame?: unknown; lease?: unknown };
  if (msg?.target !== "background" || msg.type !== "PRIVATE_ROLE_FRAME") return false;
  const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
  if (typeof __BROWSER__ === "undefined" || __BROWSER__ !== "chrome" ||
      sender.id !== chrome.runtime.id || sender.tab !== undefined ||
      sender.url !== offscreenUrl ||
      typeof msg.frame !== "string" || typeof msg.lease !== "string" ||
      msg.lease.length < 16 || msg.lease.length > 128 ||
      new TextEncoder().encode(msg.frame).length > 8192) {
    sendResponse({ success: false, error: "PRIVATE_ROLE_SENDER_REJECTED" });
    return false;
  }
  // No forged trust flags, role plaintext, credentials or gateway ACKs may
  // bypass native RoleCommit/recipient key validation via this entry point.
  // Do not add a fallback to the disabled legacy remote-signal route.
  sendResponse({ success: false, error: "NATIVE_ROLE_STATE_BRIDGE_UNAVAILABLE" });
  return false;
});''',
'''// Offscreen-only ciphertext and connection state events. No content-script,
// popup or public message can call the service or native role executor.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg=raw as {target?:string;type?:string;frame?:unknown;lease?:unknown};
  if(msg?.target!=="background" || ![
      "PRIVATE_ROLE_FRAME","PRIVATE_ROLE_PULSE","PRIVATE_ROLE_SESSION_CHANGE"
    ].includes(msg.type||"")) return false;
  const offscreenUrl=chrome.runtime.getURL("offscreen/offscreen.html");
  if(typeof __BROWSER__==="undefined" || __BROWSER__!=="chrome" ||
     sender.id!==chrome.runtime.id || sender.tab!==undefined ||
     sender.url!==offscreenUrl) {
    sendResponse({success:false,error:"PRIVATE_ROLE_SENDER_REJECTED"});
    return false;
  }
  if(msg.type==="PRIVATE_ROLE_SESSION_CHANGE") {
    installedRoleRuntime?.invalidate();
    sendResponse({success:true});
    return false;
  }
  if(msg.type==="PRIVATE_ROLE_PULSE") {
    void getInstalledRoleRuntime().pulse().catch(()=>{});
    sendResponse({success:true});
    return false;
  }
  if(typeof msg.frame!=="string" || typeof msg.lease!=="string" ||
     msg.lease.length<16 || msg.lease.length>128 ||
     new TextEncoder().encode(msg.frame).length>8192) {
    sendResponse({success:false,error:"PRIVATE_ROLE_INVALID_FRAME"});
    return false;
  }
  // The lease is NOT trusted: the runtime queries the live offscreen WS and
  // checks its exact authenticated signer and acknowledged registration.
  void getInstalledRoleRuntime().receiveSocketFrame(msg.frame,msg.lease)
    .then((r: unknown)=>sendResponse({success:true,result:r}))
    .catch(()=>sendResponse({success:false,error:"PRIVATE_ROLE_NATIVE_OR_SESSION_REJECTED"}));
  return true;
});''')
    edit(background, '''    if (rawMessage.target === "offscreen") {
      log.trace("Forwarding message to offscreen:", rawMessage.type);''',
'''    if (rawMessage.target === "offscreen") {
      // Never forward privileged role-probe/send IPC from a tab or popup.
      if (["PRIVATE_ROLE_SESSION_PROBE","PRIVATE_ROLE_SEND_FRAME"].includes(rawMessage.type))
        return false;
      log.trace("Forwarding message to offscreen:", rawMessage.type);''')

    source=Path(__file__).resolve().parent
    dest=root/"packages/extension/src/private-role"
    for name in PRIVATE_FILES:
        file=dest/name
        if file.exists():
            raise ValueError(f"privileged module already installed: {file}")
        changes.append((file, "", (source/name).read_text(encoding="utf-8")))
    return changes

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("root",type=Path)
    group=parser.add_mutually_exclusive_group()
    group.add_argument("--check",action="store_true")
    group.add_argument("--write",action="store_true")
    group.add_argument("--patch",type=Path)
    args=parser.parse_args()
    root=args.root.resolve()
    head=subprocess.check_output(["git","-C",str(root),"rev-parse","HEAD"],text=True).strip()
    if head!=UPSTREAM:
        raise SystemExit(f"wrong pinned HWC upstream source: {head}")
    changes=build_changes(root)
    patch="".join("".join(difflib.unified_diff(
        old.splitlines(keepends=True),new.splitlines(keepends=True),
        fromfile="a/"+str(path.relative_to(root)),
        tofile="b/"+str(path.relative_to(root))
    )) for path,old,new in changes)
    if args.patch:
        args.patch.write_text(patch,encoding="utf-8")
    if args.write:
        for file,_,data in changes:
            file.parent.mkdir(parents=True,exist_ok=True)
            file.write_text(data,encoding="utf-8")
    print("AGENT2_INSTALLED_HWC_ROLE_RECEIVER="+("WRITTEN" if args.write else "CHECKED"))
    print(f"PATCH_FILES={len(changes)} PATCH_BYTES={len(patch.encode())}")
    print("REMOTE_COORDINATOR=DISABLED; DECRYPTION_EXTENSION_ONLY; GATEWAY_RECEIPT_NOT_ASSUMED")

if __name__=="__main__":
    main()
