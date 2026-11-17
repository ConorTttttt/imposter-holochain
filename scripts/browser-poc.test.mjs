/** Offline tests: fake bundles and HoloHashes are intentionally synthetic.
 * No test compiles Rust, runs hc pack, performs genesis or proves HWC support. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mintSeed,validateSeed,validateHostKey,extractDnaHash,renderDnaManifest,
 renderHappManifest,requireWasm,assertAbsent,writeMetadata,writeChecksums,
 verifyMetadata,verifyChecksums} from './browser-poc-lib.mjs';

const SCRIPTS=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(SCRIPTS,'..');
const agent='u'+Buffer.concat([Buffer.from([0x84,0x20,0x24]),Buffer.alloc(36,7)]).toString('base64url');
const dnaHash='u'+Buffer.concat([Buffer.from([0x84,0x2d,0x24]),Buffer.alloc(36,8)]).toString('base64url');
const seed=`g1.${agent}.0123456789abcdef0123456789abcdef`;
const HEAD='f'.repeat(40);
const manifest=`manifest_version: '0'\nname: game\nintegrity:\n  network_seed: null\n  properties: null\n  zomes:\n    - name: game_integrity\n      path: ../../../target/wasm32-unknown-unknown/release/game_integrity.wasm\ncoordinator:\n  zomes:\n    - name: game\n      path: ../../../target/wasm32-unknown-unknown/release/game.wasm\n      dependencies:\n        - name: game_integrity\n`;
const template=fs.readFileSync(path.join(ROOT,'workdir/browser-poc.happ.yaml'),'utf8');
const wasmHeader=Buffer.from([0,97,115,109,1,0,0,0]);
function temp(t) {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-poc-fixture-'));
  t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
  return d;
}
function fixture(t) {
  const d=temp(t);fs.mkdirSync(path.join(d,'dna'));fs.mkdirSync(path.join(d,'app'));
  fs.writeFileSync(path.join(d,'dna/dna.yaml'),renderDnaManifest(manifest,seed));
  fs.writeFileSync(path.join(d,'app/happ.yaml'),renderHappManifest(template,seed,dnaHash));
  for(const z of ['game','game_integrity'])
    fs.writeFileSync(path.join(d,'dna',z+'.wasm'),Buffer.concat([wasmHeader,Buffer.from('SYNTHETIC-NOT-COMPILED-ZOME')]));
  const fakeBundle=Buffer.from('SYNTHETIC-DNA-NOT-AN-HC-BUNDLE');
  fs.writeFileSync(path.join(d,'dna/game.dna'),fakeBundle);
  fs.writeFileSync(path.join(d,'app/game.dna'),fakeBundle);
  fs.writeFileSync(path.join(d,'app/imposter-browser-poc.happ'),'SYNTHETIC-HAPP');
  writeMetadata(d,seed,dnaHash,HEAD);writeChecksums(d);
  return d;
}
test('valid host seed uses 128-bit lower-case random suffix and varies',()=>{
  const s1=mintSeed(agent),s2=mintSeed(agent);
  assert.equal(validateSeed(s1).host,agent);
  assert.match(s1,/\.[a-f0-9]{32}$/);assert.notEqual(s1,s2);
  assert.equal(validateSeed(seed).randomId,'0123456789abcdef0123456789abcdef');
});
test('seed shell generates correctly shaped fixture seed (not actual HWC identity)',()=>{
  const r=spawnSync('sh',[path.join(SCRIPTS,'browser-poc-seed.sh'),agent],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);validateSeed(r.stdout.trim());
});
test('malformed host AgentPubKey is rejected',()=>{
  for(const k of ['', 'uhC0k'+'A'.repeat(48),'uhCAk'+'@'.repeat(48),'uhCAk'+'A'.repeat(47),agent+'A']) {
    assert.throws(()=>validateHostKey(k));
    assert.notEqual(spawnSync('sh',[path.join(SCRIPTS,'browser-poc-seed.sh'),k]).status,0);
  }
});
test('malformed seeds rejected by production CLI',()=>{
  for(const s of ['', 'room1.ABCD',seed.replace('g1','g2'),seed.slice(0,-1),
     seed.replace('0123456789abcdef','0123456789ABCDEF'),seed+'oops']) {
    assert.throws(()=>validateSeed(s));
    assert.notEqual(spawnSync('node',[path.join(SCRIPTS,'browser-poc-lib.mjs'),'validate-seed',s]).status,0);
  }
});
test('missing hc and Nix fails explicitly rather than claiming a build',t=>{
  const bin=path.join(temp(t),'bin');fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath,path.join(bin,'node'));
  fs.symlinkSync('/usr/bin/dirname',path.join(bin,'dirname'));
  const r=spawnSync('/bin/bash',[path.join(SCRIPTS,'browser-poc-build.sh'),seed],
    {env:{...process.env,PATH:bin},encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/hc and nix unavailable/);
});
test('missing/non-WASM/truncated artifacts refused',t=>{
  const p=path.join(temp(t),'game.wasm');
  assert.throws(()=>requireWasm(p),/missing/);
  fs.writeFileSync(p,'not-wasm');assert.throws(()=>requireWasm(p),/not a wasm32/);
  fs.writeFileSync(p,Buffer.from([0,97,115,109]));assert.throws(()=>requireWasm(p),/truncated/);
});
test('modified source inputs rejected',()=>{
  for(const m of [manifest.replace('network_seed: null','network_seed: attacker'),
   manifest.replace('game_integrity.wasm','changed.wasm'),
   manifest.replace('name: game_integrity','name: malicious'),
   manifest.replace('dependencies:\n        - name: game_integrity','dependencies: []')])
    assert.throws(()=>renderDnaManifest(m,seed));
});
test('staged DNA preserves zome declarations and has exactly one seed',()=>{
  const out=renderDnaManifest(manifest,seed);
  assert.equal(out.split(`network_seed: ${seed}`).length-1,1);
  assert.match(out,/path: \.\/game_integrity\.wasm/);
  assert.match(out,/path: \.\/game\.wasm/);
  assert.doesNotMatch(out,/target\/wasm32/);
});
test('manifest placeholders and role-level DNA hash replaced exactly',()=>{
  const out=renderHappManifest(template,seed,dnaHash);
  assert.ok(out.includes('network_seed: '+seed));assert.ok(out.includes('installed_hash: '+dnaHash));
  assert.ok(out.includes('clone_limit: 0'));assert.doesNotMatch(out,/__BROWSER_POC_/);
  assert.throws(()=>renderHappManifest(template.replace('__BROWSER_POC_DNA_HASH__','missing'),seed,dnaHash));
  assert.throws(()=>renderHappManifest(template+'\n# __BROWSER_POC_SEED__',seed,dnaHash));
});
test('hc DNA hash extraction refuses absent, ambiguous and too-long tokens',()=>{
  assert.equal(extractDnaHash(`DNA hash: ${dnaHash}\n`),dnaHash);
  for(const s of ['',`hash: ${dnaHash} ${dnaHash}`,`hash: ${agent}`,`hash: ${dnaHash}X`])
    assert.throws(()=>extractDnaHash(s));
});
test('metadata seed and DNA-hash consistency checks',t=>{
  const d=fixture(t);assert.doesNotThrow(()=>verifyMetadata(d));
  const f=path.join(d,'app/happ.yaml');
  fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('installed_hash: '+dnaHash,'installed_hash: bad'));
  assert.throws(()=>verifyMetadata(d),/hash mismatch/);
});
test('checksum mismatch detected on modified bundle',t=>{
  const d=fixture(t);fs.appendFileSync(path.join(d,'dna/game.dna'),'TAMPER');
  assert.throws(()=>verifyChecksums(d),/checksum mismatch/);
  assert.throws(()=>verifyMetadata(d),/checksum mismatch/);
});
test('app DNA must be identical to staged packed DNA',t=>{
  const d=fixture(t);fs.appendFileSync(path.join(d,'app/game.dna'),'TAMPER');
  assert.throws(()=>verifyMetadata(d),/DNA copy differs/);
});
test('existing artifact protected from overwrite',t=>{
  const d=temp(t);assert.doesNotThrow(()=>assertAbsent(path.join(d,'other')));
  assert.throws(()=>assertAbsent(d),/existing artifact protected/);
});
test('verification is idempotent, including shell wrapper',t=>{
  const d=fixture(t),before=fs.readFileSync(path.join(d,'SHA256SUMS'),'utf8');
  for(let i=0;i<3;i++){verifyChecksums(d);verifyMetadata(d);}
  assert.equal(fs.readFileSync(path.join(d,'SHA256SUMS'),'utf8'),before);
  const r=spawnSync('bash',[path.join(SCRIPTS,'browser-poc-verify.sh'),d],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/NOT TESTED/);
});
