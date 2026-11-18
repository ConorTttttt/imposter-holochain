# Agent 4 — role authorization and browser full-round readiness handoff

**18 November 2026.** Role policy and UI are **staged**; private-role transport remains
**NOT ACCEPTED / DISABLED**. Existing three-browser lobby acceptance:
[corrected gateway run 44289746121](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44289746121)
passed before this coordinator update. Do **not** count that run as post-change
regression or as encrypted role-delivery acceptance.

## Authorization boundary

- Native coordinator `RoleDealt` has an explicit recipient identity.
  `recv_remote_signal` requires the executor's verified `call_info().provenance`
  equal the actual lobby host; recipient equal local Lair agent; committed
  `RoleCommit.seats[seat]` equal that agent; delivered `RoleCommit` action
  hash equal the accepted host-authored current-round commitment; and a valid
  per-seat Merkle opening against its root. No signal is emitted until all pass.
- `find_role_commit` filters to a commitment authored by the current lobby
  host and bound to its lobby. `request_role`, `provide_role`, `resend_role`
  and `my_role_leaf` validate host/seat/commitment/proof; requesters cannot
  choose a different player's seat. `SealedRoles` remains source-chain private.
- The pure `imposter-core::role_auth` tests cover successful delivery, forged
  sender, valid opening for a different seat, old commitment, replaced
  recipient and invalid proof. Tests do not simulate authenticated transport.
- Existing HWC patch **rejects inbound remote signals**; H2HC exposes no
  private-role route. `call_info()` must only be set by a cryptographically
  verified caller in the future HWC executor. Do **not** expose a page-supplied
  `from_agent`, enable generic `send_remote_signal` or `call_remote`,
  or treat the old unrestricted listed-function `CapGrant` as sender policy.
  Existing installed grants require review/migration before enablement.
- Before accepting a remote `role_request_v1` / `role_delivery_v1` response,
  Agents 2/3 must independently pass the signed, HPKE encrypted, DNA/cell/
  recipient/epoch/nonce/revocation checks and prove true Holochain caller
  provenance. Their initial contract is deliberately limited to role requests
  and role deliveries; tasks, sabotage, kills and generic zome execution remain
  outside this milestone.

## Browser UI behavior

`ui/browser-demo.html` displays public native-validated phase, player count,
names and seats. It only shows the calling player's `Crewmate` / `Impostor`
after `game::request_role` successfully returns a coordinator-verified value
(or `get_game_state.my_role` contains a legitimate public reveal). Guest role
recovery fails closed while the encrypted transport is missing. Private role
is kept in page memory only, scoped to this DNA/identity/lobby/seat, cleared
on reconnect, and never emitted as an event or written to local/session
storage, logs, HTML metadata, public DHT or the host's entire vector. Ordinary
host/join/lobby polling works without private messaging.

The native three-browser CI instrumentation additionally checks a lobby-phase
label and withheld roles for each identity without logging any private value.

## Packaging / release decision

The separate `browser-poc-package.yml` workflow produces a *synthetic-host*
fixture labelled `SYNTHETIC_CI_FIXTURE`, `deployment_ready=false`,
`runtime_validation=NOT_RUN`, `NOT_DEPLOYABLE`. It is not an HWC/Lair
operator installation or a public release. Real coordinator builds are
permitted only as this reviewed source delta; native integrity, locked
toolchains, DNA manifest and seed constraints remain pinned.

A genuine operator-controlled installation needs: (1) host Lair identity
created and persisted on the exact trusted web origin; (2) host-bound
network seed plus actual compiled, checksum-verified and signed hApp/DNA;
(3) three distinct installed Lair agents bound to the exact same DNA;
(4) operator-kept release signing key and independently authenticated
deployment manifest; (5) HTTPS/WSS with explicitly provisioned,
authenticated, revocation-sensitive H2HC service, no local authority
fallback and no exposed admin endpoints or shared credentials;
(6) production-safe host/guest backup/recovery and key-rotation handling;
(7) independent encrypted role-delivery E2E, native validation, revocation
and browser+desktop interoperability gates before claiming a full round.
Do not publish CI ephemeral keys, session tokens or fake host identities.

**Post-change result:** CI pending; this handoff is an implementation
and acceptance plan, not a claim of completed encrypted gameplay.
