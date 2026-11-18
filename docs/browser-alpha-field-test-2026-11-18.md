# Browser alpha: first private-network operator round — 18 November 2026

> **Status: private operator-hosted playable-alpha milestone, not a public release or completed external acceptance.**
> This is an operator-reported field test on an existing Ubuntu desktop, distinct from the automated installed-browser CI evidence. The test did not produce a public release artifact or a complete independently captured three-browser acceptance record.

## What happened

On 18 November 2026, the project operator assembled and exercised a **host-bound, three-player browser alpha** on their own Ubuntu desktop, without buying hosting or opening router ports. The browser frontend was delivered over private Tailscale HTTPS; the H2HC gateway, Kitsune2 bootstrap service with embedded Iroh relay, and two native Holochain 0.7.0 authorities ran on the operator's machine.

The operator successfully reached an authenticated host browser, created a lobby, connected a second browser identity (**Lobby 2/3**), prepared and admitted a third distinct guest identity, and reported the end of the ensuing round. One participant's browser displayed:

```text
Securely connected
Phase: Ended · Crew wins
Your verified role: Impostor
Task completions: 1/1
```

This is the first reported real operator-hosted browser gameplay milestone, **not** evidence that the full-map game has been ported or that the result was independently checked in all three browsers. The role is shown only as an example of *that participant's own* verified UI state.

## Evidence and boundaries

| Area | Evidence seen during the operator session | Assessment |
| --- | --- | --- |
| Host-specific release | Operator created and verified a package bound to the retained host HWC identity, then published the browser assets to the managed static site. | Built and deployed in the operator environment; not a general-purpose distributable hApp. |
| Private frontend | The browser setup and game pages loaded from the operator's HTTPS site served through Tailscale Serve. | Working in this operator setup. |
| Gateway transport and isolation | Gateway `/health` responded `200` locally and over HTTPS; `/admin/agents` returned `404` through the final HTTPS Caddy proxy. The Caddy Host-header mismatch was corrected before this result. | Local/private HTTPS smoke checks passed; not a comprehensive security audit. |
| Bootstrap and relay | `kitsune2-bootstrap-srv 0.5.1` ran on loopback. Tailscale HTTPS forwarded its HTTP/WebSocket listener. A `/relay` WebSocket upgrade over HTTPS returned `101`; bootstrap logs included verified `SignedChallenge` authentication and relay registration. | Bootstrap/relay path responding; no general cross-device transport guarantee. |
| Native Holochain authorities | Two Holochain 0.7.0 conductor sandboxes initialized and started successfully with private admin ports `33555` and `33557`. | Processes started; `native-status` output and full storage-arc evidence were not captured in the conversation. |
| Player identity and lobby | Browser reported `Securely connected` and `Host identity verified`. Host created a lobby; a second distinct guest profile reached `2/3`. A third guest key was provided and the operator proceeded to the completed round. | Strong operator-reported multiplayer smoke test. A separately recorded `3/3` screen was not supplied. |
| Completed one-task round | A participant's browser reported `Ended · Crew wins` with `Task completions: 1/1`, while showing its own verified Impostor role. | End-of-round success observed on **one browser**; agreement of the other two screens still to capture. |

**Privacy:** This report intentionally excludes the private Tailscale hostname, LAN and tailnet IP addresses, public player keys, role allocations for other players, Lair socket URLs, credentials, and local state paths. Keep them out of shared logs and issues.

## What the browser alpha includes

The current release candidate is intentionally smaller than the established desktop-style/4-window demo:

- Three persistent Chromium/HWC player identities, using a host-bound browser hApp.
- A shared three-player lobby, authenticated gateway sessions and private per-recipient role UI.
- One shared task, **Align Engine Output**, and the **Crew wins** result after one completion.
- A separate HTTPS static frontend, restricted H2HC gateway, Kitsune2 bootstrap/embedded Iroh relay, and two native Holochain authorities.

It does **not** yet represent the full map, player movement, sabotage, meetings, voice/chat or the full desktop gameplay loop in the browser. The `main` README describes the broader native/development experience; do not interpret every feature there as already available in the browser RC.

## Remaining acceptance work (prioritized)

1. **Capture authoritative checks.** Retain the exact output of `deploy.py preflight` and `deploy.py native-status`, including expected DNA and two distinct authority identities, and record a sanitized run timestamp/build pin.
2. **Verify all participants.** Capture `3/3` and the same final `Ended · Crew wins`, `Task completions: 1/1` state in **all three** Chromium profiles. Confirm each profile sees only its own role, without sharing private roles.
3. **Test restart and recovery.** Restart one browser profile, then the gateway and native conductors, and confirm retained identities, admissions and game state. Repeat revocation and reauthorization.
4. **Test actual separate devices.** Exercise browser-to-browser play across different computers on the tailnet, not merely separate profiles on one desktop. The Iroh QUIC address-discovery socket was loopback-bound during this run; WebSocket relay success is not a substitute for cross-device convergence testing.
5. **Harden deployment and operations.** Replace manually maintained foreground processes with managed service startup, verify ingress boundaries and administrative route isolation, retain secrets/backups privately, and exercise static rollback.
6. **Expand product scope.** Only after the private alpha is reliably repeatable, work toward a broader browser experience and evaluate mobile HWC support. Public internet hosting and production readiness are **not** established.

## Relationship to CI and operator instructions

The automated installed-browser pipeline documented on the operator follow-up branch previously exercised three Chromium profiles, role delivery, restart/revocation scenarios and the one-task crew result in its controlled environment. **Those CI results are separate from this operator field test and must not be counted as live operator acceptance checks.**

- [Browser alpha operator runbook (follow-up branch)](https://github.com/ConorTttttt/imposter-holochain/blob/followup/browser-alpha-operator/docs/installed-hwc-browser-alpha.md)
- [Browser alpha player installation guide (follow-up branch)](https://github.com/ConorTttttt/imposter-holochain/blob/followup/browser-alpha-operator/docs/browser-alpha-player.md)
- [Installed-browser CI follow-up run 44360022228](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360022228)

**Development stage:** An initial **private, operator-hosted playable browser alpha** has been demonstrated. Next goal: a repeatable, fully evidenced three-browser acceptance run, then separate-device multiplayer and maintainable deployment.
