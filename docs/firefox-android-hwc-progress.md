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
| Hosted mixed-browser build and native readiness | PASS | The pinned H2HC executable and two Holochain 0.7.0 authorities served the exact host-bound hApp. Both authorities acquired full DHT storage arcs. |
| Hosted mixed-browser encrypted roles | PASS | A Chromium host, Chromium guest and Firefox Desktop guest joined three distinct native seats. All three checked the same native RoleCommit and Merkle root. The host verified its native opening and both guest extensions independently accepted their encrypted deliveries before the public role reveal. |
| Hosted Firefox revocation and reauthorization | PASS | Gateway revocation removed access to the verified role. Firefox obtained a fresh authenticated session and independently verified a fresh encrypted receipt. |
| Hosted mixed-browser shared task and result | PASS | The stock **Align Engine Output** control finished the round. All three browsers observed the native crew-win result and rendered `Task completions: 1/1`. |
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

### Hosted fixture

The `Mixed Chromium and Firefox Desktop acceptance` workflow runs on feature-branch pushes and supports manual dispatch when the workflow is available on the default branch. It creates two disposable native Holochain 0.7.0 authorities, an authenticated gateway from the exact pinned executable, and three real browser profiles. The host-bound hApp is assembled by the operator release builder from the pinned sources. The workflow drives the stock browser setup and game pages, including **Start round** and **Align Engine Output**.

Run `44428605059` passed at `df3014eb09acf42d305d641aa358d53317cd4302`. The run also passed 25 Rust core tests, 41 role protocol and persistence tests, nine Firefox executor tests, and the release, page setup and operator preflight suites. The operator deployment still needs a trusted runner with private access. [Hosted run](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44428605059) · [Anonymous stage evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44428605059/artifacts/14486465030) · [Chromium and Firefox extension packages with SHA-256](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44428605059/artifacts/14485083795)

Before the task, all three browsers must independently read the exact native Lobby, RoleCommit, Merkle root and three canonical seats. The two guests must obtain their own role from the installed receiver while the round is playing and public role reveals are absent. The host verifies its local native opening under the existing host contract. Gateway session readiness and queued frames are separate from recipient verification. In the fixture only, the workflow revokes the Firefox admission, checks that the verified role becomes unavailable, and requires another verified role after normal reauthorization. The persistence and Firefox transport suites separately check replay reservations, recipient binding, rollback, lease rotation and action pinning. The report contains only stage names and pass/fail results.

### Operator runner

Use a trusted Linux runner with authorized access to both private HTTPS origins. Keep the three dedicated browser profiles closed before the run. Use the bound Chromium host and two distinct admitted guests, one Chromium and one Firefox. Approve the exact site and install its verified hApp in each profile before staging. Keep Chromium’s original unpacked extension path and packaged bytes unchanged for the run. The Firefox development package has a fixed add-on ID. Geckodriver uses Mozilla’s temporary add-on storage settings in the dedicated profile.

The launcher needs only a read-only SQLite view of `allowed_agents` with `agent_pubkey` and JSON `capabilities` columns. The gateway operator can supply the current admission-only snapshot on the trusted runner. Keep it outside CI with the owner-only input file and profiles. Host admission requires `game_role_deliver`. Both guests require `game_role_request`. Every identity also needs `dht_read`, `dht_write`, and `k2`. The launcher checks the snapshot and then requires actual authenticated browser sessions. It needs no gateway administrator credentials and removes inherited H2HC gateway variables before launching the browser process.

```json
{
  "public": {
    "frontend_origin": "https://frontend.example.ts.net",
    "gateway_origin": "https://gateway.example.ts.net"
  },
  "release": "/srv/imposter/verified-release",
  "release_commit": "<exact release source commit>",
  "release_manifest_sha256": "<trusted release manifest SHA-256>",
  "admission_database": "/srv/imposter/gateway/sessions.sqlite",
  "profiles": [
    "/srv/imposter/test/host-chromium",
    "/srv/imposter/test/guest-chromium",
    "/srv/imposter/test/guest-firefox"
  ],
  "chromium_extension": "/srv/imposter/test/chromium-hwc",
  "firefox_package": "/srv/imposter/test/firefox-package",
  "firefox_sha256": "<trusted firefox-desktop-hwc.zip SHA-256>",
  "hwc_checkout": "/srv/imposter/test/pinned-hwc-checkout"
}
```

The trusted runner needs Node 22.22.0, Python 3, the pinned HWC checkout with its Playwright dependencies and Chromium installed, and Firefox 130 or later with Geckodriver bound to `127.0.0.1:4444`. Use `FIREFOX_BIN` if Firefox is outside the runner’s normal executable path. Keep the normal certificate trust settings for both browsers. Confirm the approved Firefox profile can sign after a cold restart with its existing local Lair setup. The headless runner has no interactive unlock prompt.

### Build-to-deployment provenance

The accepted hosted package pair was built at `df3014eb09acf42d305d641aa358d53317cd4302`. Its GitHub artifact container SHA-256 is `ae27a585cc09fd140ff01a8409c6898809eed00e0c35686bc793838ec7d5b414`. Verify the ZIPs inside it against the accompanying `SHA256SUMS`. Use the verified Firefox ZIP SHA-256 as `firefox_sha256`. The preflight snapshots that ZIP before verification and accepts the directory from the combined package download. [Accepted hosted package pair](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44428605059/artifacts/14485083795)

Run `44487415864` rechecked both accepted ZIPs, reproduced the same two digests, and passed the hosted mixed round and operator preflight regressions. [Checksum audit and regression run](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44487415864)

| Extension ZIP | SHA-256 |
| --- | --- |
| `chromium-hwc.zip` | `8af423c2512d88fde1ae47fecc6a53861c683a085341b02c60c2296e1d9396df` |
| `firefox-desktop-hwc.zip` | `172dc951121f5d815def01b36d7a9b9c36af21e2684c45533e3878de25852d3e` |

Build the operator release with the operator’s host-bound seed and the unchanged release pins. The build checks that the hApp embeds the native-verified DNA bytes. Record the full release source commit and `release-manifest.json` SHA-256 in a trusted operator record. Preflight verifies that record against the release, checks the hApp, DNA and pinned gateway executable hashes, and compares the unpacked Chromium extension’s packaged files with the manifest’s Chromium ZIP. It checks the exact frontend file bytes, the installed cell binding, the gateway health and admin-route isolation, and the WSS upgrade. Confirm through the deployment record that the running gateway service uses the pinned executable and both native authorities use the verified hApp. [Release pins](../release/browser-alpha/pins.json)

### Live checklist

1. Stage the unused verified deployment on the authorized runner and confirm both private origins, certificates, and native authorities. Keep the private release metadata, profiles and admission snapshot on that runner.
2. Stage the three closed, distinct profiles with their verified extensions, exact pre-installed hApp and existing site approval. Confirm admission and the host and guest capabilities before the run.
3. Run preflight with a fresh owner-only report path.

```sh
python3 ci/alpha-operator/mixed-browser-run.py operator \
  --config /srv/imposter/test/private-input.json --report /srv/imposter/test/preflight.json
```

4. Once the report says `PREFLIGHT_VERIFIED`, run the same command with `--round` and a different report path. The runner checks the native game state for an unused deployment during preflight and rechecks the host before creating the lobby. Use a newly built, unused host-bound hApp if a prior run already created a lobby. Preflight performs no lobby writes and uses the pre-installed hApps.
5. Confirm `ROUND_VERIFIED` before recording live acceptance. The report must show two independent guest receipts, an actual Firefox process exit and relaunch of the same profile, renewed gateway authentication and a fresh Firefox receipt for the same round. It must also show all three browsers reached `Ended · Crew wins` with `Task completions: 1/1` after **Align Engine Output**. Share only the sanitized stage report.

For `OPERATOR_FRONTEND_*` or `OPERATOR_GATEWAY_*` errors, check the named origin’s Tailscale route, certificate trust, or served release and WSS response. `HOST_PROFILE_DOES_NOT_MATCH_DEPLOYMENT` identifies a host profile from a different release. `GATEWAY_ADMISSION_MISSING` or `GATEWAY_ROLE_CAPABILITY_MISSING` calls for the current approved admission state. An installed-hApp error names the affected browser. `OPERATOR_LOBBY_ALREADY_EXISTS` requires an unused deployment. A Firefox restart stage failure leaves live acceptance pending.

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
