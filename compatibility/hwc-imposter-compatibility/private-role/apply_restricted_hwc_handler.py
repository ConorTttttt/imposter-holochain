#!/usr/bin/env python3
"""STAGED, DENY-ONLY private role transport for the accepted pinned HWC patch.

Apply AFTER compatibility/hwc-imposter-compatibility/apply.py. No remote WASM
execution, role decryption or page public API is enabled: a genuine native
lobby+RoleCommit read adapter and verified WS lease still require acceptance.

This script has exact-once anchors, atomic preflight and does not modify
accepted apply.py or its existing SQLite/OPFS migration.
"""
import argparse
import difflib
from pathlib import Path
import subprocess

UPSTREAM = "0c391226e78769d44ccb4661881ed8998b15f903"

def replace_once(original: str, before: str, after: str, filename: str) -> str:
    occurrences = original.count(before)
    if occurrences != 1:
        raise ValueError(f"{filename}: expected one source anchor, got {occurrences}")
    return original.replace(before, after, 1)

def build_changes(root: Path) -> list[tuple[Path, str, str]]:
    changes = []
    def edit(path: str, before: str, after: str) -> None:
        file = root / path
        original = next((new for f, _, new in changes if f == file), None)
        if original is None:
            original = file.read_text(encoding="utf-8")
        updated = replace_once(original, before, after, path)
        for i, (f, old, _) in enumerate(changes):
            if f == file:
                changes[i] = (file, old, updated)
                break
        else:
            changes.append((file, original, updated))

    core = "packages/core/src/network/websocket-service.ts"
    edit(core, '  | { type: "error"; message: string }', '''  | { type: "error"; message: string }
  // Restricted encrypted role frames are forwarded only to the extension's
  // private HWC receiver. No generic remote signal or zome execution.
  | { type: "role_request_v1" | "role_delivery_v1"; envelope: unknown; signature: string }''')
    edit(core, '''  private signalCallback: SignalCallback | null = null;''', '''  private signalCallback: SignalCallback | null = null;
  private restrictedRoleCallback: ((frame: string, lease: string) => void) | null = null;
  // Generated ONLY after successful signed WS auth, invalidated on any close.
  // A registration becomes trusted only after an actual server 'registered' ACK.
  private restrictedRoleLease: string | null = null;
  private restrictedRoleRegistrations = new Set<string>();''')
    edit(core, '''  onSignal(callback: SignalCallback): void {
    this.signalCallback = callback;
  }''', '''  onSignal(callback: SignalCallback): void {
    this.signalCallback = callback;
  }

  /** Extension offscreen-only wiring. Never an API available to pages. */
  onRestrictedRole(callback: (frame: string, lease: string) => void): void {
    this.restrictedRoleCallback = callback;
  }

  getRestrictedRoleLease(): string | null {
    return this.isConnected() ? this.restrictedRoleLease : null;
  }

  hasRestrictedRoleRegistration(dna: string, agent: string): boolean {
    return this.isConnected() &&
      this.restrictedRoleRegistrations.has(dna + ':' + agent);
  }

  // This is NOT a generic websocket send, remote zome call or public API.
  // The extension-only role service must supply an independently Lair-signed
  // restricted envelope and its exact currently acknowledged source cell.
  sendRestrictedRole(frame: {
    type: "role_request_v1" | "role_delivery_v1";
    envelope: { dna_hash: string; sender_agent: string };
    signature: string;
  }): void {
    if (!frame || !this.getRestrictedRoleLease() ||
        !this.hasRestrictedRoleRegistration(
          frame.envelope?.dna_hash, frame.envelope?.sender_agent) ||
        typeof frame.signature !== "string") {
      throw new Error("signed registered role sender required");
    }
    const raw = JSON.stringify(frame);
    if (new TextEncoder().encode(raw).length > 8192) {
      throw new Error("restricted role frame too large");
    }
    this.send(frame);
  }''')
    edit(core, '''        case "registered":
          log.debug(`Agent registered: ${message.agent_pubkey} for ${message.dna_hash}`);
          break;''', '''        case "registered":
          log.debug(`Agent registered: ${message.agent_pubkey} for ${message.dna_hash}`);
          if (this.isConnected() && this.registrations.some(r =>
              r.dna_hash === message.dna_hash &&
              r.agent_pubkey === message.agent_pubkey)) {
            this.restrictedRoleRegistrations.add(message.dna_hash + ':' + message.agent_pubkey);
          }
          break;''')
    edit(core, '''        case "unregistered":
          log.debug(`Agent unregistered: ${message.agent_pubkey} for ${message.dna_hash}`);
          break;''', '''        case "unregistered":
          log.debug(`Agent unregistered: ${message.agent_pubkey} for ${message.dna_hash}`);
          this.restrictedRoleRegistrations.delete(message.dna_hash + ':' + message.agent_pubkey);
          break;''')
    edit(core, '''    this.authenticated = true;
    this.pendingAuthAgent = null;''', '''    this.authenticated = true;
    this.pendingAuthAgent = null;
    this.restrictedRoleRegistrations.clear();
    this.restrictedRoleLease = crypto.randomUUID();''')
    edit(core, '''    this.authenticated = false;
    this.failedAuthAgents.clear();
    this.lastPeerCount = undefined;''', '''    this.authenticated = false;
    this.restrictedRoleLease = null;
    this.restrictedRoleRegistrations.clear();
    this.failedAuthAgents.clear();
    this.lastPeerCount = undefined;''')

    edit(core, '''        case "signal":
          this.handleSignal(message);
          break;''', '''        case "signal":
          this.handleSignal(message);
          break;

        case "role_request_v1":
        case "role_delivery_v1": {
          const raw = typeof event.data === "string" ? event.data : "";
          // A server-signed auth session + confirmed destination registration
          // are prerequisites. Never rely on the initial queued registration
          // intent, message claims, a browser tab or a gateway ACK.
          const env = message.envelope as { dna_hash?: unknown; recipient_agent?: unknown } | undefined;
          if (raw && new TextEncoder().encode(raw).length <= 8192 &&
              typeof env?.dna_hash === "string" &&
              typeof env?.recipient_agent === "string" &&
              this.hasRestrictedRoleRegistration(env.dna_hash, env.recipient_agent) &&
              this.restrictedRoleLease && this.restrictedRoleCallback) {
            this.restrictedRoleCallback(raw, this.restrictedRoleLease);
          }
          break;
        }''')

    offscreen = "packages/extension/src/offscreen/index.ts"
    edit(offscreen, '''  // Set up state change callback for logging and auto-retry
  wsService.onStateChange((state: ConnectionState) => {''', '''  // Restricted ciphertext-only relay to background. No role material,
  // bearer, verifiedRemoteCaller or nativeValidated flag is accepted here.
  // Background rechecks the browser-supplied sender metadata.
  wsService.onRestrictedRole((frame: string, lease: string) => {
    if (!wsService?.isAuthenticated() || !wsService?.isConnected()) return;
    chrome.runtime.sendMessage({
      target: "background",
      type: "PRIVATE_ROLE_FRAME",
      frame,
      lease,
    }).catch(() => {
      // Delivery fails closed; never log a ciphertext or private payload.
    });
  });

  // Set up state change callback for logging and auto-retry
  wsService.onStateChange((state: ConnectionState) => {''')

    background = "packages/extension/src/background/index.ts"
    edit(background, '''executor.onRemoteSignal((data) => {
  handleRemoteSignal(data);
});''', '''executor.onRemoteSignal((data) => {
  handleRemoteSignal(data);
});

// RESERVED extension-owned entry point for Agent 2's restricted receiver.
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
});''')
    return changes

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=Path)
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    group.add_argument("--patch", type=Path)
    args = ap.parse_args()
    root = args.root.resolve()
    pin = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if pin != UPSTREAM:
        raise SystemExit(f"FAIL: wrong upstream HWC revision {pin}")
    changes = build_changes(root)
    patch = "".join("".join(difflib.unified_diff(
        old.splitlines(True), new.splitlines(True),
        fromfile=f"a/{path.relative_to(root)}", tofile=f"b/{path.relative_to(root)}"
    )) for path, old, new in changes)
    if args.patch:
        args.patch.write_text(patch, encoding="utf-8")
    if args.write:
        for path, _, text in changes:
            path.write_text(text, encoding="utf-8")
    print(f"AGENT2_STAGED_RESTRICTED_WS_LEASE_DENY_ONLY_HWC_PATCH={'WRITE' if args.write else 'CHECK'}"
          f"; source_files={len(changes)}; patch_bytes={len(patch.encode())}")
    print("NATIVE_ROLE_RECEIVER=DISABLED; REMOTE_COORDINATOR=DISABLED")

if __name__ == "__main__":
    main()
