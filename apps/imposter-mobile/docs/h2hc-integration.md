# Native H2HC integration: source and runtime contract

## Pinned dependency

Review snapshot: [Holochain-mobile commit 1d77076](https://github.com/ConorTttttt/Holochain-mobile/commit/1d77076debc0cdf3d870cf2f5e794b057c54f666).
The source is pinned because its tests and Android benchmarks used a modified
Holochain 0.7.1 conductor and a patched wasmer 7.1.0 wasmi backend.

From `apps/imposter-mobile`, run `bash scripts/prepare-h2hc.sh`.
The script checks out that exact commit, then runs its SHA256-checking
`scripts/vendor-holochain.sh`, which applies the recorded patches. Both the
checkout and its vendor tree are ignored by Git.

**Do not** replace the game zomes' Holochain 0.7.0 lockfile, regenerate DNA
hashes, or resolve a fresh Holochain source from the current upstream branch.

## IPC now supports an injected native backend

`src-tauri/src/native.rs` owns a single backend guarded by a lock.
It exposes app info, clone-cell creation/disable and bounded MessagePack calls
only after a backend is attached by native startup. The frontend has no app
token or native signer.

- `mobile_status` stays unavailable if there is no backend.
- Startup should verify the linker's **Ed25519 public key** against configured
  bytes using `H2hcOptions.expected_linker`. A bare linker URL is not enough.
- The persistent agent identity must be restored from an encrypted keystore
  unlocked by app-private key material. The benchmark's hard-coded passphrase
  and `DangerTestKeystore` must **never** be used in a shipped application.
- The runtime must install `workdir/imposter.happ`, not the test-only
  `notes.happ` used by `h2hc-phone`.
- A caller must not be marked ready until `get_app_info`, clone, call and
  signal paths are implemented and tested against the real conductor.

The new `src-tauri/src/h2hc.rs` contains the pinned API bootstrap for the
H2HC conductor and Imposter hApp. It is feature-gated until its version-locked
dependencies can be built and an Android keystore implementation exists.

## First live acceptance test

1. Native startup derives app-private data root, obtains a non-demo
   passphrase, checks the configured expected linker identity, and starts the
   zero-arc conductor.
2. Install or resume **imposter** with a stable agent key; compare hashes
   against desktop's packed hApp.
3. Create `room1.*`/host-owned game clone and call `get_game_state` without
   revealing any Holochain signing credential to the WebView.
4. Verify a desktop-to-phone role signal and a phone-to-desktop zome action.
5. Kill/restart the Android app and verify the agent key, clone list and game
   state are restored. Exercise invalid / offline linkers and reconnects.

The source has been staged and the IPC can host a real backend, but this is
**not yet an installable or working multiplayer Android build**.
