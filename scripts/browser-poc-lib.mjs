/**
 * Pure packaging checks for Agent 4's one-room P0 experiment.
 * This does NOT compile Rust, compute an authentic DNA hash or attest to HWC.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PIN = '111e6a44795e6572ed01191a98245ed723788c12';
export const HWC_PIN = '0c391226e78769d44ccb4661881ed8998b15f903';
export const H2HC_PIN = 'cab242d32c988fe5e4e9fd06ebc82ed043541aa2';
const EXPECTED_DNA_PATHS = {
  game_integrity: '../../../target/wasm32-unknown-unknown/release/game_integrity.wasm',
  game: '../../../target/wasm32-unknown-unknown/release/game.wasm',
};
const FILES = ['dna/dna.yaml','dna/game_integrity.wasm','dna/game.wasm','dna/game.dna',
  'app/happ.yaml','app/game.dna','app/imposter-browser-poc.happ','deployment.json'];
function requireMatch(test,message) { if (!test) throw new Error(message); }
function exactCount(source,text) { return source.split(text).length-1; }
function checkCanonicalHash(s,prefix) {
  requireMatch(typeof s==='string' && s.startsWith(prefix) && s.length===53,
    `invalid ${prefix==='uhCAk'?'AgentPubKey':'DNA hash'} syntax`);
  requireMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{48}$`).test(s),'invalid HoloHash base64url');
  const bytes=Buffer.from(s.slice(1),'base64url');
  requireMatch(bytes.length===39 && bytes.toString('base64url')===s.slice(1),'non-canonical HoloHash base64url encoding');
  return s;
}
export function validateHostKey(key) { return checkCanonicalHash(key,'uhCAk'); }
export function validateDnaHash(hash) { return checkCanonicalHash(hash,'uhC0k'); }
export function validateSeed(seed) {
  requireMatch(typeof seed==='string','seed must be text');
  const m=/^g1\.(uhCAk[A-Za-z0-9_-]{48})\.([0-9a-f]{32})$/.exec(seed);
  requireMatch(m,'seed must be g1.<host-AgentPubKeyB64>.<32-lowercase-hex>');
  validateHostKey(m[1]);
  return {seed,host:m[1],randomId:m[2]};
}
export function mintSeed(host) { return `g1.${validateHostKey(host)}.${randomBytes(16).toString('hex')}`; }
export function extractDnaHash(output) {
  requireMatch(typeof output==='string','hc dna hash produced no text');
  const hashes=[...output.matchAll(/(?:^|[^A-Za-z0-9_-])(uhC0k[A-Za-z0-9_-]{48})(?=$|[^A-Za-z0-9_-])/g)].map(m=>m[1]);
  requireMatch(hashes.length===1,`expected exactly one DNA hash in hc output, got ${hashes.length}`);
  return validateDnaHash(hashes[0]);
}
export function renderDnaManifest(source,seed) {
  validateSeed(seed);
  const lines=source.split('\n');
  requireMatch(lines.includes('integrity:'),'DNA manifest missing integrity');
  requireMatch(lines.filter(l=>/^  network_seed: null$/.test(l)).length===1,'DNA manifest must have exactly one unseeded integrity network_seed');
  for (const [z,wasmPath] of Object.entries(EXPECTED_DNA_PATHS)) {
    requireMatch(exactCount(source,`path: ${wasmPath}`)===1,`unexpected ${z} WASM source path`);
    requireMatch(lines.filter(l=>l===`    - name: ${z}`).length===1,`unexpected ${z} zome declaration`);
  }
  requireMatch(exactCount(source,'manifest_version:')===1 && lines.filter(l=>l.trim()==='name: game'||l.trim()==='- name: game').length===2,'unexpected DNA manifest structure');
  requireMatch(source.includes('dependencies:\n        - name: game_integrity'),'missing coordinator dependency');
  let result=source.replace(/^  network_seed: null$/m,`  network_seed: ${seed}`);
  for(const [z,wasmPath] of Object.entries(EXPECTED_DNA_PATHS))result=result.replace(`path: ${wasmPath}`,`path: ./${z}.wasm`);
  requireMatch(!result.includes('../../../target/'),'unstaged WASM path remains');
  requireMatch(exactCount(result,`network_seed: ${seed}`)===1,'DNA seed not unique');
  return result;
}
export function renderHappManifest(template,seed,dnaHash) {
  validateSeed(seed);validateDnaHash(dnaHash);
  for(const p of ['__BROWSER_POC_SEED__','__BROWSER_POC_DNA_HASH__'])
    requireMatch(exactCount(template,p)===1,`missing or repeated placeholder ${p}`);
  requireMatch(template.includes("manifest_version: '0'")&&template.includes('name: imposter-browser-poc'),'unexpected hApp manifest');
  requireMatch(template.includes('strategy: create')&&template.includes('name: game')&&template.includes('clone_limit: 0'),'hApp must use one provisioned game role without clones');
  requireMatch(exactCount(template,'path: ./game.dna')===1,'unexpected bundled DNA path');
  const result=template.replace('__BROWSER_POC_SEED__',seed).replace('__BROWSER_POC_DNA_HASH__',dnaHash);
  requireMatch(!result.includes('__BROWSER_POC_'),'unresolved hApp placeholder');
  return result;
}
export function assertAbsent(file) { requireMatch(!fs.existsSync(file),`existing artifact protected: ${file}`); }
export function requireWasm(file) {
  requireMatch(fs.existsSync(file)&&fs.statSync(file).isFile()&&fs.statSync(file).size>=8,`missing or truncated WASM artifact: ${file}`);
  const b=fs.readFileSync(file);
  requireMatch(b.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])),`not a wasm32 binary: ${file}`);
  // Header check only: it does not prove this file is a compiled game zome.
}
export function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function metadataFor(dir,seed,dnaHash,sourceHead) {
  const {host}=validateSeed(seed);validateDnaHash(dnaHash);
  requireMatch(/^[0-9a-f]{40}$/.test(sourceHead),'invalid source git SHA');
  const identitySource=process.env.BROWSER_POC_IDENTITY_SOURCE || 'UNVERIFIED_OPERATOR_INPUT';
  requireMatch(['UNVERIFIED_OPERATOR_INPUT','SYNTHETIC_CI_FIXTURE'].includes(identitySource),'invalid host identity source flag');
  return {
    schema_version:1,purpose:'P0 lobby ONLY; not full gameplay',runtime_validation:'NOT_RUN',
    signature_status:'UNSIGNED',host_identity_source:identitySource,deployment_ready:false,
    host_agent_pub_key:host,network_seed:seed,dna_hash:dnaHash,source_head:sourceHead,
    pin:{imposter:PIN,hwc:HWC_PIN,h2hc:H2HC_PIN},
    wasm_sha256:{game:sha256(path.join(dir,'dna/game.wasm')),game_integrity:sha256(path.join(dir,'dna/game_integrity.wasm'))},
    dna_bundle_sha256:sha256(path.join(dir,'dna/game.dna')),
    happ_bundle_sha256:sha256(path.join(dir,'app/imposter-browser-poc.happ'))
  };
}
export function writeMetadata(dir,seed,dnaHash,sourceHead) {
  fs.writeFileSync(path.join(dir,'deployment.json'),JSON.stringify(metadataFor(dir,seed,dnaHash,sourceHead),null,2)+'\n',{flag:'wx'});
}
export function verifyMetadata(dir) {
  const m=JSON.parse(fs.readFileSync(path.join(dir,'deployment.json'),'utf8'));
  const {host}=validateSeed(m.network_seed);validateDnaHash(m.dna_hash);
  requireMatch(m.schema_version===1&&m.purpose==='P0 lobby ONLY; not full gameplay','unexpected metadata format');
  requireMatch(m.host_agent_pub_key===host,'host/seed mismatch');
  requireMatch(m.pin?.imposter===PIN&&m.pin?.hwc===HWC_PIN&&m.pin?.h2hc===H2HC_PIN,'pin mismatch');
  requireMatch(m.runtime_validation==='NOT_RUN'&&m.signature_status==='UNSIGNED','metadata must not claim runtime or signature checks');
  requireMatch(['UNVERIFIED_OPERATOR_INPUT','SYNTHETIC_CI_FIXTURE'].includes(m.host_identity_source) && m.deployment_ready===false,
    'packaging metadata cannot assert deployment-ready HWC identity');
  requireMatch(/^[0-9a-f]{40}$/.test(m.source_head),'invalid head SHA');
  requireMatch(m.dna_bundle_sha256===sha256(path.join(dir,'dna/game.dna')),'DNA bundle checksum mismatch');
  requireMatch(m.happ_bundle_sha256===sha256(path.join(dir,'app/imposter-browser-poc.happ')),'hApp bundle checksum mismatch');
  for(const z of ['game','game_integrity']) {
    const f=path.join(dir,`dna/${z}.wasm`);
    requireWasm(f);
    requireMatch(m.wasm_sha256?.[z]===sha256(f),`${z} WASM checksum mismatch`);
  }
  requireMatch(fs.readFileSync(path.join(dir,'app/game.dna')).equals(fs.readFileSync(path.join(dir,'dna/game.dna'))),'staged app DNA copy differs');
  const dna=fs.readFileSync(path.join(dir,'dna/dna.yaml'),'utf8'),happ=fs.readFileSync(path.join(dir,'app/happ.yaml'),'utf8');
  requireMatch(exactCount(dna,`network_seed: ${m.network_seed}`)===1,'DNA manifest seed mismatch');
  requireMatch(exactCount(happ,`network_seed: ${m.network_seed}`)===1,'hApp role seed mismatch');
  requireMatch(exactCount(happ,`installed_hash: ${m.dna_hash}`)===1,'installed DNA hash mismatch');
  requireMatch(!dna.includes('__BROWSER_POC_')&&!happ.includes('__BROWSER_POC_'),'unreplaced placeholder');
  requireMatch(happ.includes('clone_limit: 0')&&happ.includes('strategy: create'),'clone/provisioning drift');
  for(const z of ['game','game_integrity'])requireMatch(dna.includes(`path: ./${z}.wasm`),`missing staged ${z} path`);
  return m;
}
export function writeChecksums(dir) {
  const entries=FILES.map(name=>`${sha256(path.join(dir,name))}  ${name}`).join('\n')+'\n';
  fs.writeFileSync(path.join(dir,'SHA256SUMS'),entries,{flag:'wx'});
}
export function verifyChecksums(dir) {
  const txt=fs.readFileSync(path.join(dir,'SHA256SUMS'),'utf8'),lines=txt.trimEnd().split('\n');
  requireMatch(lines.length===FILES.length,'missing or unexpected checksums');
  for(let i=0;i<FILES.length;i++)
    requireMatch(lines[i]===`${sha256(path.join(dir,FILES[i]))}  ${FILES[i]}`,`checksum mismatch: ${FILES[i]}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)) {
  const [op,...args]=process.argv.slice(2);
  try {
    if(op==='seed') console.log(mintSeed(args[0]));
    else if(op==='validate-seed')validateSeed(args[0]);
    else if(op==='parse-hash') {let input='';for await(const chunk of process.stdin)input+=chunk;console.log(extractDnaHash(input));}
    else if(op==='render-dna') {const [src,out,seed]=args;fs.writeFileSync(out,renderDnaManifest(fs.readFileSync(src,'utf8'),seed),{flag:'wx'});}
    else if(op==='render-happ') {const [src,out,seed,dnaHash]=args;fs.writeFileSync(out,renderHappManifest(fs.readFileSync(src,'utf8'),seed,dnaHash),{flag:'wx'});}
    else if(op==='require-wasm')requireWasm(args[0]);
    else if(op==='assert-absent')assertAbsent(args[0]);
    else if(op==='write-metadata')writeMetadata(...args);
    else if(op==='write-checksums')writeChecksums(args[0]);
    else if(op==='verify'){verifyChecksums(args[0]);verifyMetadata(args[0]);console.log('Fixture/packaging consistency PASS; HWC runtime NOT TESTED');}
    else throw Error('unknown packaging helper command');
  }catch(err){console.error(`browser-poc-lib: ${err.message}`);process.exitCode=1;}
}
