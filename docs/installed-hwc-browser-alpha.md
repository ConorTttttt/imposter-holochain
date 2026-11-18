# Imposter browser alpha RC1

The supported alpha is a three-player browser lobby, confidential role delivery, one **Align Engine Output** task and the native crew-win result. The operator supplies a real host HWC public key, chooses the final frontend origin and admits the three player identities. Each player uses a persistent Chromium profile.

## Source and test evidence

The release branch starts from integration `ed66d6f1a7df60544d50f4e6219f97c1dadf953a`. The verified gameplay code was `94a71b15b345e482b9f96953b419bc2c95432a23`, with run [44345067844](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44345067844). Compared with `main@111e6a44795e6572ed01191a98245ed723788c12`, integration supplies the HWC compatibility kit and browser harness. The release consumes the Agent 4 game once at `0f7b17592e682a7b7d77e9346528cba69a096cdc`, applies the release UI overlay to that checkout, and builds the stock HWC extension from `0c391226e78769d44ccb4661881ed8998b15f903` plus the integration patches. The gateway is the accepted revision-2 executable from artifact `14428255589`, applied source `9f5eb04b5be12e3e9e7fcc304bd905da1449ade9`. [Pin file](../release/browser-alpha/pins.json) · [Gateway provenance](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44304976936/artifacts/14428255589)

The release regression used genuine Lair signatures, restricted gateway frames, real HWC receivers and native game state with SQLite-backed gateway admission. Each denial was observed twice across independently authenticated leases, followed by a legitimate recovery. The final gameplay gate completed one task and the native crew win. The CI extension includes worker-only test fixtures. The operator extension build checks that its assets exclude those fixtures. [Run 44353203661, commit 685b035f0ebbd229d68f06105d852505b3539d50](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661) · [Sanitized evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661/artifacts/14449278190)

| Requirement | Status | Verification or remaining dependency |
| --- | --- | --- |
| Malformed Merkle opening | PASS | 44353203661 at `685b035f0ebbd229d68f06105d852505b3539d50`. A host-signed, HPKE-encrypted delivery with a changed sibling reached native-root verification. Guest C rejected both frames and recovered on a fresh valid delivery. |
| Expired signed recipient attestation | PASS | 44353203661 at `685b035f0ebbd229d68f06105d852505b3539d50`. The signed current request carried an expired, independently Lair-signed inner key attestation. Both exchanges failed at the decrypted requester-attestation boundary, before a role reply. |
| Recipient epoch rollback | PASS | 44353203661 at `685b035f0ebbd229d68f06105d852505b3539d50`. Guest C advanced to a real epoch-two key and established the persistent host floor, then signed and sent a fresh epoch-one attestation on two leases. The host rejected it against observed native enrollment. |
| Encrypted roles, restart, revocation and shared task win | PASS | [44353203661](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661) at `685b035f0ebbd229d68f06105d852505b3539d50`. Gateway enqueue is recorded separately from independent extension receipts. The SQLite gateway admitted three profiles and passed revocation and reauthorization. |
| RC artifact verification | PASS | [44352786975](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44352786975) at `a54d44083f3764ff040023fb8887eabd5d2ab336`. Clean extension builds produced the same archive bytes. The package verified its native DNA, embedded hApp and checksums. The operator gate rejected the ephemeral distribution. [Checksums and provenance](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44352786975/artifacts/14449242124) |
| Operator-specific distribution | BLOCKED | Requires the intended host profile’s real public key and its seed. Exact build and verification commands are below. |
| Public/private config and setup bootstrap | PASS | Seven local config and archive regressions, native Caddy 2.10.2 configuration validation, and a genuine Chromium HWC identity through the setup page. The live network is tracked separately. |
| External HTTPS/WSS deployment and three-player acceptance | NOT EXECUTED | Requires the operator’s site and gateway endpoints, bootstrap and relay, admission access and retained native/browser identities. |
| Full-map and desktop gameplay | NOT EXECUTED | The RC covers the one-task browser round. |

## Operator build and deployment

### 1. Choose the final origin and build HWC

Use Linux with Git, Bash, Python 3.11+, Node.js 22.22.0, npm, jq and the pinned Holochain Nix shell. Obtain Caddy or an equivalent HTTPS reverse proxy. Reserve a stable frontend origin and a distinct gateway origin, two persistent native authorities with the same Kitsune bootstrap and relay as the gateway, and a private operator state directory. Static hosting can serve the frontend root paths. The gateway and conductors run on operator infrastructure.

From a clone of the release branch, set the two checkout paths. Create the checkouts if needed.

```bash
rc="$PWD/release/browser-alpha"
release_commit="$(git rev-parse HEAD)"
game=/absolute/path/to/pinned-game-checkout
hwc=/absolute/path/to/pinned-hwc-checkout

git worktree add --detach "$game" "$(jq -er .game_commit "$rc/pins.json")"
git clone https://github.com/Holo-Host/holo-web-conductor.git "$hwc"
git -C "$hwc" switch --detach "$(jq -er .hwc_commit "$rc/pins.json")"
test "$(git -C "$game" rev-parse HEAD)" = "$(jq -er .game_commit "$rc/pins.json")"
test "$(git -C "$hwc" rev-parse HEAD)" = "$(jq -er .hwc_commit "$rc/pins.json")"
bash "$rc/build-extension.sh" "$hwc"
```

In Chromium, use **Load unpacked** with `$hwc/packages/extension/dist-chrome`. Keep the host profile and its unpacked extension path once it has established its public identity. Moving an unpacked extension can change its Chromium extension ID and its backing Lair storage. Each guest needs a separate persistent profile.

### 2. Bootstrap the host identity

Copy `public.example.json` and `operator.example.json` from the release directory to an operator-only configuration directory. Fill in the actual HTTPS URLs, static root and private paths. Generate the gateway administration secret on the gateway machine and assign a file readable only by the gateway account. Keep this file outside the checkout, artifact directory and served root. An example command is `(umask 077; set -o noclobber; openssl rand -hex 32 > "$admin_secret_file")` for a new secret.

```bash
settings=(--public /absolute/path/to/public.json --operator /absolute/path/to/operator.json)
python3 "$rc/deploy.py" check "${settings[@]}"
python3 "$rc/deploy.py" bootstrap-site "${settings[@]}"
python3 "$rc/deploy.py" render-proxy "${settings[@]}" > Caddyfile
caddy validate --config Caddyfile --adapter caddyfile
```

Start the validated proxy on the operator host. Its frontend serves only alpha assets. Its gateway site forwards WebSocket and HTTP traffic to loopback port 8090 and denies the public admin path. Keep native admin ports on a loopback or firewall-protected interface. Confirm TLS certificates are trusted by the Chromium profiles.

Open `/browser-setup.html` on the final HTTPS frontend in the retained host profile. Select **Connect HWC**, approve the origin in HWC and copy the resulting public key. The same page can collect the guests’ public keys before publishing. Host identity depends on the origin and extension profile.

### 3. Build and verify the distribution

Fetch the accepted gateway executable and retain its provenance. The script requires the exact SHA-256 in `pins.json`.

```bash
gh run download 44304976936 -R ConorTttttt/imposter-holochain \
  -n agent3-h2hc-p0-security-44304976936 -D gateway-artifact
gateway="$PWD/gateway-artifact/role-gateway/h2hc-linker-linux-x86_64"
read -r -p 'Public key from the retained host profile: ' host
seed="$(sh "$game/scripts/browser-poc-seed.sh" "$host")"
out=/absolute/path/to/new-rc1-directory

bash "$rc/build.sh" "$game" "$hwc" "$host" "$seed" "$gateway" "$out"
python3 "$rc/package.py" verify "$out" --release-commit "$release_commit"
(cd "$out" && sha256sum --check SHA256SUMS)
```

Retain the source commit, host public key, seed, manifest and checksum list with the operator records. Keep the same seed to reproduce this hApp in a clean build. The build uses the pinned Nix and npm inputs, recomputes the native DNA hash, and compares the native DNA bytes with the DNA embedded in the hApp. It emits `chromium-hwc.zip`, the site assets, the pinned gateway and verified DNA in `backend/`, the config templates, and `release-manifest.json` with `SHA256SUMS`. The manifest records an operator-supplied **public** identity. Confirm custody by reconnecting from the actual host profile. Independently distribute the expected checksums to operators and testers through a trusted channel. Guests can unpack `chromium-hwc.zip` to a stable local directory and load it in their own profile. The established host can retain the original verified unpacked build and location.

### 4. Publish and start services

```bash
distribution=(--release "$out" --release-commit "$release_commit")
python3 "$rc/deploy.py" publish "${settings[@]}" "${distribution[@]}"
python3 "$rc/deploy.py" gateway "${settings[@]}" "${distribution[@]}"
```

Start the gateway command in a separate service session under the account that owns the persistent gateway key and SQLite session directory. Create the private state directories before starting it. Keep both directories private. The script turns off insecure development and local-authority fallbacks and takes the admin credential from the configured private file.

Run the two native authorities from the pinned game checkout. Their persistent state directory and Lair passphrase belong to the operator. Install the exact packaged hApp on both authorities and wait for matching DNA and full storage arcs before admitting players.

```bash
(cd "$game" && nix develop --no-write-lock-file --command \
  python3 "$rc/deploy.py" init-native "${settings[@]}" "${distribution[@]}")
(cd "$game" && nix develop --no-write-lock-file --command \
  python3 "$rc/deploy.py" run-native "${settings[@]}" "${distribution[@]}")
```

Use `init-native` once per deployment state directory. Run `run-native` again to recover that state. Keep the native admin and app ports private. Confirm native DHT readback of the exact lobby and commitment actions during the acceptance round.

```bash
python3 "$rc/deploy.py" preflight "${settings[@]}" "${distribution[@]}"
read -r -p 'Guest B public key: ' guest_b
read -r -p 'Guest C public key: ' guest_c
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role host --agent "$host"
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role guest --agent "$guest_b"
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role guest --agent "$guest_c"
```

Run admission locally on the gateway host. The host receives delivery capability and the two guests receive request capability. The preflight verifies real TLS, served asset bytes, the public admin denial and WSS upgrade. Full acceptance requires the player round below.

### 5. Play, recover and revoke

1. Each player opens **Browser setup**, connects HWC and selects **Install game and connect** after the operator admits the public key. The page checks the downloaded hApp digest, expected DNA, profile identity and gateway session. Open the lobby when those checks pass.
2. The host selects **Create lobby** and both guests select **Join lobby**. Verify the same three seats in all profiles.
3. Select **Start round** as host. Confirm each page shows only its own verified role. A crewmate selects **Align Engine Output**. Verify every page reaches **Ended · Crew wins** with **Task completions 1/1**.
4. Restart Chromium with the same profile and unpacked extension path during acceptance. Recover the current seat and session before continuing. The game’s **Retry connection** and the setup page’s **Reconnect** action recover transient connection failures.
5. To revoke a player, run `python3 "$rc/deploy.py" revoke "${settings[@]}" "${distribution[@]}" --agent "$guest_b"` on the gateway machine. Confirm the old session loses access. Reauthorization uses `admit` again and a fresh signed connection.

If HWC is missing, load the exact build in the intended Chromium profile. If the DNA differs, verify the site origin and release checksums and locate the correct profile. If gateway authentication fails, check public TLS/WSS preflight and the admission key. If players authenticate but seats or state fail to converge, check both native authorities’ identical DNA, full arcs and bootstrap/relay connectivity.

## Before inviting external testers

1. Run the operator round using `release/browser-alpha/deploy.py` and `ci/installed-role/acceptance.mjs` as a gate reference. Record HTTPS/WSS startup, native action validation, both isolated receipts, shared victory, restart and real revocation on the intended deployment.
2. Retain the accepted gateway, exact extension and host-bound release manifest in stable operator-controlled artifact storage. Use `release/browser-alpha/pins.json` and `package.py` to verify a second operator can build and validate the same release inputs.
3. Exercise the production setup page on the final origin with three retained profiles. Verify the browser refuses wrong-DNA and tampered hApp downloads, all three profiles maintain their identities after restart, and setup can guide a rejected guest through admission and reconnection. [Setup script](../release/browser-alpha/frontend/browser-setup.js)
