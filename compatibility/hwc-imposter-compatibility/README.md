# Agent 2 — Imposter / Holo Web Conductor compatibility patch (review candidate)

**Base:** `Holo-Host/holo-web-conductor` at `0c391226e78769d44ccb4661881ed8998b15f903`.
**Required working branch:** `fix/imposter-hwc-compatibility`.
**Date:** 2026-11-17.

This bundle contains **real source modifications expressed as a deterministic Python source patch**, plus new Vitest tests. It is **not** a validated / merge-ready change. No upstream files have been modified; there is no PR or writable fork. The two referenced architecture/security attachments were not available in this session. Their requirements MUST be reviewed before enabling browser multiplayer or distributing a build.

## Apply (pinned, clean branch only)

```bash
# In a networked development environment:
git clone https://github.com/Holo-Host/holo-web-conductor.git
cd holo-web-conductor
git switch --create fix/imposter-hwc-compatibility 0c391226e78769d44ccb4661881ed8998b15f903

# Place this bundle alongside or inside the checkout. The example assumes a sibling directory.
python3 ../hwc-imposter-compatibility/apply.py . --check
python3 ../hwc-imposter-compatibility/apply.py . --patch ../hwc-imposter-review.patch
python3 ../hwc-imposter-compatibility/apply.py . --write

git status --short
git diff --check
npm ci
npm run typecheck
npm run test:unit
npm run test:integration
```

`--check` makes no file changes and requires all source anchors from the pinned tree to match. `--patch` emits a conventional unified patch without changing the tree. `--write` refuses to run unless the checkout is clean, the current branch is exactly `fix/imposter-hwc-compatibility`, and HEAD equals the pinned commit. Running `--write` a second time is intentionally rejected (not idempotent). Use `git add -p` to create small reviewable commits; never commit on `main`.

A plain `git apply ../hwc-imposter-review.patch` is also possible after creating that diff. Do not run `git apply` and `--write` on the same checkout.

## Changes

### B-02: Host-bound network seeds

`packages/extension/src/lib/happ-context-manager.ts`

Role modifier precedence now uses nullish coalescing, and the effective `network_seed` / `properties` are written into `DnaManifestRuntime` as well as the DNA hash and installed `DnaContext`. `dna_info_v2` already reads the runtime manifest, so it sees the same seed. Test checks a constructed `g1.<encoded-host-AgentPubKey>.<32-lowercase-hex>` seed and fallback DNA hash separation. Does **not** alter Imposter's integrity zome or validate a real WASM invocation.

### B-03: Special capability entries and initialization

`packages/core/src/ribosome/wasm-io-types.ts`, `packages/core/src/hash/index.ts`, `packages/core/src/ribosome/host-fn/create.ts`, `packages/core/src/ribosome/host-fn/update.ts`, `packages/core/src/storage/types.ts`, `packages/core/src/storage/genesis.ts`, `packages/core/src/ribosome/index.ts`, `packages/extension/src/offscreen/ribosome-worker.ts`

`CreateInput.entry_location` now accepts `App`, `CapGrant`, `CapClaim`. System entry content is serialized as a structured Holochain entry variant and hashed with the correct enum tag, rather than as an `App` entry. Capability entry actions are private; updates must retain type. Genesis may defer writing `InitZomesComplete` until exported coordinator `init` callbacks have run (normal and deferred membrane-proof flows), allowing Imposter's `create_cap_grant()` to write the intervening private source-chain action(s). Interrupted initialization is rejected rather than silently accepted. The existing source-only genesis tests are extended.

**Needs native vector confirmation:** CapGrant serializer byte parity and the actual Imposter coordinator WASM callback are not verified. A failed init leaves an incomplete cell and may require explicit reinstall; it must never be treated as initialized.

### B-01: Confidentiality and publication

`packages/core/src/ribosome/host-fn/create.ts`, `packages/core/src/ribosome/host-fn/update.ts`, `packages/core/src/ribosome/host-fn/entry-utils.ts`, `packages/core/src/ribosome/host-fn/action-serialization.ts`, `packages/core/src/storage/types.ts`, `packages/core/src/storage/source-chain-storage.ts`, `packages/core/src/dht/record-converter.ts`, `packages/core/src/dht/produce-ops.ts`, `packages/core/src/dht/publish-tracker.ts`, `packages/extension/src/offscreen/ribosome-worker.ts`

App visibility follows HDK input and persists in the existing JSON/object-type storage fields, including browser restart. Record conversion and DHT op generation hide private/system entry bodies, including when a retry supplies the local entry. A defense-in-depth op producer guard rejects unknown action visibility. The in-memory IndexedDB fallback clears cross-cell caches; OPFS SQLite private/system reads are scoped to the active cell. The publish tracker moves to DB v3 and discards v2 pending messages whose serialized payloads could have been unsafe, with a warning. This is intentional: previously queued private content cannot be reliably identified after a past visibility bug. Fresh safe ops must be reconstructed from the local chain.

**Important:** Old source-chain actions with missing visibility are rejected and require an explicit migration/reinstall; this patch must not relabel already-signed public actions as private. Data that was **already published** cannot be made secret retroactively. Do not test with real role data. Multi-agent confidentiality and end-to-end retry/browser restart tests remain **NOT RUN**.

### HWC remote-signal boundary

`packages/extension/src/background/index.ts`, `packages/core/src/ribosome/index.ts`

The old handler that accepted raw signals or defaulted missing provenance to the local author is entirely replaced with a fail-closed rejection. The ribosome denies non-author provenance because remote capability authorization isn't implemented. **Remote signals are deliberately non-functional until Agent 3 and Agent 2 agree and implement an authenticated, replay-protected envelope.** This is a P1 blocker, not a completed authenticated receiver. No H2HC-owned files are changed.

## Added tests

- `packages/extension/src/lib/happ-context-manager.test.ts` (extended): role modifiers override DNA default; runtime manifest persistence and DNA hash difference.
- `packages/core/src/storage/genesis.test.ts` (extended): source-chain order with deferred `InitZomesComplete`.
- `packages/core/src/ribosome/wasm-io-types.imposter.test.ts`: valid and invalid capability entry locations and types.
- `packages/core/src/hash/system-entry.imposter.test.ts`: special-entry tagged hashing and author-local struct round-trip.
- `packages/core/src/ribosome/host-fn/dna-info-imposter.test.ts`: mocked `dna_info_v2` reads effective runtime seed.
- `packages/core/src/dht/private-entry.imposter.test.ts`: signed visibility; synthetic byte absence from serialized ops and retry, public-entry compatibility, fail-closed legacy type.
- `packages/core/src/storage/private-entry-persistence.imposter.test.ts`: IndexedDB reopening, author-local retrieval and cross-cell cache isolation.
- `packages/core/src/dht/publish-upgrade.imposter.test.ts`: discard unsafe v2 queued payloads on upgrade.

All tests must run against the **actual pinned checkout** after applying the patch. Local test authoring and TypeScript syntax checking do not imply their assertions pass.

## Outstanding release gates

1. Review the **two supplied documents**, currently unavailable from this chat, and reconcile security obligations.
2. `--check`, TypeScript typechecking, Vitest, browser extension build and Imposter HDK 0.7 / HDI 0.8 WASM must run in a real checkout and be fixed until PASS.
3. Generate byte-for-byte serialization/hash vectors from **pinned Holochain 0.7**; assert correct capability entry and action hash parity.
4. Execute the real Imposter integrity/coordinator WASMs including initial capability grants and failed unauthorized call cases.
5. Run two-agent DHT tests (private body never retrievable) and real browser restart/retry across OPFS, Firefox and Chromium.
6. Coordinate a signed envelope with Agent 3 (verified sender, DNA/recipient, expiry, nonce/replay store, capability checks) and remove the temporary blanket remote-signal denial **only after** a full verification implementation and tests.
7. Review differences between the pinned commit and any later upstream branch before preparing isolated upstream PRs.

**Readiness:** P0 **NOT READY** (P0 fixes are untested; remote signals disabled, although basic lobby paths may not need them). P1 **NOT READY** (real WASM initialization, confidentiality, cross-agent authorization and networking unverified).
