# Unified Chrome and Firefox browser candidate

This is a draft for private Ubuntu acceptance. Operator acceptance is pending. The candidate uses one host-bound DNA installation per profile and a distinct native Lobby action per game.

## Sources and integration decisions

| Source | Commit |
| --- | --- |
| Repeatable Firefox integration | 41b8572fb768189f551749881466070dc9f16625 |
| Full browser gameplay | 88632f15a76491706b261c238c65e8c4ea3cf89f |
| Firefox baseline and common ancestor | 968c6e1c4d66d852faeb534c9486019deadbadfb |
| Repeatable browser lobby feature | 12ea762141a734e23eca6827b0570e3310dd413d |

The repeatable page owns identity, gateway selection, refresh and New Game. The gameplay controllers mount into that page. The original gameplay HTML rewrite depended on a deployment seed shared by every round. Here the page captures the selected Lobby when creating callbacks and HWC checks the selected action for gameplay writes. The relay verifies signed challenges and asks a native authority for the roster. The assembly script applies the repeatable and unified native patches in order to the pinned checkout. The release inventory includes both extensions, the relay, native hApp and DNA, deployment metadata and frontend. Publication serves only the frontend inventory.

The gameplay and repeatable branches both changed the mixed-browser workflow, fixture driver, release builder and proxy configuration. The combined fixture boots the repeatable installation once, launches the relay against its authority and gateway database, changes one Chromium guest between rounds and uses Firefox in both rounds. The native tally checks the meeting and RoleCommit before ejection evidence can contribute to a result.

The existing hosted evidence covers the individual inputs. The Chromium persistence job ran at 1e497bbc566cd3ccdb2e5a7369d08bb632c2b934. Its result covers persistence at that revision. [Gameplay](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44545282579) · [Repeatable lobbies](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44579828513) · [Chromium persistence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44580406538) · [Candidate runs](https://github.com/ConorTttttt/imposter-holochain/actions?query=branch%3Aintegration%2Fbrowser-unified-gameplay)

## Build on Ubuntu

Use Node 22.22.0, Git, jq, Python 3, npm, Nix with flakes and the Holochain 0.7.0 environment from the pinned game checkout. Use the public host key obtained in the candidate Chromium profile at the candidate origin. The build verifies the pinned gateway executable and the clean native game source. Prepare separate pinned game and HWC checkouts at the revisions in release/browser-alpha/pins.json. Run from the candidate repository root.

```bash
set -euo pipefail
base=/mnt/holochain/imposter-server
candidate="$base/builds/imposter-alpha-unified-1"
rc=release/browser-alpha
commit=$(git rev-parse HEAD)
: "${GAME_CHECKOUT:?pinned game source}" "${HWC_CHECKOUT:?pinned HWC source}"
: "${GATEWAY_BINARY:?accepted executable}" "${HOST_KEY:?candidate public key}"
seed="g1.$HOST_KEY.$(openssl rand -hex 16)"
bash "$rc/build.sh" "$GAME_CHECKOUT" "$HWC_CHECKOUT" "$HOST_KEY" "$seed" "$GATEWAY_BINARY" "$candidate"
(cd "$candidate" && sha256sum --check SHA256SUMS)
python3 "$rc/package.py" verify "$candidate" --release-commit "$commit"
sha256sum "$candidate/release-manifest.json"
jq '{release_commit,game,artifacts}' "$candidate/release-manifest.json"
```

Record the accepted manifest digest independently. The hApp and DNA hash depend on that build's host and seed. The changed integrity WASM requires a new installation at the candidate origin and new authority state. Historical games from the original deployment remain available through its existing origin, profiles and conductors.

## Side-by-side deployment

Use a separate candidate origin, static root, private config directory, native state directory and browser profiles. Copy the public and operator config templates there and fill in the candidate paths and existing Tailscale HTTPS endpoints. Use the accepted gateway and its actual session database. The relay currently requires local access to one authority admin port and read-only access to that database on the same trusted machine. Keep admin interfaces on loopback.

```bash
: "${PUBLIC_CONFIG:?candidate public JSON}" "${OPERATOR_CONFIG:?private operator JSON}"
: "${MANIFEST_SHA256:?independently recorded digest}"
deploy=(python3 "$rc/deploy.py" --public "$PUBLIC_CONFIG" --operator "$OPERATOR_CONFIG"
  --release "$candidate" --release-commit "$commit" --manifest-sha256 "$MANIFEST_SHA256")
"${deploy[@]}" check
"${deploy[@]}" render-proxy --movement-port 8092
"${deploy[@]}" publish
"${deploy[@]}" preflight
```

Use the rendered candidate frontend stanza in Caddy and retain the existing gateway stanza once. The candidate frontend forwards /gameplay-movement to loopback port 8092. Validate the combined Caddy configuration before reloading. From a shell with the pinned hc CLI, initialize the two candidate authorities once. Run the persistent services in separate supervised processes.

```bash
"${deploy[@]}" init-native --native-admin-ports 33655,33657
"${deploy[@]}" run-native --native-admin-ports 33655,33657
# In another shell with the same variables:
"${deploy[@]}" native-status --native-admin-ports 33655,33657
node "$candidate/backend/movement-relay.mjs" "$(jq -er .frontend_origin "$PUBLIC_CONFIG")" 8092 33655 "$(jq -er .gateway_session_db "$OPERATOR_CONFIG")"
```

## Profiles and acceptance

Use three separate Chromium profiles and one Firefox profile. In Chromium, extract chromium-hwc.zip to a permanent path, enable Developer mode in chrome://extensions and load that directory. In Firefox Desktop, extract firefox-desktop-hwc.zip and load its manifest via about:debugging. The unsigned development add-on needs the same profile, fixed add-on ID and persistent storage preferences across process restarts. Follow the Firefox installation instructions before the first exit. Visit the candidate setup page in each profile, approve the origin, record its actual public key, admit the host and three guests using the verified release, then install its hApp once in each profile. [Firefox profile setup](firefox-android-hwc-progress.md)

```bash
"${deploy[@]}" admit --role host --agent "$HOST_KEY"
for agent in "$CHROME_GUEST_A" "$CHROME_GUEST_B" "$FIREFOX_GUEST"; do
  "${deploy[@]}" admit --role guest --agent "$agent"
done
```

Use an owner-only acceptance input JSON as in the Firefox guide. Set profiles in order to the Chromium host, Chromium guest A, Chromium guest B and Firefox guest. Supply the trusted manifest digest and the candidate Firefox package path and digest. Run Geckodriver on loopback port 4444 and close all four profiles before preflight. Each report requires a fresh destination.

```bash
: "${ACCEPTANCE_CONFIG:?owner-only runner JSON}" "${EVIDENCE_DIR:?private report directory}"
python3 ci/alpha-operator/mixed-browser-run.py operator --config "$ACCEPTANCE_CONFIG" --report "$EVIDENCE_DIR/preflight.json"
python3 ci/alpha-operator/mixed-browser-run.py operator --config "$ACCEPTANCE_CONFIG" --round --report "$EVIDENCE_DIR/two-rounds.json"
```

The disposable hosted fixture can revoke and restore gateway admission. The operator runner uses preinstalled profiles and checks recovery without changing gateway admission. Treat a failed stage as a release blocker. The hosted package, when generated, is bound to an ephemeral fixture identity.

## Rollback and remaining work

Return users to the original HTTPS origin, extensions, installed hApp and authorities. Stop only the candidate relay and authorities and retain their state for diagnosis. Swapping frontend bytes across these DNA hashes breaks the installed binding. Kills, body reporting, ghosts, sabotage, crisis repair, vents, fog of war and Medbay expansion remain separate gameplay work. See the [integration contract](browser-unified-integration-contract.md) and [draft PR](https://github.com/ConorTttttt/imposter-holochain/pull/13) for the current acceptance status.
