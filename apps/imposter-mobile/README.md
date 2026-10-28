# Imposter mobile — Android foundation and native Holochain IPC

The game UI in ../../ui is reused directly by this Tauri 2 shell. The touch
joystick and mobile CSS live in the shared UI, so the desktop game remains
unchanged for keyboard players. This is **not yet a working networked Android
app**: a restricted native Holochain IPC contract is present, but the native
conductor itself has not been embedded or configured.

## Run the UI and its tests

From the repository root:

    (cd ui && npm install && npm run typecheck && npm test && npm run build)

The joystick is shown when a coarse pointer is detected. The existing HUD
buttons remain the action controls; WASD/arrow keys still work on desktop.

## Android shell (requires local Android SDK/NDK, Rust Android targets, JDK)

    cd apps/imposter-mobile
    npm install
    npx tauri icon branding/icon.svg
    npm run android:init
    npm run android:dev

To attempt an APK build (the UI will not be able to join Holochain yet):

    npm run android:build

Do not distribute that shell as a functioning game. Neither an APK nor an
on-device runtime has been tested by this commit. The Tauri-generated Android
project is intentionally left to the android:init command, not checked in.

## Native Holochain interface (implemented, not yet connected)

The shared UI detects Tauri and uses `ui/src/mobile/native-client.ts` rather
than connecting to hc-spin or loading the desktop's shared-conductor token.
The Tauri-native `src-tauri/src/native.rs` exports only five fixed commands:

| Command | Return/input |
| --- | --- |
| `mobile_status` | readiness with explicit failure reason |
| `mobile_app_info` | agent key and cloned game cells, once available |
| `mobile_create_clone` | validated `g1.` or `room1.` network seed |
| `mobile_disable_clone` | game clone ID only |
| `mobile_call_zome` | allowlisted `game` zome function, bounded MessagePack bytes |

An `imposter://signal` event channel is defined on the UI side but will only
emit when H2HC app-signal subscriptions are implemented.

The current native implementation returns `unavailable` for readiness and
rejects all conductor actions. **This is deliberate**: it proves the routing,
serialization and fail-closed behavior without exposing a fake identity or
making insecure localhost connections. JS contract tests run in `npm test`,
and the Rust bridge includes validation unit tests.

## H2HC conductor integration — next milestone

- [ ] Adapt the H2HC phone conductor from
      ConorTttttt/Holochain-mobile (branch h2hc-prototype).
- [ ] Package Imposter's Holochain 0.7.0 DNA and test with the 0.7.1
      H2HC conductor before changing lockfiles or DNA hashes.
- [x] Define the native-only IPC contract with bounded, allowlisted requests,
      no WebView credentials and no silent desktop fallback.
- [ ] Replace the fail-closed Rust commands with an embedded H2HC conductor,
      secure persistent keystore and verified linker identity.
- [ ] Bridge app signals and clone-cell lifecycle (createCloneCell,
      disableCloneCell); preserve the lobby network-seed scheme.
- [ ] Verify PeerKit relay/WebRTC and microphone permissions on Android WebView.
- [ ] Exercise a mixed Android/desktop four-player game including restart and
      offline recovery, then benchmark idle CPU and battery use.

Important: the H2HC prototype requires a reachable linker and authority peers.
The phone is not itself a full DHT authority. Holochain-mobile documents
unfinished command idempotency, phone-side receipt durability and reconciliation.
None of those guarantees are silently assumed here.

Turbo Kart 0.5.0 supplied architecture lessons, not Android code: the checked-in
turbo-kart/apps/turbo-kart-desktop is an Electron/Kangaroo desktop application
with a restricted preload/sidecar boundary. The separation between the
untrusted game renderer and native credentials should be preserved in mobile.

## Mobile H2HC source review

`ConorTttttt/Holochain-mobile`, branch `h2hc-prototype` currently exports
`build_phone_conductor` in `prototypes/h2hc-conductor/src/lib.rs`. Its
`h2hc-phone` executable (`src/bin/h2hc-phone.rs`) operates a fixed notes
fixture through a line-oriented benchmark protocol. That executable is not an
Android app service or a general-purpose game-zome bridge. For Imposter, the
conductor must run in app process, install Imposter's hApp and preserve an agent
key across restarts, then implement the five native IPC commands and signal
channel above. We must also retain Holochain's patching and version pins from
that project when embedding. No secrets are configured or committed here.
