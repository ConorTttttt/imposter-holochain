#!/usr/bin/env python3
"""Add browser lobby selection after the Chromium or Firefox receiver patch."""
import argparse
from pathlib import Path
import subprocess

from apply_restricted_hwc_handler import replace_once, UPSTREAM

path = "packages/extension/src/background/index.ts"
selection = '''
    // Lobby changes may be derived only from this origin's local native result.
    const selectsBrowserLobby = zome_name === "game" && [
      "create_browser_lobby", "join_browser_lobby", "new_browser_game", "reopen_browser_lobby",
    ].includes(fn_name);
    const readsBrowserSelection = zome_name === "game" && fn_name === "get_selected_browser_lobby";
    const readsBrowserRole = zome_name === "game" && fn_name === "get_browser_lobby_role";
    if (selectsBrowserLobby || readsBrowserSelection || readsBrowserRole) {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
          !sender.url || new URL(sender.url).origin !== origin ||
          context.domain !== origin || !(await permissionManager.checkPermission(origin))?.granted)
        return createErrorResponse(message.id, "BROWSER_LOBBY_ORIGIN_DENIED");
      if (readsBrowserSelection || readsBrowserRole) {
        try {
          const runtime = getInstalledRoleRuntime();
          const value = readsBrowserSelection
            ? payload == null && await runtime.selectedBrowserLobby(context.id)
            : payload != null && await runtime.readOwnRole(context.id, normalizeUint8Arrays(payload));
          if (!(await permissionManager.checkPermission(origin))?.granted)
            return createErrorResponse(message.id, "BROWSER_LOBBY_ORIGIN_DENIED");
          return createSuccessResponse(message.id, value === false ? null : value);
        } catch {
          return createErrorResponse(message.id, "BROWSER_LOBBY_SELECTION_OR_ROLE_UNAVAILABLE");
        }
      }
    }

'''
native_result = '''
    if (selectsBrowserLobby) {
      await getInstalledRoleRuntime().pinLobbyFromNativeRecord(
        context.id, fn_name, normalizeUint8Arrays(transportSafeResult),
        (raw: Uint8Array) => decode(raw)
      );
    }
    if (zome_name === "game" && fn_name === "start_browser_round") {
      void getInstalledRoleRuntime().pulse().catch(() => {});
    }
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upstream", type=Path)
    root = parser.parse_args().upstream
    if subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip() != UPSTREAM:
        parser.error("HWC is not at the pinned upstream commit")
    target = root / path
    source = target.read_text(encoding="utf-8")
    before_cell = '    // Build cell_id from context\n    logZome.trace'
    source = replace_once(source, before_cell, selection + before_cell, path)
    before_forward = '    const afterOffscreen = performance.now();'
    source = replace_once(source, before_forward, native_result + before_forward, path)
    target.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    main()
