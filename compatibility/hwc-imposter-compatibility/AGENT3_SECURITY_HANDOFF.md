# Agent 2 ↔ Agent 3 boundary — requirements, not a proposed wire protocol

The user references Agent 3's security assessment, but it is not accessible in this conversation. Do **not** treat this file as an agreed protocol or a replacement for that assessment.

The HWC receiving boundary currently REJECTS ALL linker-delivered remote signals. The legacy handler previously trusted metadata including `from_agent` and decoded inner `provenance`, and if decode failed substituted the local author. That is unacceptable. Its implementation has been replaced in this patch.

Before restoring remote-signal execution, Agent 2 and Agent 3 must jointly approve and test:

1. A versioned authenticated envelope using the **pinned native Holochain 0.7 signature verification rules** (no ad-hoc signing format), with a cryptographically bound sender, recipient, DNA hash, zome function, payload and freshness/replay fields.
2. Verification of sender signature against authenticated network identity; never trust `from_agent` supplied in outer JSON as proof.
3. Exact match to installed active cell DNA, local recipient identity, and permitted target zome/function.
4. Strict expiration / clock-skew window and a durable per-recipient replay cache surviving worker/browser restarts; reject duplicates.
5. Capability grant enforcement using local grants, provenance and cap secret as applicable. A local ChainAuthor grant is never substituted for a remote agent.
6. Negative tests: malformed envelope, altered payload, wrong DNA, wrong recipient, forged provenance, expired message, replayed nonce, missing capability and manipulated sender identifier.
7. Audited fail-closed errors without logging signal contents, role material, or private task information.

No remote-call protocol or H2HC-owned file has been changed here. Agent 3 can implement H2HC authentication separately, then the receiver must be reviewed together as one security boundary.

## Explicit interface agreement status — pending Agent 3

| Contract part | Verification owner | Current status |
|---|---|---|
| Native Holochain 0.7 signed bytes, key derivation and signer verification | Agent 3 implements/proves transport binding; both agents confirm exact Holochain 0.7 byte vectors | **NOT AGREED / NOT VERIFIED** |
| Match authenticated sender to inner provenance | H2HC provides authenticated sender; HWC independently checks equality | **NOT IMPLEMENTED** |
| Match recipient, DNA, installed cell, zome and `recv_remote_signal` | HWC validates before WASM execution | **NOT IMPLEMENTED** |
| Expiry, replay nonce and persistence across restart | Joint wire-field agreement; HWC durable per-recipient replay/TTL enforcement | **NOT IMPLEMENTED** |
| Capability grants and chain-author distinction | HWC authorizes against the local private source chain with real caller identity | **NOT IMPLEMENTED** |

No new signature hashing protocol is proposed by Agent 2. Without the precise
Agent 3 envelope and pinned native byte vectors, the HWC receiver must continue
rejecting all incoming remote signals. This is a deliberate fail-closed state.
