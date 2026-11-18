# Imposter browser alpha readiness

**Ready for an operator-controlled acceptance attempt.** External operator acceptance remains **NOT EXECUTED**. The code is prepared for the supported three-player browser round.

| Area | Status | Evidence or dependency |
| --- | --- | --- |
| Accepted gateway retention | **PASS** | The original successful recipe and artifact metadata were verified. A clean Git fetch and offline archive restore reproduced the exact accepted gateway executable. Only its gzip archive and public provenance are retained in the archive commit. [Archival run 44366369591](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44366369591) · [Pinned archive](https://github.com/ConorTttttt/imposter-holochain/commit/81ddc627cdac30d1af42ea67bc803a570ad93925) |
| CI packaging and deployment checks | **PASS** | The archived gateway was used in the reproducible CI package. Local HTTPS/WSS, static rollback, gateway SQLite persistence, and restart of both exact native authorities passed. [Baseline 44360021935](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44360021935) · [Follow-up 44367872991](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44367872991) |
| CI browser functionality and security | **PASS** | Native joins, private role receipts, the one-task crew victory, replay, revocation and the signed negative cases passed in genuine installed Chromium CI. The follow-up used the archived gateway and captured the public native task action. [Follow-up 44367872988](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44367872988) · [Sanitized gameplay evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44367872988/artifacts/14456879217) · [Role negatives 44353203661](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44353203661) |
| Operator-specific packaging | **NOT BUILT** | The operator supplies the retained host profile’s public key, chooses the release seed, builds the package and records its independently verified manifest SHA-256. |
| Real operator HTTPS/WSS deployment | **NOT EXECUTED** | Requires the intended frontend and gateway origins, TLS, and operator-owned bootstrap and relay. Run preflight from the intended tester network. |
| Ten-gate external round | **NOT EXECUTED** | Requires the verified operator release, two live native authorities sharing the expected DNA, three retained Chromium profiles and local admission access. [Acceptance runbook](browser-alpha-acceptance.md) |

The accepted Linux x86-64 gateway SHA-256 is `8f3f8e0b6a6fc02b27776182458cf0d970bc02f76db9f6f6b6842c04f138746f`. The retained gzip SHA-256 is `7e6c9f53e228a31ddd54d9842d68fbd20d9eecda9eedac880a06ebd02f1af6c9`. The original Actions ZIP SHA-256 is `18a28177df7017d170360845ac24e48e491194a839e6764bb331481256ec856a`. The original artifact expires on 2 December 2026. Keep an offline copy of the pinned archive in operator-controlled storage. [Archive recovery procedure](installed-hwc-browser-alpha.md#3-build-and-verify-the-distribution)

Both follow-up verification jobs ran at `348c790a1e1133f830ac1b50434c2c512a31484d`. The CI packaging manifest SHA-256 is `7264c94e63c8728f815a0e094be8380a7a0db59adf22f6f70b002bd26a4e7ee3`. It binds the CI-only hApp and DNA. The real operator build records its own manifest SHA-256 against the retained host. [Sanitized CI packaging evidence](https://github.com/ConorTttttt/imposter-holochain/actions/runs/44367872991/artifacts/14456788249)

## Operator actions

1. Choose the intended frontend, gateway, bootstrap and relay URLs. Verify network reachability and TLS trust on the service and tester networks. Keep the gateway admin and native admin ports off the public routes.
2. Retain three separate local Chromium profiles and collect their public HWC identities. Build with the retained host profile’s public key, publish the verified static snapshot, and start the pinned gateway and the two persistent authorities. Keep the gateway secret, native Lair credentials and private state on the operator hosts.
3. Verify the three exact admissions and run the ten gates from intended tester clients. Keep the manifest and the verified public acceptance record. [Operator setup](installed-hwc-browser-alpha.md) · [Player guide](browser-alpha-player.md) · [Acceptance runbook](browser-alpha-acceptance.md)

## Security boundaries and scope

- Individual role delivery is scoped to the intended profile during play. The host is the role dealer. The coordinator publishes the role reveal during round finalization. Keep role values out of the acceptance record at every stage.
- The operator and players trust the approved frontend origin, local profiles and extension installation. Gateway revocation removes prior session credentials and cannot recall information the player already saw.
- The native admin interface remains private. The legacy direct SQL and separate invalid-lobby native probes were blocked in the baseline harness. Exact-action native admin observation and independent, native-valid readback cover the supported round.
- The alpha covers one three-player round, private role receipts, **Align Engine Output** and the shared crew victory. Full-map play, additional rounds or tasks, killing, sabotage, meetings, voting, desktop interoperability and public matchmaking are outside its supported scope.
