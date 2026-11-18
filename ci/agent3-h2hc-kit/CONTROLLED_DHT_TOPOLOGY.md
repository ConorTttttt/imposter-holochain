# Agent 3 — DHT topology and HWC integration gate (2026-11-17)

## Verified evidence (do not conflate)

- Pinned secure H2HC `Holo-Host/h2hc-linker@cab242d32c988fe5e4e9fd06ebc82ed043541aa2`, patched and compiled on CI [44165793922](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44165793922): PASS. Production auth ON; `H2HC_LINKER_ALLOW_INSECURE_DEV=false`; `H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK=false`; removed `/test/signal` and legacy HTTP zome routes; remote signals/calls OFF.
- Existing signed A operation: HTTP 200, `queued=1, failed=0, published=0, success=false`. This proves action signature + agent/DNA authorization and local queue only.
- Independent **real two-gateway** test, run from existing compiled binary (not a rebuild): H2HC A and B separate processes, separate admin secrets, separate linker keys, separate signed Ed25519 agents, both registered under synthetic matching DNA, public development bootstrap **and relay** `https://dev-test-bootstrap2.holochain.org/`. A signed genesis AgentActivity queued with `published=0`; independent B GET `/dht/<DNA>/record/uhCkkflncV3IJKdotVf3lWVHz3zpW4IgRf0R9c2xetY8ob49Wr0fG` returned HTTP 200 JSON `null`. Neither authority validation nor remote retrieval was demonstrated. Test script and raw logs available in Agent 3's conversation download; no secret key material in evidence. Do not falsely count HTTP 200 with JSON null as retrieval.
- Agent 4 REAL patched HWC / genuine Lair browser first-cell CI [44172203893](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44172203893): PASS for ephemeral HWC host key, host-bound DNA/hApp, install, real `get_game_state` and host `create_lobby`. Networking, guest, independent grant inspector and reconnect NOT RUN. CI profile and its private signing key are intentionally deleted, so the bundle is NOT DEPLOYABLE. Agent 2's corrected HWC kit pinned at `f888dc21110acff3e093ebe20b8ca16f60f1877d` (ExternIO `0xc0` fix) is what Agent 4's successful workflow checked out.

## Why two gateways do not make a DHT authority

Pinned `src/proxy_agent.rs` hardcodes `DhtArc::Empty` for browser `ProxyAgent` current/target storage arcs. `src/gateway_kitsune.rs::publish_ops` uses `get_responsive_remote_agents_near_location(peer_store, local_agent_store, peer_meta_store, basis_loc, ...)`, filters tombstones and peers without URLs, and returns `Ok(0)` if no eligible remote peers exist. Its `publish_ops(..., url).await == Ok(())` counts an acknowledged *transport send* (not accepted Holochain integrity). Pinned `src/dht_query.rs` queries independent remote authorities; the patched router suppresses absent/unknown validity as untrusted, and local buffer fallback is disabled. The public bootstrap is only discovery and Iroh relay, never a database/integrity validator.

A **native Holochain 0.7.0 conductor with the exact same host-bound DNA hash** and a nonempty storage arc is needed for real integrity validation and durable DHT fetches. Do not replace that peer by another zero-arc browser or H2HC instance.

## Reproducible controlled topology

| Process | Identity/storage | Interface | Security/evidence |
| --- | --- | --- | --- |
| Bootstrap + Iroh relay | kitsune2_bootstrap_srv 0.5.0, controlled TLS hostname | HTTPS/QUIC relay | Discovery only; no authority |
| H2HC gateway A | pinned patched executable, private linker identity | protected HTTPS/WSS | unique secret; prod auth; local fallback disabled |
| HWC host A | genuine Lair key, origin-bound HWC profile | own WS session + scoped bearer | same host-bound game DNA; sign AgentInfo and action |
| Native Holochain 0.7.0 | different agent key, nonempty storage arc | kitsune2/Iroh transport | Install identical DNA; validate incoming ops using `game_integrity` |
| HWC guest B | distinct Lair identity and WS session | protected HTTPS/WSS | same installed DNA, valid capability, GET record via H2HC |
| HWC guest C | third distinct Lair identity | protected HTTPS/WSS | only after A→native→B evidence succeeds |

**Version pins:** Holochain 0.7.0, kitsune2 0.5.0, h2hc `cab242d3...`, HWC `0c391226...` patched by Agent 2 at `f888dc2...`. Do not silently substitute Holochain 0.7.1 because action and capability details changed. Docs: https://developer.holochain.org/resources/howtos/running-network-infrastructure/ and https://developer.holochain.org/resources/compatibility/holochain-0.7/ .

In controlled infrastructure, deploy the official `ghcr.io/holochain/kitsune2_bootstrap_srv:v0.5.0` at a stable HTTPS URL with proper TLS and open required UDP relay/discovery ports. The vendor's documented command uses `kitsune2-bootstrap-srv --production --listen '[::]:443' --tls-cert ... --tls-key ...`. Configure *both* linker instances and native conductor to the SAME `bootstrap_url` and `relay_url`. Never put an admin secret in a public page or client bundle. For local/test-only plaintext relay, the conductor must explicitly allow it with `network.advanced.irohTransport.relayAllowPlainText=true`; secure TLS is preferred.

H2HC startup (gateway A, similarly a distinct gateway B if needed):

```bash
set -a
. /secure/h2hc-a.env
set +a
test "$H2HC_LINKER_ALLOW_INSECURE_DEV" = false
test "$H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK" = false
./h2hc-linker-linux-x86_64 --address 127.0.0.1 --port 8090
```

For the native conductor, set `network.bootstrap_url` and `network.relay_url` to the same deployed service, `network.target_arc_factor: 1` (nonempty storage), and install/enable the exact original host-bound .happ or a compatible .dna with an independently generated native agent. Verify installed `cell_id[0]` (39-byte DNA hash) equals HWC's. Holochain 0.7.0 CLI supports `hc sandbox` and `hc-spin`; use Agent 4's **already passing Nix-pinned toolchain** within the browser runner to avoid rebuilding an unrelated native binary.

## Agent 4: exact next real HWC ↔ H2HC test

In `scripts/browser-poc-hwc-smoke.mjs`, **within the same ephemeral browser job and before deleting the profile**:

1. Start the *existing compiled* H2HC binary from artifact for run 44165793922 with a fresh runner-local admin secret, a distinct persistent-for-job linker identity, real bootstrap/relay URL, insecure dev=false and local fallback=false. Wait for `/health=200`.
2. After `HWC_AUTHENTIC_HOST_KEY PASS`, use the privileged Node runner (NOT the browser page) to POST `/admin/agents` with host pubkey and `[dht_read,dht_write,k2]`, expecting 204. Do not pass admin secret to the page or screenshot.
3. After hApp install returns correct `[DNA,AgentPubKey]`, call the exposed page API **`await window.holochain.configureNetwork({linkerUrl:'http://127.0.0.1:8090'})`** (or TLS URL when remote). Poll `window.holochain.getConnectionStatus()` for `authenticated=true`, inspect WS `auth_challenge` signed with genuine Lair key, session issuance and `registered` for actual DNA; capture redacted server WS logs. A configured linker's health is NOT authentication.
4. Execute real `game::create_lobby` and capture authored action hash, native format MsgPack `DhtOp` and publishing request. Confirm wrapper signature, embedded signature, Ed25519 action bytes and author match. Assert `queued=1`, then check `published` separately. **If published=0, mark remote topology BLOCKED, do not claim success.**
5. Before cross-browser gate, run native 0.7 conductor with same DNA and arc > 0. Capture validation/receipt and independent B read. Record distinct returned `action_hash`, `author`, `dna_hash`, validation verdict and body. Do not use `local_authority_fallback=true`. Additional HWC profiles B/C only after first-cell network proof.
6. Do not enable remote signals, remote calls, cap-grant bypasses, or private-role data in CI.

**Ownership:** H2HC runtime/tests/doc changes live only on Agent 3 branch and Draft PR #6. Real HWC profile/UI/WS integration belongs to Agents 2/4 on their own branches. Neither Agent 3 nor Agent 4 should weaken H2HC signatures or native game integrity to make test pass.

## Four independent acceptance milestones

1. `accepted_to_queue`: HTTP 200 and `queued>0,failed=0` for **authz + valid signature**; ALREADY PASS.
2. `sent_to_peer`: H2HC `published>0` with recipient URL/peer log, and remote peer receipt; **NOT PROVEN**.
3. `native_authority_validated`: Holochain 0.7 native DHT response indicates `ValidationStatus::Valid` for action/record; **NOT PROVEN**.
4. `retrieved_by_other_authz_agent`: other independent authenticated HWC identity GET returns the same non-null, VALID record with expected DNA and hash; **NOT PROVEN**.

Gate overall completion ONLY when all four pass on one consistent real host-bound DNA; reconnect/three-browser tests come afterwards. Every CI artifact must report one of PASS / FAIL / BLOCKED / NOT RUN per milestone, never infer validation from transport ACK.
