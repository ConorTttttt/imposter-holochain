#!/usr/bin/env node
/**
 * CI ONLY. Extend Agent 4's immutable, previously headed-browser-verified
 * smoke harness with strict same-OPFS two-cell collision/restart assertions.
 */
import fs from 'node:fs';
import path from 'node:path';
if (process.env.CI !== 'true' ||
    process.env.BROWSER_POC_IDENTITY_SOURCE !== 'EPHEMERAL_HWC_BROWSER_PROFILE') {
  throw Error('Refusing to instrument non-ephemeral production browser source');
}
const file = path.resolve(process.argv[2] || 'scripts/browser-poc-hwc-smoke.mjs');
let src = fs.readFileSync(file, 'utf8');
const anchors = [
  [
    "  must(snap.capgrant_count===1&&snap.capgrant_stored&&snap.capgrant_wire_hidden,\n       'Private CapGrant missing or exposed in network-facing record conversion');",
    "  must(snap.capgrant_count===1&&snap.capgrant_stored&&snap.capgrant_wire_hidden,\n       'Private CapGrant missing or exposed in network-facing record conversion');\n" +
    "  must(snap.p0_collision?.ready && snap.p0_collision.rows === 2 &&\n" +
    "       snap.p0_collision.both_local_reads && snap.p0_collision.wrong_cell_denied,\n" +
    "       'Same-OPFS, same-DNA private CapGrant collision or cross-cell disclosure');",
  ],
  [
    "   verifyChain(s,false); // read-only reload should not sign any new actions",
    "   verifyChain(s,false); // read-only reload should not sign any new actions\n" +
    "   must(s.p0_collision.preexisting === 2,\n" +
    "      'Same-OPFS second cell CapGrant not retained after complete Chromium restart');\n" +
    "   record('P0_SAME_OPFS_IDENTICAL_CAPGRANT_RESTART','PASS',\n" +
    "     'Two cell rows; identical private hash; first and second readable locally after browser restart; third cell blocked');",
  ],
];
for (const [oldText, newText] of anchors) {
  const n = src.split(oldText).length - 1;
  if (n !== 1) throw Error('Pinned Agent4 smoke source drift: expected one anchor, found ' + n);
  src = src.replace(oldText, newText);
}
fs.writeFileSync(file, src);
console.log('CI_ONLY_OPFS_COLLISION_RESTART_ASSERTIONS_INSTALLED');
