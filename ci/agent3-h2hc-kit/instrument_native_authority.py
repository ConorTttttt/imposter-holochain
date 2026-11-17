#!/usr/bin/env python3
"""Instrument Agent 3's existing real-HWC bridge with a *native* HC 0.7 conductor.

This intentionally bypasses Electron/hc-spin: pinned Holonix provides hc 0.7.0
and holochain 0.7.0 as ordinary executables. Never use zero-arc proxy peers
as an authority. Native process readiness is not proof of validation.
No private native keys or passphrases are written to runtime-evidence.
"""
from pathlib import Path
import sys

src = Path(sys.argv[1])
s = src.read_text()

repl = [
    ("import { spawnSync } from 'node:child_process';",
     "import { spawnSync, spawn } from 'node:child_process';\nimport net from 'node:net';"),
    ("let context,server,artifactDir;",
     "let context,server,artifactDir,nativeConductor,nativeRoot;"),
    (" const info=await step('PATCHED_HWC_INSTALL_APP',async()=>{", r"""
 // This is the EXACT byte-for-byte host-bound .happ built using the Lair-held
 // HWC identity. Never rebuild with a new network seed on the native side.
 const nativeHapp=path.join(artifactDir,'app/imposter-browser-poc.happ');
 await step('NATIVE_HOLOCHAIN_0_7_SANDBOX_SETUP',async()=>{
   must(fs.existsSync(nativeHapp),'Host-bound native .happ is absent');
   const bootstrap=process.env.H2HC_LINKER_BOOTSTRAP_URL||
     'https://dev-test-bootstrap2.holochain.org/';
   const relay=process.env.H2HC_LINKER_RELAY_URL||bootstrap;
   must(bootstrap===relay,'Native and H2HC relay/bootstrap topology drift');
   nativeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'imposter-hc-0.7-authority-'));
   const nativeEnv={...process.env,RUST_LOG:'holochain=info,kitsune2=debug,iroh=info'};
   // A native conductor must never inherit the operator-only H2HC secret.
   delete nativeEnv.H2HC_LINKER_ADMIN_SECRET;
   const passphrase=crypto.randomBytes(32).toString('hex')+'\n';
   const probe=spawnSync('nix',['develop','--no-write-lock-file',
     '--command','bash','-c',
     'set -e; hc --version; holochain --version; hc sandbox --help >/dev/null; hc sandbox generate --help >/dev/null; hc sandbox run --help >/dev/null',
     'native-version-check'],{cwd:ROOT,env:nativeEnv,encoding:'utf8',
       timeout:90000,maxBuffer:4*1024*1024});
   const logBase=path.join(OUT_LOG,'native-toolchain-probe.log');
   fs.writeFileSync(logBase,
      'COMMAND=nix develop --no-write-lock-file --command bash -c <version-and-help-probes>\n'+
      'EXIT_CODE='+String(probe.status)+' SIGNAL='+String(probe.signal)+'\n'+
      String(probe.stdout||'')+'\n---stderr---\n'+String(probe.stderr||''));
   if(probe.error||probe.status!==0)throw Error('Pinned hc/holochain native CLI probe failed; exit='+
      probe.status+' signal='+probe.signal+' '+String(probe.error?.message||probe.stderr||'').slice(-600));
   record('NATIVE_HOLOCHAIN_0_7_TOOL','PASS','hc and holochain real binaries executable; Electron not used');
   const generateScript='set -eu; cd "$1"; exec hc sandbox --piped generate '+
     '--app-id imposter-native-authority --num-sandboxes 2 --root "$1" --directories conductor-a,conductor-b '+
     '--in-process-lair "$2" network --bootstrap "$3" --target-arc-factor 1 quic "$4"';
   const gen=spawnSync('nix',['develop','--no-write-lock-file',
     '--command','bash','-c',generateScript,'native-sandbox',
      nativeRoot,nativeHapp,bootstrap,relay],{
        cwd:ROOT,env:nativeEnv,encoding:'utf8',input:passphrase,
        timeout:180000,maxBuffer:8*1024*1024});
   fs.writeFileSync(path.join(OUT_LOG,'native-sandbox-generate.log'),
      'COMMAND=hc sandbox --piped generate --app-id imposter-native-authority '+
      '--num-sandboxes 2 --root <ephemeral> --directories conductor-a,conductor-b --in-process-lair <EXACT_HAPP> '+
      'network --bootstrap '+bootstrap+' --target-arc-factor 1 quic '+relay+'\n'+
      'EXIT_CODE='+String(gen.status)+' SIGNAL='+String(gen.signal)+'\n'+
      String(gen.stdout||'')+'\n---stderr---\n'+String(gen.stderr||''));
   if(gen.error||gen.status!==0)throw Error('Native 0.7 sandbox generation failed; exit='+
      gen.status+' signal='+gen.signal+' (native-sandbox-generate.log): '+
      String(gen.error?.message||gen.stderr||'').slice(-900));
   must(fs.existsSync(path.join(nativeRoot,'.hc')),'Native 0.7 sandbox did not persist .hc manifest');
   for(const dir of ['conductor-a','conductor-b']){
     const config=path.join(nativeRoot,dir,'conductor-config.yaml');
     must(fs.existsSync(config),'Native 0.7 conductor config not persisted: '+config);
     const configBody=fs.readFileSync(config,'utf8');
     must(/target_arc_factor:\s*1(?:\s|$)/m.test(configBody),
       'Native conductor '+dir+' target arc is zero/missing');
     must(configBody.includes(bootstrap)&&configBody.includes(relay),
       'Native conductor '+dir+' network config does not match authenticated H2HC');
   }
   // Avoid archiving paths, private keystore or admin credentials.
   evidence.native_authority_config={
     cli:'hc sandbox',holochain_version:'0.7.0',
     bootstrap,relay,target_arc_factor:1,host_bound_dna:m.dna_hash,
     happ_sha256:m.happ_bundle_sha256,isolated_lair_identity:true,native_conductors:2};
   const runScript='set -eu; cd "$1"; exec hc sandbox --piped --force-admin-ports 33555,33557 run --ports 33556,33558';
   nativeConductor=spawn('nix',['develop','--no-write-lock-file',
     '--command','bash','-c',runScript,'native-sandbox',nativeRoot],{
       cwd:ROOT,env:nativeEnv,stdio:['pipe','pipe','pipe'],detached:true});
   const nativeLogPath=path.join(OUT_LOG,'native-holochain-0.7.log');
   const stream=fs.createWriteStream(nativeLogPath);
   nativeConductor.stdout.pipe(stream,{end:false});
   nativeConductor.stderr.pipe(stream,{end:false});
   nativeConductor.stdin.end(passphrase);
   let exited=null;
   nativeConductor.on('error',e=>{exited='spawn error '+e.message;});
   nativeConductor.on('exit',(code,signal)=>{exited='exit '+code+' signal '+signal;});
   const connected=(port)=>new Promise(resolve=>{
      const socket=net.connect({host:'127.0.0.1',port});
      let settled=false;
      const done=v=>{if(!settled){settled=true;socket.destroy();resolve(v);}};
      socket.once('connect',()=>done(true));
      socket.once('error',()=>done(false));
      socket.setTimeout(700,()=>done(false));
   });
   let ready=false;
   for(let i=0;i<100;i++){
     if(exited)break;
     if(await connected(33555)&&await connected(33557)){ready=true;break;}
     await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(!ready)throw Error('Native 0.7 admin WebSocket never opened: '+
       String(exited||'50 seconds elapsed')+'; inspect native-holochain-0.7.log');
   record('NATIVE_AUTHORITY','CANDIDATE_RUNNING',
      'Real hc sandbox 0.7 native process with independent Lair and configured arc=1; '+
      'admin WS reachable, but peer discovery and integrity validation NOT YET PROVEN');
   // Port readiness must never be mistaken for joined peers or validated DHT ops.
 });
 const info=await step('PATCHED_HWC_INSTALL_APP',async()=>{"""),
    (" if(context)await context.close().catch(()=>{});", r""" if(nativeConductor?.pid){
   try{process.kill(-nativeConductor.pid,'SIGTERM');}
   catch(_e){nativeConductor.kill('SIGTERM');}
 }
 if(context)await context.close().catch(()=>{});""")
]
# A green investigation job must never be mistaken for successful DHT delivery.
# Preserve all earlier positive observations in runtime-evidence.json before failing.
repl.append((
    " record('SEAT_RECONNECT','NOT RUN','Requires guest and host DHT state');",
    r""" record('SEAT_RECONNECT','NOT RUN','Requires guest and host DHT state');
 const publication=evidence.h2hc_dht_result;
 if(!publication || publication.queued<1 || publication.failed!==0 ||
    publication.published===0) {
   record('NATIVE_DHT_END_TO_END','BLOCKED',
     'Native 0.7 conductor started and peers exchanged preflight; '+
     'H2HC remote published=0. Native integrity and independent GET are NOT RUN.');
   throw Error('Strict DHT convergence gate: zero remotely delivered HWC operations; '+
     'this CI job must FAIL while authority validation/retrieval are unproven');
 }
 record('NATIVE_DHT_END_TO_END','BLOCKED',
   'Remote publish observed but native integrity verdict and independent authenticated retrieval NOT proven');
 throw Error('Strict DHT convergence gate: publication acknowledgement is not native validity or retrieval');"""
))

for old, new in repl:
    if s.count(old) != 1:
        raise SystemExit(f'Native probe anchor drift {old!r}: {s.count(old)}')
    s = s.replace(old, new, 1)

dst = src.with_name('agent3-native-authority-browser-bridge.mjs')
if dst.exists():
    raise SystemExit('Refuse overwrite existing bridge')
dst.write_text(s)
print('Wrote native (non-Electron) hc sandbox 0.7.0 authority experiment:', dst)
