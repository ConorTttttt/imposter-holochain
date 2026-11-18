#!/usr/bin/env python3
"""Connect the existing native topology to an extension-worker-only observer."""
from pathlib import Path
import sys


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"Installed role CI anchor drift: {old!r}")
    return source.replace(old, new, 1)


background, bridge = map(Path, sys.argv[1:])
source = background.read_text()
source = replace_once(source, "let installedRoleRuntime: any = null;", """let installedRoleRuntime: any = null;
// CI debugger only. Exposes no callable role, signer, native executor or mutation.
Object.defineProperty(globalThis, "__imposterInstalledRoleEvidence", {
  value: () => installedRoleRuntime?.evidenceMetadata() ?? [],
});""")
background.write_text(source)

source = bridge.read_text()
for label, permission in (
    ("'ephemeral-real-HWC-host'", "game_role_deliver"),
    ("'ephemeral-isolated-HWC-guest'", "game_role_request"),
):
    # Keep the third profile restricted to DHT and network operations.
    import re
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
    output:path.join(OUT_LOG,'installed-role-evidence.json'),
  }));
  record('NETWORKED_THREE_PLAYER_GAMEPLAY','PASS',""")
bridge.write_text(source)
