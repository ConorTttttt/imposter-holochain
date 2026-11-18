# Agent 3 — authenticated H2HC runtime runbook (P0 only)

**Source:** Holo-Host/h2hc-linker commit cab242d32c988fe5e4e9fd06ebc82ed043541aa2, plus Agent 3's existing pinned security kit and actual CI compiler/regression corrections. Do not substitute an unpatched H2HC executable.

## Build and provenance

GitHub Actions workflow: Agent 3 - authenticated H2HC executable and live network probe on ci/agent3-h2hc-security-validation. It pins the H2HC commit, verifies/extracts the existing tar.xz security kit, replays the already-proven transformations, and compiles the real executable:

    cargo fmt
    cargo build --locked --bin h2hc-linker

The workflow uploads a stripped Linux x86_64 executable, SHA256SUMS, reproducibility metadata, a secure config template, a probe transcript and service logs. The CI-only fixtures contain test private keys and are deliberately NEVER uploaded.

## Controlled authenticated startup

Download the executable from a successful workflow artifact. In a restricted directory, verify its checksum and run:

    chmod 0755 ./h2hc-linker-linux-x86_64
    cp secure.env.example /secure/location/h2hc.env
    chmod 0600 /secure/location/h2hc.env

Edit /secure/location/h2hc.env: set H2HC_LINKER_BOOTSTRAP_URL to an ACTUAL compatible and reachable Kitsune2 bootstrap server, generate a new H2HC_LINKER_ADMIN_SECRET using openssl rand -hex 32, and set H2HC_LINKER_KEY_FILE to a persistent file owned by the service account. Set neither H2HC_LINKER_ALLOW_INSECURE_DEV nor H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK to true.

    set -a
    . /secure/location/h2hc.env
    set +a
    ./h2hc-linker-linux-x86_64 --address "$H2HC_LINKER_ADDRESS" --port "$H2HC_LINKER_PORT"

For remote browsers, terminate TLS/WSS at a trusted gateway and restrict admin access. Never expose plaintext browser traffic, the admin secret, fixture signing seeds, or the linker identity file publicly.

## Authenticated HTTP and WebSocket protocol

Verify health returns HTTP 200, /test/signal is 404, the legacy /api/{dna}/{zome}/{fn} route is 404, /dht without a bearer token is 401, and /admin/agents with a bad admin token is 401. The binary must refuse startup without production auth or with the unsafe local-authority fallback enabled in authenticated mode.

Only the operator may add an actual browser agent to the allowlist:

    curl -i -X POST http://127.0.0.1:8090/admin/agents \
      -H "Authorization: Bearer $H2HC_LINKER_ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      --data '{"agent_pubkey":"REPLACE-WITH-REAL-HOLOHASH","capabilities":["dht_read","dht_write","k2"],"label":"browser-host"}'

204 is success. Each independent HWC profile opens its own WS session, sends an auth frame containing its Holochain AgentPubKey, Ed25519-signs the received hex challenge, returns a base64 auth_challenge_response, receives a bearer session_token and registers its DNA. Never reuse a socket for a different agent. HTTP DHT requests require that session token, permitted capability, and registered DNA.

Signed DHT publication is a POST to /dht/{dna}/publish with op_data (base64 MsgPack of native Holochain DhtOp) and signature (base64 Ed25519 signature over native-serialized Action bytes). The embedded signature and wrapper signature must agree, and the author must match the session. HTTP 200 with queued=1 and published=0 proves local acceptance only — NOT replication or integrity validation.

## Executed test boundaries

The CI network-probe.mjs sends real HTTP and WebSocket frames using separately authenticated synthetic Ed25519 identities. The Rust runtime-fixtures.rs example generates native Holochain 0.7 signed-action bytes. CI uses the official public Holochain *development-only* Kitsune2 bootstrap at https://dev-test-bootstrap2.holochain.org/ with SYNTHETIC identities and data, not a production bootstrap, and still has NO independently validated native authority; registration, peer availability and validated DHT retrieval may fail. Public developer infrastructure has no availability guarantee. If join or publication fails the job fails, and the logs must be treated as evidence of a blocker, not a pass. The script never enters insecure development mode and never enables local-authority lookup.

**Native proof not yet supplied:** a reachable real bootstrap/relay, independent native Holochain 0.7 authority, fully authenticated patched HWC browser profile and a successful validated record read-back. Only those can establish native-compatible DHT convergence. Do not call a locally queued op a validated DHT record.

## Agent 2 compatibility and P1

Pinned HWC websocket-service.ts exposes the same auth/auth_challenge_response/auth_ok/register and sign_agent_info protocol, and publish-service.ts serializes ops for the linker; these are STRUCTURAL matches, not proof from a running extension. Its WebSocket service accepts one authenticated agent per socket. The next gate is to run Agent 2's patched HWC browser extension against this authenticated H2HC server, using three separate browser identities.

Both HWC and H2HC deliberately reject remote signals. Remote calls and unauthenticated HTTP zome routes remain disabled. An agreed signed envelope with sender, DNA, recipient, expiry, replay protection and local capability enforcement is P1 and must not delay signed DHT P0 work.

## Evidence levels

Build acceptance = a real executable plus hashes. Auth acceptance = signed WS challenge and HTTP denial by running service. Transport acceptance = accepted signed op and rejected forgery. Network publication acceptance = confirmed remote peers (published > 0). Full native interoperability = independently validated DHT record retrievable via a native Holochain 0.7 authority. No shortcuts or substitutions.
