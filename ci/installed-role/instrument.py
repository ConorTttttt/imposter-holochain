#!/usr/bin/env python3
"""Connect the existing native topology to an extension-worker-only observer."""
from pathlib import Path
import re
import sys


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"Installed role CI anchor drift: {old!r}")
    return source.replace(old, new, 1)


background, bridge = map(Path, sys.argv[1:])
source = background.read_text()
source = replace_once(source, "let installedRoleRuntime: any = null;", """let installedRoleRuntime: any = null;
// CI debugger only. No content-facing listener, plaintext, signing or native execution.
let lastAcceptedCiphertext: string | null = null;
let pauseNextRoleDelivery = false;
let pausedRole: {frame:string; resume:()=>void; outcome:string} | null = null;
async function receiveRoleUnderTest(frame:string, lease:string) {
  if (!pauseNextRoleDelivery || JSON.parse(frame).type !== "role_delivery_v1")
    return getInstalledRoleRuntime().receiveSocketFrame(frame, lease);
  pauseNextRoleDelivery = false;
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const delivery = {frame, resume, outcome:"pending"};
  pausedRole = delivery;
  await gate;
  try {
    const result = await getInstalledRoleRuntime().receiveSocketFrame(frame, lease);
    delivery.outcome = "accepted";
    return result;
  } catch (error) {
    delivery.outcome = "rejected";
    throw error;
  }
}
Object.defineProperty(globalThis, "__imposterPauseRoleDelivery", {
  value: (command:string) => {
    if (command === "arm") pauseNextRoleDelivery = true;
    if (command === "release") pausedRole?.resume();
    return pausedRole ? {frame:pausedRole.frame, outcome:pausedRole.outcome} : null;
  },
});
Object.defineProperty(globalThis, "__imposterInstalledRoleEvidence", {
  value: () => installedRoleRuntime?.evidenceMetadata() ?? [],
});
Object.defineProperty(globalThis, "__imposterRoleCiphertext", {
  value: () => lastAcceptedCiphertext,
});
Object.defineProperty(globalThis, "__imposterTryRoleCiphertext", {
  value: async (frame: string) => {
    await executor.initialize();
    const response = await chrome.runtime.sendMessage({
      target:"offscreen",type:"PRIVATE_ROLE_SESSION_PROBE"
    });
    if (!response?.roleSession?.lease) return "no-live-lease";
    try {
      await getInstalledRoleRuntime().receiveSocketFrame(frame, response.roleSession.lease);
      return "accepted";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "forged remote caller signature") return "bad-signature";
      if (message === "no unique enabled installed HWC game cell") return "wrong-recipient-cell";
      if (message === "unsolicited, stale or uncorrelated role delivery") return "uncorrelated";
      if (message === "stale or invalid role timestamp") return "expired";
      return "rejected";
    }
  },
});""")
source = replace_once(source, '    .then((r: unknown)=>sendResponse({success:true,result:r}))',
                      '''    .then((r: any)=>{
      if(r?.recipientReceipt===true)lastAcceptedCiphertext=msg.frame as string;
      sendResponse({success:true,result:r});
    })''')
source = replace_once(source, '  void getInstalledRoleRuntime().receiveSocketFrame(msg.frame,msg.lease)',
                      '  void receiveRoleUnderTest(msg.frame,msg.lease)')
background.write_text(source)

source = bridge.read_text()
for label, permission in (
    ("'ephemeral-real-HWC-host'", "game_role_deliver"),
    ("'ephemeral-isolated-HWC-guest'", "game_role_request"),
    ("'CI-controlled-integrity-invalid-lobby-author'", "game_role_request"),
):
    anchor = re.search(
        r"capabilities:\['dht_read','dht_write','k2'\],\s*label:" + label, source
    )
    if not anchor:
        raise ValueError(f"Missing pinned authorization for {label}")
    old = anchor.group()
    source = replace_once(source, old, old.replace("'k2']", f"'k2','{permission}']"))

source = replace_once(source, "  record('NETWORKED_THREE_PLAYER_GAMEPLAY','PASS',", """  const {verifyInstalledRole} = await import('../integration/ci/installed-role/acceptance.mjs');
  await step('INSTALLED_HWC_ROLE_HANDSHAKE', () => verifyInstalledRole({
    profiles:[context, guestContext, invalidContext],
    pages:[page, guestPage, guestCPage],
    agents:pubkeys, dna:m.dna_hash, lobby:lobbyActionHash,
    seats:evidence.networked_players.full_views,
    joinB:guestBJoin.action_hash,
    restartGuestB:async()=>{
      await guestContext.close();
      guestContext=await chromium.launchPersistentContext(guestProfile,chromeOptions);
      guestPage=await freshPage(guestContext);
      must(await ownIdentity(guestPage)===pubkeys[1], 'Guest B Lair identity changed after receipt');
      await signedSession(guestPage,'guest_b_after_receipt',pubkeys[1]);
      await guestPage.goto(ORIGIN+'/browser-demo.html',{waitUntil:'domcontentloaded'});
      return {profile:guestContext,page:guestPage};
    },
    output:path.join(OUT_LOG,'installed-role-evidence.json'),
  }));
  record('NETWORKED_THREE_PLAYER_GAMEPLAY','PASS',""")
bridge.write_text(source)
