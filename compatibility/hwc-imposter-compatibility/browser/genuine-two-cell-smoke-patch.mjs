#!/usr/bin/env node
/**
 * CI-only extension of Agent 4's immutable authentic-Lair browser acceptance.
 * Two DIFFERENT real browser-origin Lair keys share ONE extension OPFS worker.
 * Both independently install exactly the same native host-bound DNA and call
 * actual Imposter coordinator WASM, producing identical private CapGrants.
 */
import fs from 'node:fs';
import path from 'node:path';
if (process.env.CI !== 'true' ||
    process.env.BROWSER_POC_IDENTITY_SOURCE !== 'EPHEMERAL_HWC_BROWSER_PROFILE') {
  throw Error('Refusing to instrument non-CI or non-ephemeral browser source');
}
const file = path.resolve(process.argv[2] || 'scripts/browser-poc-hwc-smoke.mjs');
let code = fs.readFileSync(file, 'utf8');
function swap(from, to) {
  const n = code.split(from).length - 1;
  if (n !== 1) throw Error('Pinned Agent 4 smoke anchor drift: ' + n + ' ' + from.slice(0, 70));
  code = code.replace(from, to);
}
swap(
  "      'Private CapGrant missing or exposed in network-facing record conversion');",
  "      'Private CapGrant missing or exposed in network-facing record conversion');\n" +
  " must(snap.p0_two_real_cells?.ready && snap.p0_two_real_cells.own===1 &&\n" +
  "      snap.p0_two_real_cells.third_denied,\n" +
  "      'Real Lair CapGrant is absent or accessible in a stranger cell');",
);
const newSecondOrigin = `
 const secondKey = await step('P0_TWO_REAL_LAIR_CELLS_ONE_OPFS', async()=>{
   const otherPage = await context.newPage();
   await otherPage.goto('http://127.0.0.1:8765',{waitUntil:'domcontentloaded'});
   await otherPage.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
   const other = await otherPage.evaluate(async(expectedDna)=>{
     const hc=window.holochain;
     await hc.connect(); // Different origin, same extension/OPFS profile, independent Lair key.
     const asBytes=v=>v instanceof Uint8Array?v:Array.isArray(v)?new Uint8Array(v):
       v&&typeof v==='object'?new Uint8Array(Object.keys(v).sort((a,b)=>Number(a)-Number(b)).map(k=>v[k])):new Uint8Array();
     const enc=v=>'u'+btoa(String.fromCharCode(...asBytes(v)))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
     const agent=enc(hc.myPubKey);
     const response=await fetch('/imposter-browser-poc.happ',{cache:'no-store'});
     if(!response.ok)throw Error('Second-origin hApp fetch failed');
     await hc.installApp({bundle:new Uint8Array(await response.arrayBuffer()),
       installedAppId:'imposter-browser-poc-second-origin'});
     const info=await hc.appInfo('imposter-browser-poc-second-origin');
     if(enc(info.cells[0][0])!==expectedDna||enc(info.cells[0][1])!==agent)
       throw Error('Second real-Lair cell identity or DNA drift');
     await hc.callZome({zome_name:'game',fn_name:'get_game_state',payload:null});
     return agent;
   },m.dna_hash);
   must(other!==host,'Second origin reused the first real Lair identity');
   const secondSnap=await snapshotFor(other);
   verifyChain(secondSnap);
   must(secondSnap.p0_two_real_cells.capgrant_hash===
         authored.p0_two_real_cells.capgrant_hash,
        'Two real Lair cells on the same DNA authored different private CapGrant hashes');
   must(secondSnap.p0_two_real_cells.total===2,
        'Two Lair-backed cells did not persist two physical entries in ONE OPFS');
   const prior=ciSnapshots.length;
   await page.evaluate(async()=>await window.holochain.callZome({
      zome_name:'game',fn_name:'get_game_state',payload:null}));
   const firstAgain=await snapshotFor(host,prior);
   must(firstAgain.p0_two_real_cells.total===2 && firstAgain.p0_two_real_cells.own===1,
     'Second origin overwrote or exposed the real host private CapGrant');
   record('P0_TWO_REAL_LAIR_CELLS_IDENTICAL_CAPGRANT','PASS',
     'two Lair-backed origin keys, same installed DNA, same private entry hash, two distinct physical OPFS rows');
   evidence.p0_two_lair_pubkeys=[host,other];
   return other;
 });
`;
swap(" await step('REAL_BROWSER_RESTART_PERSISTENCE',async()=>{",
  newSecondOrigin+" await step('REAL_BROWSER_RESTART_PERSISTENCE',async()=>{");
const restart = `
   // The same persistent browser profile is reopened. A second origin is
   // still backed by the same restored extension OPFS; no fake IndexedDB.
   const reloadedSecond=await context.newPage();
   await reloadedSecond.goto('http://127.0.0.1:8765',{waitUntil:'domcontentloaded'});
   await reloadedSecond.waitForFunction(()=>Boolean(window.holochain?.isWebConductor),{timeout:45000});
   const resumed=await reloadedSecond.evaluate(async()=>{
      const hc=window.holochain; await hc.connect();
      const b=new Uint8Array(hc.myPubKey||[]);
      return 'u'+btoa(String.fromCharCode(...b)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
   });
   must(resumed===secondKey,'Second real Lair key was not recovered after Chromium restart');
   await reloadedSecond.evaluate(async()=>await window.holochain.callZome({
     zome_name:'game',fn_name:'get_game_state',payload:null}));
   const secondRestart=await snapshotFor(secondKey,start);
   verifyChain(secondRestart,false);
   must(s.p0_two_real_cells.total===2 && secondRestart.p0_two_real_cells.total===2 &&
     s.p0_two_real_cells.capgrant_hash===secondRestart.p0_two_real_cells.capgrant_hash,
     'Two real-Lair-owned identical CapGrants did not both survive OPFS restart');
   record('P0_TWO_REAL_LAIR_IDENTICAL_GRANT_OPFS_RESTART','PASS',
     'same two Lair keys and two private CapGrant rows recovered from production OPFS after full restart');
`;
swap("   must(s.actions.map(x=>x.hash).join(',')===authored.actions.map(x=>x.hash).join(','),",
     restart+"   must(s.actions.map(x=>x.hash).join(',')===authored.actions.map(x=>x.hash).join(','),");
fs.writeFileSync(file, code);
console.log('CI_ONLY_TWO_REAL_LAIR_SAME_OPFS_ASSERTIONS_INSTALLED');
