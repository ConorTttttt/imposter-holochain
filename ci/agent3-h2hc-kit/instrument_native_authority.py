#!/usr/bin/env python3
"""Create an experimental native 0.7 authority version of the already green
real HWC/H2HC browser harness. Do not change HWC or game source. No mocks.
A running hc-spin process is NOT proof of authority validation or retrieval.
"""
from pathlib import Path
import sys
src=Path(sys.argv[1])
s=src.read_text()
repl=[
("import { spawnSync } from 'node:child_process';",
 "import { spawnSync, spawn } from 'node:child_process';"),
("let context,server,artifactDir;",
 "let context,server,artifactDir,nativeConductor;"),
(" const info=await step('PATCHED_HWC_INSTALL_APP',async()=>{",
 r"""
 // Use exactly the native .happ packaged for the live Lair-held HWC host.
 // The bootstrap and relay only discover peers: they never validate DHT data.
 const nativeHapp=path.join(artifactDir,'app/imposter-browser-poc.happ');
 const bootstrap='https://dev-test-bootstrap2.holochain.org/';
 const nativeLogs=path.join(OUT_LOG,'native-holochain-0.7.log');
 await (async()=>{
   const cli=path.join(ROOT,'node_modules/.bin/hc-spin');
   must(fs.existsSync(cli),'Pinned hc-spin missing after npm ci root');
   const test=spawnSync('nix',['develop','--no-write-lock-file','--command',
      cli,'--help'],{
      cwd:ROOT,env:{...process.env},encoding:'utf8',timeout:90000});
   fs.writeFileSync(path.join(OUT_LOG,'native-toolchain-probe.log'),
      String(test.stdout||'')+'\n---stderr---\n'+String(test.stderr||''));
   if(test.status!==0){
     record('NATIVE_HOLOCHAIN_0_7_TOOL','BLOCKED',
       'Pinned Nix + npm-locked hc-spin CLI cannot execute (see probe log)');
     record('NATIVE_AUTHORITY','NOT RUN','No pinned native executable available');
     return;
   }
   record('NATIVE_HOLOCHAIN_0_7_TOOL','PASS','npm-locked hc-spin 0.700.0 CLI executable within pinned Holochain 0.7 Nix');
   const env={...process.env, RUST_LOG:'holochain=info,kitsune2=info'};
   delete env.H2HC_LINKER_ADMIN_SECRET;
   // hc-spin's --bootstrap-url/--relay-url are standard native 0.7 options.
   const args=['develop','--no-write-lock-file','--command',
     cli,'-n','1','--ui-port','8765','--bootstrap-url',bootstrap,
     '--relay-url',bootstrap,nativeHapp];
   nativeConductor=spawn('nix',args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
   const log=fs.createWriteStream(nativeLogs,{flags:'w'});
   nativeConductor.stdout.pipe(log,{end:false});
   nativeConductor.stderr.pipe(log,{end:false});
   const start=Date.now();while(Date.now()-start<18000 && nativeConductor.exitCode===null)
     await new Promise(resolve=>setTimeout(resolve,500));
   if(nativeConductor.exitCode!==null) {
     record('NATIVE_AUTHORITY','BLOCKED',
       'Pinned hc-spin exited with code '+nativeConductor.exitCode+
       ' (inspect native-holochain-0.7.log); no authority proof');
   } else {
     record('NATIVE_AUTHORITY','CANDIDATE_RUNNING',
       'Pinned native conductor process alive with same host-bound .happ, but integration/validation NOT proven');
   }
 })();
 const info=await step('PATCHED_HWC_INSTALL_APP',async()=>{"""),
(" if(context)await context.close().catch(()=>{});",
 r""" if(nativeConductor)nativeConductor.kill('SIGTERM');
 if(context)await context.close().catch(()=>{});""")
]
for old,new in repl:
    if s.count(old)!=1: raise SystemExit(f"native probe anchor drift {old!r}: {s.count(old)}")
    s=s.replace(old,new,1)
dst=src.with_name("agent3-native-authority-browser-bridge.mjs")
if dst.exists():raise SystemExit("refuse overwrite")
dst.write_text(s)
print("Wrote isolated native conductor experiment:",dst)
