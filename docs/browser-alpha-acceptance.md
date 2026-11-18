# RC1 external operator acceptance

**External acceptance remains NOT EXECUTED.** The three-browser CI and loopback TLS are separate results. Run this procedure on the intended tester network with the operator-built release and all three retained Chromium profiles. The acceptance recorder stores public identifiers, result codes, counts and UTC times. Keep role values, HAR files, console dumps, credentials and encryption keys out of the record.

## Start a record

Complete the [operator setup](installed-hwc-browser-alpha.md). Run `network-check` on the service hosts and `admission-check` on the gateway. Run `preflight` from the intended tester network. Confirm the gateway and both native authorities are on the operator’s bootstrap and relay and the authorities advertise full arcs. Reuse the setup guide’s shell variables. Keep the record and its public observation files in an operator-owned directory outside the checkout and served tree.

```bash
records=/absolute/path/to/operator-records
(umask 077; mkdir -p "$records")
(cd "$game" && nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file --command \
  python3 "$rc/deploy.py" native-status "${settings[@]}" "${distribution[@]}" --json) > "$records/native.json"

accept=(python3 "$rc/acceptance.py")
record="$records/rc1-acceptance.json"
release_args=(--public "$public_config" "${distribution[@]}")
"${accept[@]}" init "$record" "${release_args[@]}" --native-status "$records/native.json" \
  --guest-b "$guest_b" --guest-c "$guest_c"
```

Run `native-status` on the authority host and transfer just its JSON when the acceptance shell is on another machine. `init` requires a live HTTPS/WSS preflight, the independently recorded manifest digest, the verified operator package and a matching authority report. It starts all ten gates at `NOT EXECUTED`.

## Observe and record each gate

Open the game page in each Chromium profile. Paste this observer into each game tab’s DevTools console before creating the lobby. Reattach it after opening a new tab or restarting Chromium. It reports public hashes, seats and connection status. Review each profile locally.

```js
(() => {
  const hash = value => {
    const bytes = value?.length === undefined ? Object.values(value ?? {}) : value;
    if (bytes.length !== 39) throw Error('Expected a 39-byte public HoloHash');
    return 'u' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');
  };
  const bytes = value => Uint8Array.from(
    atob(value.slice(1).replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  window.addEventListener('imposter:action', ({detail: {kind, record}}) => {
    if (!['create', 'join', 'start', 'task'].includes(kind)) return;
    const value = kind === 'task' ? record.action : kind === 'start'
      ? record.role_commit : record.signed_action?.hashed?.hash;
    console.info(kind, hash(value));
  });
  window.rc1Observe = {
    async profile() {
      const hc = window.holochain;
      const signal = await hc.getConnectionStatus();
      const network = await hc.getNetworkStatus();
      return {agent: hash(hc.myPubKey), gateway: signal.linkerUrl,
        authenticated: Boolean(signal.authenticated && signal.wsHealthy && network.hasSession &&
          signal.linkerUrl === network.linkerUrl)};
    },
    async native(lobby, commit = null) {
      const view = await window.holochain.callZome({zome_name: 'game', fn_name: 'get_authoritative_game_view',
        payload: {expected_lobby: bytes(lobby), expected_role_commit: commit ? bytes(commit) : null,
          expected_recipient: null, expected_seat: null}});
      return {dna: hash(view.dna), lobby: hash(view.lobby_action), phase: view.phase,
        role_commit: view.role_commit_action ? hash(view.role_commit_action) : null,
        seats: view.seats.map(row => ({agent: hash(row.agent), seat: row.seat, join: hash(row.join_action)}))};
    },
    receiptCommit(hex) {
      if (!/^[0-9a-f]{78}$/i.test(hex)) throw Error('Expected a public RoleCommit in hex');
      return hash(Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16)));
    },
  };
})();
```

Use the record’s full public strings in each gate’s JSON object. The table gives the exact keys. Array entries are the public agent keys from the individually observed profiles. For each passing gate, create its evidence file and record the result. For a failed observation, record `FAIL` without `--evidence`. Preserve that record and use a new one to retest.

For `profiles`, copy the three `profile()` results into `profile-host.json`, `profile-b.json` and `profile-c.json` in the records directory. This command creates the gate’s evidence from those observations.

```bash
jq -se --arg gateway "$(jq -er .gateway_origin "$public_config")" '
  if length == 3 and all(.[]; .gateway == $gateway and .authenticated == true)
  then {authenticated_profiles: map(.agent)} else error("One or more profiles are unauthenticated") end
' "$records/profile-host.json" "$records/profile-b.json" "$records/profile-c.json" > "$records/profiles.json"
```

```bash
read -r -p 'Observed gate ID: ' gate
"${accept[@]}" record "$record" "$gate" PASS --evidence "$records/$gate.json"
# For a failed observation, use the following instead.
# "${accept[@]}" record "$record" "$gate" FAIL
```

Run the restart gate while the round is still playing, before completing the task. For privacy, observe the role indicators and run the isolation check before the round ends. The native game publishes a reveal during finalization.

| Gate ID | Observe on the intended network | Public evidence JSON fields for PASS |
| --- | --- | --- |
| `profiles` | Run `await rc1Observe.profile()` in each game tab after provisioning. Confirm `authenticated: true`, the configured gateway origin and three distinct public keys. | `authenticated_profiles` |
| `lobby_joins` | Host creates the lobby, then both guests join. Take the hashes from the create and two join events. In all three tabs, call `await rc1Observe.native(lobbyHash)`. Confirm the expected DNA, lobby and exact Guest B and Guest C join hashes. This coordinator query reads native-valid lobby and join records. | `lobby`, `guest_b_join`, `guest_c_join`, `native_valid_profiles` |
| `round_start` | Host clicks **Start round**. Take the RoleCommit from the start event. In each tab, call `await rc1Observe.native(lobbyHash, commitHash)` and observe the same commitment and `playing` phase. | `lobby`, `role_commit`, `playing_profiles` |
| `guest_roles` | Before starting the round, open each guest’s HWC service worker console from `chrome://extensions`. After starting, each guest observes their own verified role and the `HWC_EXTENSION_LOCAL_ENCRYPTED_ROLE_RECEIPT_VERIFIED` milestone. Convert each milestone’s public `roleCommit` hex with `rc1Observe.receiptCommit(hex)`. Record only the two commitment hashes. | `guest_b_receipt_commit`, `guest_c_receipt_commit` |
| `guest_isolation` | From Guest C’s game tab, run the denial-only probe below with Guest B’s exact public key. Confirm the rejection reason and that Guest C’s own verified indicator was available before the probe. | `requested_recipient`, `guest_c_denied` (boolean `true`) |
| `profile_restart` | In a guest profile, note the canonical seat from native readback. Fully close and reopen the same Chromium profile and unpacked extension path. Reattach the observer and compare `profile()` and `native(lobbyHash, commitHash)` with the same player, DNA, seat and round. | `player`, `lobby`, `role_commit`, `seat`, `recovered_seat`, `matching_dna_and_authenticated` (boolean `true`) |
| `engine_task` | A crewmate clicks **Align Engine Output**. Record the task event’s native action hash and observe shared task progress `1/1`. | `task_action`, `task_count` (number `1`) |
| `crew_victory` | All three game tabs show **Ended · Crew wins** and `1/1`. Verify the same exact RoleCommit with `native(lobbyHash, commitHash)`. | `role_commit`, `crew_wins_profiles` |
| `revocation` | Use `admission-status` before revoking a connected guest. After `revoke`, confirm the browser loses authentication and the gateway reports zero credentials and `allowed: false`. | `player`, `sessions_before`, `sessions_after`, `allowed_after`, `browser_disconnected` |
| `reauthorization` | Close the revoked profile, re-admit the same guest and confirm `admission-status` shows zero credentials. Reopen the same profile, reconnect, observe its authenticated session on the intended gateway and confirm a new credential exists. | `player`, `sessions_before_connect`, `sessions_after_connect`, `fresh_authenticated_connection` (boolean `true`) |

The probe below prints a boolean only. Replace the placeholder with Guest B’s exact public key.

```js
await (async () => {
  try {
    await window.holochain.callZome({zome_name: 'game', fn_name: 'get_verified_browser_role',
      payload: {recipient: 'GUEST_B_PUBLIC_KEY'}});
    return false;
  } catch (error) {
    return String(error).includes('PRIVATE_ROLE_ORIGIN_OR_PAYLOAD_DENIED');
  }
})();
```

Use the gateway commands locally as the gateway service account. Pause after each command and record the corresponding browser and gateway observation.

```bash
python3 "$rc/deploy.py" admission-status "${settings[@]}" "${distribution[@]}" --agent "$guest_b"
python3 "$rc/deploy.py" revoke "${settings[@]}" "${distribution[@]}" --agent "$guest_b"
python3 "$rc/deploy.py" admission-status "${settings[@]}" "${distribution[@]}" --agent "$guest_b"
# After recording revocation and fully closing Guest B's profile:
python3 "$rc/deploy.py" admit "${settings[@]}" "${distribution[@]}" --role guest --agent "$guest_b"
python3 "$rc/deploy.py" admission-status "${settings[@]}" "${distribution[@]}" --agent "$guest_b"
# After reopening Guest B's profile and observing fresh authentication:
python3 "$rc/deploy.py" admission-status "${settings[@]}" "${distribution[@]}" --agent "$guest_b"
```

## Verify the final record

```bash
"${accept[@]}" status "$record"
"${accept[@]}" verify "$record" "${release_args[@]}"
```

`verify` checks the release and intended origins again, validates the public evidence schema and cross-checks the matching round and identities. It repeats live HTTPS/WSS preflight and requires ten recorded passes. Browser and service observations are operator attestations. Sign off only after reviewing those observations on the intended infrastructure. Keep the verified JSON with the release manifest and keep raw browser and service diagnostics local.
