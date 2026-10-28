# Imposter mobile — initial Android scaffold

The game UI in ../../ui is reused directly by this Tauri 2 shell. The touch
joystick and mobile CSS live in the shared UI, so the desktop game remains
unchanged for keyboard players. This is **not yet a working networked Android
app**: the native Holochain conductor integration is the next milestone.

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

## Native multiplayer integration — next milestone

- [ ] Adapt the H2HC phone conductor from
      ConorTttttt/Holochain-mobile (branch h2hc-prototype).
- [ ] Package Imposter's Holochain 0.7.0 DNA and test with the 0.7.1
      H2HC conductor before changing lockfiles or DNA hashes.
- [ ] Keep the native conductor, keystore and tokens outside the WebView.
      Export only narrowly scoped app/zome calls through a validated bridge.
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
