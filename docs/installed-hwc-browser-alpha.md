# Imposter browser alpha RC1

The supported alpha is a three-player browser lobby, confidential role delivery, one **Align Engine Output** task and the native crew-win result. The operator supplies a real host HWC public key, chooses the final frontend origin and admits the three player identities. Each player uses a persistent Chromium profile.

## Source and test evidence

The operator follow-up starts from RC1 `0b58e5a9cd45636cd19a5b845be93a9a0b42170d`. The release consumes the game at `0f7b17592e682a7b7d77e9346528cba69a096cdc`, applies the reviewed UI overlay to that checkout, and builds the stock HWC extension from `0c391226e78769d44ccb4661881ed8998b15f903` plus the integration patches. The gateway is the accepted revision-2 executable from artifact `14428255589`, applied source `9f5eb04b5be12e3e9e7fcc304bd905da1449ade9` and build recipe `293563649f7fd18a6bc2e0d1426c31132bf2b8c7`. [Pin file](../release/browser-alpha/pins.json) · [Gateway provenance](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44304976936/artifacts/14428255589)

The release regression used genuine Lair signatures, restricted gateway frames, real HWC receivers and native game state with SQLite-backed gateway admission. Each denial was observed twice across independently authenticated leases, followed by a legitimate recovery. The final gameplay gate completed one task and the native crew win. The CI extension includes worker-only test fixtures. The operator extension build checks that its assets exclude those fixtures. [Run 44353203661, commit 685b035f0ebbd229d68f06105d852505b3539d50](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661) · [Sanitized evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661/artifacts/14449278190)

| Requirement | Status | Verification or remaining dependency |
| --- | --- | --- |
| Malformed Merkle opening | PASS | 44353203661 at `685b035f0ebbd229d68f06105d852505b3539d50`. A host-signed, HPKE-encrypted delivery with a changed sibling reached native-root verification. Guest C rejected both frames and recovered on a fresh valid delivery. |
| Expired signed recipient attestation | PASS | 44353203661 at `685b035f0ebbd229d68f06105d852505b3539d50`. The signed current request carried an expired, independently Lair-signed inner key attestation. Both exchanges failed at the decrypted requester-attestation boundary, before a role reply. |
| Recipient epoch rollback | PASS | 44353203661 at `685b035f0ebbd229d68f06105d852505b3539d50`. Guest C advanced to a real epoch-two key and established the persistent host floor, then signed and sent a fresh epoch-one attestation on two leases. The host rejected it against observed native enrollment. |
| Encrypted roles, restart, revocation and shared task win | PASS | [44353203661](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661) at `685b035f0ebbd229d68f06105d852505b3539d50`. Gateway enqueue is recorded separately from independent extension receipts. The SQLite gateway admitted three profiles and passed revocation and reauthorization. |
| RC artifact verification | PASS | [44352786975](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44352786975) at `a54d44083f3764ff040023fb8887eabd5d2ab336`. Clean extension builds produced the same archive bytes. The package verified its native DNA, embedded hApp and checksums. The operator gate rejected the ephemeral distribution. [Checksums and provenance](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44352786975/artifacts/14449242124) |
| Operator-specific distribution | BLOCKED | Requires the intended host profile’s real public key and its seed. Exact build and verification commands are below. |
| Public/private config and setup bootstrap | PASS | Nine Python tests, five player setup tests, and a genuine installed HWC identity in Chromium. [Follow-up run 44360021935](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360021935) |
| Loopback HTTPS/WSS and static rollback | PASS | Trusted loopback TLS with Caddy 2.10.2 and the pinned gateway, including the WSS upgrade, restoration of the prior snapshot and denial of private routes. [Follow-up run 44360021935](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360021935) |
| Gateway and native restart | PASS | The real gateway retained its identity and SQLite admission and revocation state. Both Holochain 0.7 authorities reported the expected DNA and the same two distinct identities before and after restart. [Follow-up run 44360021935](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360021935) |
| Installed-browser follow-up | PASS | Three Chromium profiles passed native joins, independent role delivery, recipient isolation, restart recovery and replay, gateway revocation and fresh authentication, and the one-task crew victory. The signed malformed-proof, expired-attestation and rolled-back epoch checks also passed. [Follow-up run 44360022228](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360022228) · [Sanitized gameplay evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360022228/artifacts/14454491157) |
| External HTTPS/WSS deployment and three-player acceptance | NOT EXECUTED | Requires the operator’s site and gateway endpoints, bootstrap and relay, admission access and retained native/browser identities. |
| Full-map and desktop gameplay | NOT EXECUTED | The RC covers the one-task browser round. |

The installed workflow summary also reports legacy diagnostics separately. Direct native SQL readback and the separate invalid-lobby native probe remain blocked in that harness. The supported round uses exact-action native admin validation and public native readback.

### Follow-up artifact checksums

These values come from the `EPHEMERAL_CI_ONLY` verification build at `da2696f3573aba5940bf9769844b36f9b580ae41`. The operator package uses the retained host’s real public key and seed and has its own hApp, DNA and manifest values. The workflow retains the sanitized evidence ZIP only. The operator deploy command rejects the CI-only package. [Packaging run](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360021935) · [Sanitized evidence ZIP](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360021935/artifacts/14454084700)

| Artifact | SHA-256 or native DNA identity |
| --- | --- |
| `chromium-hwc.zip` | `8af423c2512d88fde1ae47fecc6a53861c683a085341b02c60c2296e1d9396df` |
| `frontend/imposter-browser-poc.happ` | `17026e4a9762e864198422b2c4994a7338af99cdb0c9d67519ce862ad4d8383a` |
| `backend/game.dna` | `b3a36e3aa3daec5339536fcf8982b648a2182629e2c64a282761eb0210943f18` |
| Native DNA hash | `uhC0kjlrEy1zZlksWHli09MVX4DTxi6XRUYWvXaWycsKAYXw87iNv` |
| `backend/h2hc-linker-linux-x86_64` | `8f3f8e0b6a6fc02b27776182458cf0d970bc02f76db9f6f6b6842c04f138746f` |
| `release-manifest.json` | `35a27a631bf7939e5868d22f0ae000a795230cfe7308c7821268c59f689c0303` |
| Sanitized evidence ZIP | `38075cedebd2c3dea76cab718e1f25feeccbfd8bf1983456c966bc9160c42a5a` |
| Sanitized installed-gameplay evidence ZIP | `28110c0b93391588664eba0959916f5c3829fb5755afd0b36298ddc5fbfb230b` |

## Deployment checklist

- [ ] Choose the final frontend and gateway HTTPS origins and reserve operator-owned Kitsune bootstrap and relay endpoints.
- [ ] Install the pinned toolchain, verify the gateway checksum and retain that executable in operator-controlled storage.
- [ ] Create three persistent Chromium profiles and collect their public HWC agent keys from the final frontend origin.
- [ ] Build with the retained host key and seed. Keep the release commit, manifest SHA-256, hApp digest and DNA hash in the operator’s release record.
- [ ] Publish a complete static snapshot and start the validated TLS proxy, gateway and two native authorities.
- [ ] Pass HTTPS/WSS preflight and native DNA inspection. Confirm both authorities have full storage arcs.
- [ ] Admit the host and two guests, share the [player installation guide](browser-alpha-player.md), and record the ten acceptance results below.
- [ ] Retain the previous published package and verify a static rollback with the same origins and exact hApp before inviting testers.

## Operator build and deployment

### 1. Choose the final origin and build HWC

Use Linux x86-64 with Git, Bash, GNU coreutils, Python 3.11+, Node.js 22.22.0 with npm, jq, Nix, OpenSSL and the GitHub CLI. The committed flake selects Holochain 0.7.0. Allow the documented Holochain CI binary cache on the operator host if desired. Obtain Caddy or an equivalent HTTPS reverse proxy. Reserve a stable frontend origin and a distinct gateway origin, two persistent native authorities with the same Kitsune bootstrap and relay as the gateway, and a private operator state directory. Static hosting can serve the frontend root paths. The gateway and conductors run on operator infrastructure.

From a clean clone of the [operator follow-up branch](https://github.com/ConorTttttt/imposter-holochain/tree/followup/browser-alpha-operator), select the release commit and set two new checkout paths. The explicit fetch also works when the release branch was cloned by itself.

```bash
rc="$PWD/release/browser-alpha"
release_commit="$(git rev-parse HEAD)"
game=/absolute/path/to/pinned-game-checkout
hwc=/absolute/path/to/pinned-hwc-checkout

game_pin="$(jq -er .game_commit "$rc/pins.json")"
git fetch origin "$game_pin"
git worktree add --detach "$game" "$game_pin"
git clone https://github.com/Holo-Host/holo-web-conductor.git "$hwc"
git -C "$hwc" switch --detach "$(jq -er .hwc_commit "$rc/pins.json")"
test "$(git -C "$game" rev-parse HEAD)" = "$(jq -er .game_commit "$rc/pins.json")"
test "$(git -C "$hwc" rev-parse HEAD)" = "$(jq -er .hwc_commit "$rc/pins.json")"
bash "$rc/build-extension.sh" "$hwc"
```

In Chromium, use **Load unpacked** with `$hwc/packages/extension/dist-chrome`. Keep the host profile and its unpacked extension path once it has established its public identity. Moving an unpacked extension can change its Chromium extension ID and its backing Lair storage. Each guest needs a separate persistent profile.

### 2. Bootstrap the host identity

Copy `public.example.json` and `operator.example.json` from the release directory to an operator-only configuration directory. Fill in the actual HTTPS URLs, a new managed static root and the private state paths. Enter frontend and gateway as canonical HTTPS origins without trailing slashes. Give Caddy read and traverse permissions on the public static tree. Give the operator write access to that tree and keep backend paths under the service accounts. Generate the gateway administration secret on the gateway machine and assign a file readable only by the gateway account. Keep this file outside the checkout, artifact directory and served root. After setting the configuration variables below, generate the secret as the account that owns the private gateway directory.

```bash
public_config=/absolute/path/to/public.json
operator_config=/absolute/path/to/operator.json
admin_secret_file="$(jq -er .admin_secret_file "$operator_config")"
settings=(--public "$public_config" --operator "$operator_config")
proxy_file="$(dirname "$operator_config")/Caddyfile"
(umask 077; set -o noclobber; openssl rand -hex 32 > "$admin_secret_file")
python3 "$rc/deploy.py" check "${settings[@]}"
python3 "$rc/deploy.py" bootstrap-site "${settings[@]}"
python3 "$rc/deploy.py" render-proxy "${settings[@]}" > "$proxy_file"
caddy validate --config "$proxy_file" --adapter caddyfile
```

Start the validated proxy in a separate service session with `caddy run --config "$proxy_file" --adapter caddyfile`, or install that config into the operator’s Caddy service. Configure DNS, TLS certificates and access to the HTTPS listener for both hosts. The frontend serves only the public routes under the managed `current` snapshot. A previous flat site can stay in its own directory while the operator tests the new managed root. The gateway site forwards WebSocket and HTTP traffic to loopback port 8090 and denies the public admin path. Keep native admin ports on a loopback or firewall-protected interface. Confirm that Chromium trusts the TLS certificates.

Open `/browser-setup.html` on the final HTTPS frontend in the retained host profile. Select **Connect HWC**, approve the origin in HWC and copy the resulting public key. The same page can collect the guests’ public keys before publishing. Host identity depends on the origin and extension profile.

### 3. Build and verify the distribution

Fetch artifact `14428255589` from run `44304976936` and retain the executable in operator-controlled storage. The artifact has a retention date of 2 December 2026. The build requires the executable SHA-256 in `pins.json`.

```bash
gh api repos/ConorTttttt/imposter-holochain/actions/artifacts/14428255589 \
  | jq -e '.workflow_run.id == 44304976936 and .workflow_run.head_sha == "293563649f7fd18a6bc2e0d1426c31132bf2b8c7" and (.expired | not)'
gh run download 44304976936 -R ConorTttttt/imposter-holochain \
  -n agent3-h2hc-p0-security-44304976936 -D gateway-artifact
gateway="$PWD/gateway-artifact/role-gateway/h2hc-linker-linux-x86_64"
read -r -p 'Public key from the retained host profile: ' host
seed="$(sh "$game/scripts/browser-poc-seed.sh" "$host")"
out=/absolute/path/to/new-rc1-directory

bash "$rc/build.sh" "$game" "$hwc" "$host" "$seed" "$gateway" "$out"
manifest_sha="$(sha256sum "$out/release-manifest.json" | cut -d ' ' -f 1)"
python3 "$rc/package.py" verify "$out" --release-commit "$release_commit" \
  --manifest-sha256 "$manifest_sha"
(cd "$out" && sha256sum --check SHA256SUMS)
```

Retain the source commit, host public key, seed, manifest and checksum list with the operator records. Keep the same seed to reproduce this hApp in a clean build. The build uses the pinned Nix and npm inputs, recomputes the native DNA hash, and compares the native DNA bytes with the DNA embedded in the hApp. It emits `chromium-hwc.zip`, the site assets, the pinned gateway and verified DNA in `backend/`, the config templates, and `release-manifest.json` with `SHA256SUMS`. The manifest records an operator-supplied **public** identity. Confirm custody by reconnecting from the actual host profile. Record the manifest SHA-256 alongside the release commit in trusted operator records and share the expected extension checksum with testers. When verifying an archive received from another machine, use the independently recorded checksum. Guests can unpack `chromium-hwc.zip` to a stable local directory and load it in their own profile. The established host can retain the original verified unpacked build and location.

### 4. Publish and start services

```bash
distribution=(--release "$out" --release-commit "$release_commit" --manifest-sha256 "$manifest_sha")
python3 "$rc/deploy.py" publish "${settings[@]}" "${distribution[@]}"
python3 "$rc/deploy.py" gateway "${settings[@]}" "${distribution[@]}"
```

Start the gateway command in a separate service session under the account that owns the persistent gateway key and SQLite session directory. Create the private state directories before starting it. Keep both directories private. The script turns off insecure development and local-authority fallbacks and takes the admin credential from the configured private file.

Run the two native authorities from the pinned game checkout. `init-native` installs the exact packaged hApp into both authorities and binds their state directory to its digest and the bootstrap/relay configuration. Retain that directory and Lair passphrase on the authority host. Start `run-native` in its own service session, then query both authorities from another shell.

```bash
(cd "$game" && nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file --command \
  python3 "$rc/deploy.py" init-native "${settings[@]}" "${distribution[@]}")
(cd "$game" && nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file --command \
  python3 "$rc/deploy.py" run-native "${settings[@]}" "${distribution[@]}")
(cd "$game" && nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file --command \
  python3 "$rc/deploy.py" native-status "${settings[@]}" "${distribution[@]}")
```

Use `init-native` once per bound state directory. Stop the running authority service before launching it again with the same directory. The launcher opens private native admin ports `33555` and `33557`. Verify the bindings locally with `ss -ltn` and keep them off public firewall and proxy routes. Check authority service logs locally for full storage arcs. `native-status` verifies installed DNA and separate identities. For the round, corroborate the public lobby and join op hashes with native DHT readback.

```bash
python3 "$rc/deploy.py" preflight "${settings[@]}" "${distribution[@]}"
read -r -p 'Guest B public key: ' guest_b
read -r -p 'Guest C public key: ' guest_c
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role host --agent "$host"
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role guest --agent "$guest_b"
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role guest --agent "$guest_c"
```

Run admission locally on the gateway host as the account that can read the private gateway secret file. The host receives delivery capability and the two guests receive request capability. The preflight verifies real TLS, served asset bytes, the public admin denial and WSS upgrade. Full acceptance requires the player round below.

### 5. Play, recover and revoke

1. Each player opens **Browser setup**, connects HWC and selects **Install game and connect** after the operator admits the public key. The page checks the downloaded hApp digest, expected DNA, profile identity and gateway session. Open the lobby when those checks pass.
2. The host selects **Create lobby** and both guests select **Join lobby**. Verify the same three seats in all profiles.
3. Select **Start round** as host. Confirm each page shows only its own verified role.
4. Before completing the task, restart Chromium with the same profile and unpacked extension path during acceptance. Recover the current seat and session before continuing. The game’s **Retry connection** and the setup page’s **Reconnect** action recover transient connection failures.
5. A crewmate selects **Align Engine Output**. Verify every page reaches **Ended · Crew wins** with **Task completions 1/1**.
6. To revoke a player, run `python3 "$rc/deploy.py" revoke "${settings[@]}" "${distribution[@]}" --agent "$guest_b"` on the gateway machine. Confirm the old session loses access. Reauthorization uses `admit` again and a fresh signed connection.

## Rollback and recovery

This static rollback uses a previously published full package with the same frontend and gateway origins and exact hApp bytes. The operator tool verifies the prior package and staged files before atomically swapping the active link. Caddy continues serving the same URL. The gateway key, admission database, native authorities and installed player profiles continue using their current state.

```bash
previous=/absolute/path/to/previous-verified-release
read -r -p 'Previous release commit: ' previous_commit
read -r -p 'Trusted previous manifest SHA-256: ' previous_manifest_sha
prior=(--release "$previous" --release-commit "$previous_commit" --manifest-sha256 "$previous_manifest_sha")
python3 "$rc/deploy.py" rollback "${settings[@]}" "${prior[@]}"
python3 "$rc/deploy.py" preflight "${settings[@]}" "${prior[@]}"
```

Use the original trusted release record for both inputs. Refresh the three browser pages and check that the same site, player identities and DNA appear. Retain the prior full package and its managed snapshot until the next release is accepted. Keep the current gateway database in use when rolling back a frontend so revocations remain effective. For the first publication with no prior game snapshot, use the proxy’s maintenance routing to stop tester access while recovering the release.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HWC missing or access denied | Load the verified unpacked extension in the intended Chromium profile, reload the final HTTPS origin and approve it in HWC. |
| Public key changed | Return to the original Chromium profile and unpacked extension directory on the same origin. Compare the public key with the operator’s admission entry before rebuilding anything. |
| hApp checksum or DNA mismatch | Compare served bytes with the verified manifest using `preflight`. Locate the original profile or correct host-bound distribution. |
| Gateway unreachable | Check public certificates, DNS, `/health` and WSS upgrade with `preflight`. Check the gateway process bound to loopback port 8090. |
| Admission pending | Confirm the exact public key and host/guest capability. Use `admission-status` on the gateway host, then select **Reconnect** from setup. |
| Lobby or task state fails to converge | Run `native-status` and confirm both authorities advertise full arcs on the same bootstrap/relay pair. Compare the exact lobby and join action hashes on an authority. |
| Authority restart fails | Check the pinned `hc` version, matching hApp digest and local binding, port ownership and the retained Lair passphrase. |
| Static rollback refuses a release | Verify the prior manifest SHA and publish history. The previous snapshot must share the original origins and exact hApp digest. |

## External operator acceptance record

**Status for the intended operator network is NOT EXECUTED.** Record each result with UTC time, release commit, manifest SHA-256 and public action identifiers. Keep role values, key material, session tokens and operator credentials off the shared record.

| Gate | Evidence to collect on the intended HTTPS/WSS network | Status |
| --- | --- | --- |
| Three independent authenticated profiles | Three distinct public HWC keys and a healthy signed session for each profile on the configured gateway. | NOT EXECUTED |
| Native-valid lobby and joins | Exact public lobby and join actions with corresponding valid native DHT evidence. Use the [native CI audit](../ci/installed-role/acceptance.mjs) as the reference. | NOT EXECUTED |
| Host starts the round | Exact native RoleCommit and Playing phase, with the same commitment across profiles. | NOT EXECUTED |
| Both guests decrypt their own role | Both pages show a verified own role. In each extension worker, record the public commitment from `HWC_EXTENSION_LOCAL_ENCRYPTED_ROLE_RECEIPT_VERIFIED`. | NOT EXECUTED |
| Guest C isolation | In Guest C’s profile a cross-recipient `get_verified_browser_role` request with Guest B’s public key is denied by `PRIVATE_ROLE_ORIGIN_OR_PAYLOAD_DENIED`, while normal own-role retrieval succeeds. | NOT EXECUTED |
| Align Engine Output | A crewmate submits the single supported task and shared progress reaches 1/1. | NOT EXECUTED |
| Shared crew victory | All three profiles show **Ended · Crew wins** for the same round. | NOT EXECUTED |
| Chromium restart | Close and reopen one retained profile before the task. Verify its public key, DNA, seat and recoverable round state. | NOT EXECUTED |
| Revocation | Run `revoke` while the guest is connected. Confirm HWC loses the session and `admission-status` reports `allowed: false` and zero active sessions. | NOT EXECUTED |
| Fresh reauthorization | Close the revoked profile. Re-admit it, confirm zero active sessions, then reopen and reconnect. Verify authenticated status and a new active session. | NOT EXECUTED |

For the public action record, attach this listener in each game tab before creating the lobby. It logs only the action kind and its public hash. Preserve the resulting create, join and start identifiers with the acceptance results.

```js
window.addEventListener('imposter:action', ({detail: {kind, record}}) => {
  const value = kind === 'start' ? record.role_commit : record.signed_action?.hashed?.hash;
  const bytes = value?.length === undefined ? Object.values(value ?? {}) : value;
  if (bytes.length !== 39) return;
  const base64 = btoa(String.fromCharCode(...bytes));
  console.info(kind, 'u' + base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
});
```

For the cross-recipient probe, use Guest C’s browser console on the approved game origin, replacing the placeholder with Guest B’s public key. Record only the denial.

```js
await window.holochain.callZome({
  zome_name: 'game',
  fn_name: 'get_verified_browser_role',
  payload: {recipient: 'GUEST_B_PUBLIC_KEY'},
});
```

For each authority, run `hc client call --port 33555 dump-op-timings "$dna_hash" --limit 2000` from the pinned Nix shell, then repeat on port `33557`. Set `dna_hash` to the verified manifest’s `game.dna_hash`. The pinned CI action-to-op diagnostic shows how to reconstruct op hashes from the public signed Create action using the pinned HWC hashing code. Match those hashes to authority rows with valid status, local validation and an integration timestamp. Keep local authority logs and unrelated DHT data outside the shared record. [Exact-action diagnostic](https://github.com/ConorTttttt/imposter-holochain/blob/f49b0dfcc9f8b86a3e2abcd48e6c13375c347ed5/ci/agent3-h2hc-kit/instrument_exact_lobby_op.py)

Run the status check on the gateway host with the same configuration and verified release arguments. `active_sessions` counts credentials in the gateway store. Corroborate the live WSS connection in the browser setup page.

```bash
python3 "$rc/deploy.py" admission-status "${settings[@]}" "${distribution[@]}" --agent "$guest_b"
```

## Supported gameplay

RC1 supports three Chromium/HWC players, lobby creation and joining, one round, verified private host and guest roles, **Align Engine Output**, a shared native crew victory, and reattachment to the same player profile. The alpha leaves full-map play, additional tasks, killing, sabotage, meetings, voting, desktop interoperability and general public matchmaking outside the supported game.
