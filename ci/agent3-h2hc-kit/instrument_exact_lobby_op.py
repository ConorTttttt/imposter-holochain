#!/usr/bin/env python3
"""Prove native acceptance for *the exact HWC-authored* lobby action.

Uses the pinned unchanged HWC Rust-compatible Action/DhtOp hashing module,
bundled inside CI solely for diagnostics. The three op hashes derived from a
Create action must match HWC action hash AND native read-only admin timings.
"""
from pathlib import Path
import sys

p=Path(sys.argv[1])
s=p.read_text()
def patch(old,new):
    global s
    n=s.count(old)
    if n!=1:
        raise SystemExit(f"lobby-op anchor drift {n}: {old[:100]!r}")
    s=s.replace(old,new,1)

patch("  const lobbyActionHash=publicHoloHash(lobbyHashCandidate);",
r"""  const lobbyActionHash=publicHoloHash(lobbyHashCandidate);
  // Import only a test-only bundle of the exact pinned HWC hash source.
  // Do not change HWC's source files, signatures, database, or native WASM.
  const {pathToFileURL}=await import('node:url');
  const {hashAction,hashOp,ChainOpType}=await import(
    pathToFileURL(path.join(OUT_LOG,'hwc-op-hash-native.mjs')).href);
  const restoreHwcBytes=v=>{
    if(Array.isArray(v))return v.map(restoreHwcBytes);
    if(v instanceof Uint8Array)return v;
    if(v&&typeof v==='object'){
      const ks=Object.keys(v).sort((a,b)=>Number(a)-Number(b));
      if(ks.length===39&&ks.every((k,i)=>k===String(i) &&
        Number.isInteger(v[k])&&v[k]>=0&&v[k]<256))return Uint8Array.from(ks.map(k=>v[k]));
      if(ks.length&&ks.every((k,i)=>k===String(i) &&
        Number.isInteger(v[k])&&v[k]>=0&&v[k]<256))return Uint8Array.from(ks.map(k=>v[k]));
      return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restoreHwcBytes(x)]));
    }
    return v;
  };
  const lobbyAction=restoreHwcBytes(createdLobby?.signed_action?.hashed?.content);
  must(lobbyAction?.header&&lobbyAction?.data,
    'Actual create_lobby Record lacks signed action content required for exact op proof');
  const derivedActionHash=publicHoloHash(hashAction(lobbyAction));
  must(derivedActionHash===lobbyActionHash,
    'HWC pinned action hasher disagrees with signed real lobby Record hash');
  const opTypes=[ChainOpType.CreateRecord,ChainOpType.CreateEntry,ChainOpType.AgentActivity];
  evidence.lobby_action_native_op_candidates=opTypes.map(type=>({
    type,op_hash:publicHoloHash(hashOp(type,lobbyAction))}));
  must(evidence.lobby_action_native_op_candidates.length===3&&
    evidence.lobby_action_native_op_candidates.every(o=>/^uhCQk/.test(o.op_hash)),
    'HWC Rust-compatible type-tagged DhtOp hashing failed on real lobby');
  record('REAL_LOBBY_ACTION_TO_DHT_OP_HASHES','PASS',
    JSON.stringify({action:lobbyActionHash,derivedActionHash,
      ops:evidence.lobby_action_native_op_candidates}));"""
)
# This is injected after native Holochain official admin query in final-stage
# instrumentation, replacing only original unproven DB-check logic.
patch("""  record('NATIVE_INTEGRITY_FOR_LOBBY_ACTION',
      integratedLobby.length?'PASS':'BLOCKED',
      integratedLobby.length?
        'Exact lobby DhtOp validated locally and integrated by native conductor':
        'No exact native accepted+locally_validated+integrated lobby ChainOp row');""",
"""  // The admin-API audit has authority (native 0.7 in-process DB context)
    // even though the encrypted SQLite files cannot be opened externally.
    const exactCandidates=evidence.lobby_action_native_op_candidates||[];
    const fromNative=Object.entries(evidence.native_admin_op_timings||{})
      .map(([conductor,v])=>({
        conductor,ops:exactCandidates.map(op=>({
          ...op,
          status:v.observed_ops.find(x=>x.op_hash===op.op_hash)||null
        }))
      }));
    evidence.native_exact_lobby_op_integration=fromNative;
    const everyTypeOnBoth=fromNative.length===2&&fromNative.every(conductor=>
      conductor.ops.length===3&&conductor.ops.every(op=>
        op.status?.validation_status==='Accepted'&&
        op.status?.locally_validated===true&&
        op.status?.when_integrated!==null));
    evidence.native_valid_lobby_ops=fromNative.flatMap(c=>c.ops.filter(op=>
      op.status?.validation_status==='Accepted'&&
      op.status?.locally_validated===true&&op.status?.when_integrated!==null)
      .map(op=>({...op,conductor:c.conductor})));
    record('NATIVE_INTEGRITY_FOR_LOBBY_ACTION',
      everyTypeOnBoth?'PASS':'BLOCKED',
      everyTypeOnBoth?
        'All three HWC-authored lobby DhtOp types hash-match native Accepted+locally_validated+integrated on BOTH native conductors':
        'HWC-derived real lobby DhtOp hash(es) missing exact native Valid/Integrated per peer');"""
)
# Original exact guest GetReq/Res status uses native_valid_lobby_ops and
# already receives certified native validations from the new mapping.
p.write_text(s)
print('Injected actual real lobby signed-Action to native DhtOp hash proof:',p)
