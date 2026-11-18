#!/usr/bin/env python3
"""Query Holochain 0.7 native READ-ONLY admin op timings instead of SQLCipher.

The hc client call --port <admin> dump-op-timings <dna> command is an
authorized native admin method. Only ephemeral CI instrumented JS is affected.
Archives public operation hashes/status, no SQLCipher keys or Lair secrets.
"""
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
anchor="  const dbAudit=spawnSync('python3',["
if s.count(anchor)!=1:
    raise SystemExit("Native admin probe anchor drift")
insert=r"""
  // Native Holochain 0.7 official admin diagnostics avoid encrypted DHT
  // databases entirely, and do not inspect Lair keys or private entries.
  const adminOpStatus={};
  for(const [conductor,port] of [['conductor-a',33555],['conductor-b',33557]]){
    const adminEnv={...process.env};
    delete adminEnv.H2HC_LINKER_ADMIN_SECRET;
    const cmd=spawnSync('nix',['develop','--no-write-lock-file',
      '--command','hc','client','call','--port',String(port),
      'dump-op-timings',m.dna_hash,'--limit','2000'],{
      cwd:ROOT,env:adminEnv,encoding:'utf8',
      timeout:45000,maxBuffer:12*1024*1024
    });
    const result={port,exit_code:cmd.status,
      error_type:cmd.error?.code||null,observed_ops:[],
      first_error:null,timings_count:0};
    if(cmd.status===0){
      try{
        const parsed=JSON.parse(cmd.stdout);
        const items=Array.isArray(parsed?.timings)?parsed.timings:[];
        result.timings_count=items.length;
        // Native admin serializes DhtOpHash as bytes (not always the
        // multibase JS string used by Kitsune2 logs). Normalize explicitly.
        const normalizeHash=h=>publicHoloHash(h)||
          (typeof h==='string'&&h.startsWith('uhCQk')?h:null);
        result.hash_wire_probe=items.slice(0,2).map(t=>({
          wire_type:typeof t.op_hash,
          wire_keys:t.op_hash&&typeof t.op_hash==='object'?Object.keys(t.op_hash).slice(0,6):[],
          normalized:normalizeHash(t.op_hash)
        }));
        result.observed_ops=items.map(t=>({op_hash:normalizeHash(t.op_hash),
            when_integrated:t.when_integrated??null,
            validation_status:t.validation_status??null,
            locally_validated:t.locally_validated??null,
            abandoned_at:t.abandoned_at??null}))
          .filter(t=>t.op_hash&&incomingIds.includes(t.op_hash));
      }catch(err){result.first_error='JSON_PARSE_'+String(err).slice(0,130);}
    }else{
      // CLI diagnostics are not secrets; limit logging to failure class,
      // avoiding any accidental local paths or environment dump.
      result.first_error='CLI_'+String(cmd.stderr||'')
        .replaceAll(nativeRoot,'<ephemeral>').slice(-240);
    }
    adminOpStatus[conductor]=result;
  }
  evidence.native_admin_op_timings=adminOpStatus;
  const adminObserved=Object.values(adminOpStatus).flatMap(x=>x.observed_ops);
  const adminNativeValid=adminObserved.filter(x=>
    ['valid','accepted'].includes(String(x.validation_status||'').toLowerCase())
    &&x.locally_validated===true&&x.when_integrated!==null);
  evidence.native_admin_valid_incoming_op_hashes=[...new Set(
    adminNativeValid.map(x=>x.op_hash))];
  record('NATIVE_ADMIN_OPERATION_VALIDATION',
    adminNativeValid.length?'PASS':'BLOCKED',
    adminNativeValid.length?
      'Native admin op timings show '+adminNativeValid.length+
      ' incoming op entries accepted, locally validated, and integrated':
      'Native read-only admin diagnostic did not return matched Valid op rows; inspect JSON evidence');
"""
s=s.replace(anchor,insert+"\n"+anchor)
p.write_text(s)
print("Injected native Holochain admin-only op-timing probe:",p)
