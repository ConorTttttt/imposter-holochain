# Firefox Desktop and Android HWC progress

## Source and implementation

Base branch `followup/browser-alpha-operator`, commit `c92353c87d27078c8c48ee54fcf881fcf7db363d`. The verified release pins are HWC `0c391226e78769d44ccb4661881ed8998b15f903`, game `0f7b17592e682a7b7d77e9346528cba69a096cdc`, Holochain 0.7.0 and Node.js 22.22.0. The existing Chromium build command and pinned release assets are unchanged.

The patched Firefox build previously compiled with the role receiver wired to Chrome offscreen IPC. Firefox runs the ribosome in a dedicated worker and owns its WebSocket in the extension background page. The Firefox build now wires that socket directly into the shared installed-cell role receiver. A role lease requires a Lair-signed challenge response, an open authenticated socket, and an acknowledged destination registration for the incoming frame. Registration removal rotates the lease. Socket loss and reauthentication invalidate in-memory role correlations and clear the worker’s old HTTP bearer. The extension still validates the installed cell, native Lobby and RoleCommit, recipient attestation, Merkle opening, replay record and recipient epoch through the shared role code.

The Firefox background keeps role frames and private native operations inside extension code. The game UI can read only its own verified role value through the existing origin-bound, top-frame operation. The read accepts no payload. The Firefox build requires persistent OPFS SQLite for the ribosome and WebCrypto X25519 and Ed25519 for role handling. The desktop manifest requires Firefox 130 or later based on those WebCrypto APIs. The oldest supported version still needs browser acceptance. [WebCrypto compatibility](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey#browser_compatibility)

## Verification

| Stage | Status | Evidence |
| --- | --- | --- |
| Pins and Firefox bundle | PASS | The isolated release command verified the upstream source pins, type-checked the shared, Lair, core and extension packages, and built the Manifest V3 add-on. |
| Firefox development archive | PASS | The package verifier checked the manifest, background, worker, SQLite WebAssembly, asset inventory and SHA-256. Two builds produced byte-identical archives. |
| Firefox socket adapter | PASS | Tests covered signed challenge gating, acknowledged recipient registration, closing sockets, registration revocation, stale lease rejection and legitimate reauthentication. |
| Shared receiver and persistence | PASS | 41 tests covered the production role protocol, including signature and recipient validation, proof rejection, attestation expiry, replay, epoch rollback and native authority validation. |
| Both extension build inventories | PASS | All 36 HWC build-validation tests passed with both browser outputs present. |
| Chromium baseline | PASS | Built the unmodified operator extension and exercised the Lair public identity and installed background sender checks in Chromium. |
| All-workspace HWC type-check | FAIL | The upstream client workspace could not resolve `@holo-host/joining-service`. The release command’s targeted TypeScript checks passed. |
| Full HWC extension unit suite | FAIL | Chrome offscreen mocks omit the sender metadata required by the existing compatibility guard. The state-query timeout also reproduced on a Chromium-only checkout with the existing patches. Real Chromium sender checks passed. |
| Firefox Desktop add-on load and Lair identity | PASS | GitHub-hosted Firefox loaded the stock add-on and the browser-alpha setup page obtained a real Lair public identity. |
| Firefox local fixture hApp installation | PASS | Hosted Firefox installed the pinned HWC fixture. The webpage’s attempt to invoke a privileged role call was denied. |
| Firefox local fixture zome call | PASS | The browser ribosome executed the pinned fixture’s `ziptest::get_things`. |
| Firefox local profile restart | PASS | Firefox retained its Lair identity and executed the installed fixture again after restart with Mozilla’s temporary add-on testing preferences. |
| Firefox authenticated operator gateway session | BLOCKED | Requires a Tailscale-connected test environment and admission for a Firefox identity on the private deployment. |
| Firefox host-bound game hApp and native zome call | NOT EXECUTED | Requires the deployed exact game hApp and gateway. |
| Firefox encrypted role and mixed three-player round | NOT EXECUTED | Requires the live mixed-browser acceptance below. |
| Firefox restart and authenticated session recovery | NOT EXECUTED | Requires the same Firefox profile and an admitted game identity. |
| Firefox Android package and device acceptance | NOT EXECUTED | Android implementation starts after the Desktop mixed round passes. |

[Hosted Firefox build and browser evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44416811867) · [Unsigned development package and SHA-256](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44416811867/artifacts/14479538480)

## Build and install on Firefox Desktop

From this feature checkout, with Node.js 22.22.0, npm, Git, jq and Python 3 available:

```sh
git clone https://github.com/Holo-Host/holo-web-conductor.git hwc-firefox
git -C hwc-firefox checkout --detach 0c391226e78769d44ccb4661881ed8998b15f903
bash release/browser-alpha/build-firefox-extension.sh hwc-firefox firefox-desktop-dev
python3 release/browser-alpha/package-firefox.py verify firefox-desktop-dev
(cd firefox-desktop-dev && sha256sum --check SHA256SUMS)
```

Unpack `firefox-desktop-hwc.zip` into a dedicated directory. Create or select a dedicated persistent Firefox profile in `about:profiles`. In that profile, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the unpacked `manifest.json`. Firefox removes temporary add-ons on exit. When testing a restart, set `extensions.webextensions.keepStorageOnUninstall` and `extensions.webextensions.keepUuidOnUninstall` to `true` in the dedicated development profile before exiting. Reload the same directory from the same profile and check the identity before entering the lobby. A permanent installation on Release or Beta requires Mozilla signing. The development archive is unsigned. [Temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) · [Testing persistent add-on data](https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/) · [Mozilla signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

## Desktop mixed-round acceptance

- [ ] With the operator, reserve a fresh lobby on the existing private Tailscale HTTPS deployment. Use a Chromium host, Chromium guest and Firefox Desktop guest in three distinct profiles.
- [ ] Open each profile’s setup page, connect HWC and approve the exact site. Record that the three public identities differ and have been admitted. Keep the identities and deployment address out of shared evidence.
- [ ] Provision each profile and check that the setup page confirms the installed host-bound DNA and an authenticated gateway session. Record these stages separately.
- [ ] Join the same lobby, see `3/3`, and start as the host. Check in each profile that its own role becomes verified. Record the receipt outcome without recording the role values, opening, ciphertext, session or signing material.
- [ ] Complete **Align Engine Output** as a crewmate. Capture sanitized evidence that each browser shows `Ended · Crew wins` and `Task completions: 1/1`.
- [ ] Exit Firefox. Open the same profile and reload the temporary add-on if needed. Confirm the same public identity, same installed game, fresh gateway authentication and a verified role when a current game permits one.

## Android test procedure after Desktop acceptance

Start with a Firefox for Android testing channel and a device connected to the private Tailscale network. Enable USB debugging on the device and **Remote debugging via USB** in Firefox. Verify the device with `adb devices`. After the Android manifest and UI have been reviewed and built, load the unpacked build with Mozilla’s temporary development workflow:

```sh
web-ext run --source-dir FIREFOX_ANDROID_BUILD --target firefox-android \
  --adb-device DEVICE_SERIAL --firefox-apk org.mozilla.fenix
```

Use the installed package ID for the chosen channel. A temporary development load uses the unpacked directory. A permanent installation needs a Mozilla-signed XPI for the target channel. Mozilla supports Firefox for Android on Android 8.0 and later. Record the actual Android and Firefox versions during acceptance and check both the signing channel and add-on manifest before distributing a package. Android’s add-on approval UI, background lifetime, persistent storage and touch interactions need device coverage. [Mozilla’s Android development workflow](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/) · [Android system requirements](https://support.mozilla.org/en-US/kb/will-firefox-work-my-mobile-device)

- [ ] Connect to the existing HTTPS page, approve the origin, capture a persistent public identity, obtain gateway admission, and verify the installed host-bound hApp.
- [ ] Run the same round with two desktop participants. Confirm the Android player receives its own verified role and all three players see the same authoritative result.
- [ ] Repeat after screen lock, app switching, loss of connectivity, page reload and browser restart. Verify identity retention and fresh session authorization before recording role delivery as passed.
