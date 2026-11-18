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
  const nativeHashModule=await import(
    pathToFileURL(path.join(OUT_LOG,'hwc-op-hash-native.cjs')).href);
  const {hashAction,hashOp,ChainOpType,serializeAction}=nativeHashModule.default||nativeHashModule;
  // Record JSON transport loses the Uint8Array type for 39-byte HoloHashes.
  // Only the three schema-known Create fields are binary. Keep all unrelated
  // arrays, numeric fields and insertion order unchanged.
  const restoreHwcBytes=v=>{
    if(v instanceof Uint8Array)return v;
    if(Array.isArray(v))return v.map(restoreHwcBytes);
    if(v&&typeof v==='object')
      return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restoreHwcBytes(x)]));
    return v;
  };
  const schemaHoloHash=(v,field)=>{
    let raw=null;
    if(v instanceof Uint8Array)raw=Array.from(v);
    else if(Array.isArray(v))raw=v;
    else if(v&&typeof v==='object'){
      const keys=Object.keys(v);
      if(keys.length===39&&keys.every(k=>/^(0|[1-9][0-9]*)$/.test(k))&&
         keys.every((k)=>Number(k)<39))
        raw=Array.from({length:39},(_,i)=>v[i]);
    }
    must(Array.isArray(raw)&&raw.length===39&&raw.every(n=>
      Number.isInteger(n)&&n>=0&&n<=255),
      field+' must be exactly 39 unsigned bytes');
    return Uint8Array.from(raw);
  };
  const restoreSignedCreateAction=original=>{
    const action=restoreHwcBytes(original);
    must(action?.header&&action?.data?.type==='Create',
      'Signed lobby action must contain a Create header and data');
    action.header.author=schemaHoloHash(action.header.author,'header.author');
    action.header.prev_action=schemaHoloHash(action.header.prev_action,'header.prev_action');
    action.data.entry_hash=schemaHoloHash(action.data.entry_hash,'data.entry_hash');
    return action;
  };
  // Regression is run with the exact pinned HWC hashing code, using only a
  // public signed Create action captured from CI 44264567018 (no entry body).
  const fixture=JSON.parse(fs.readFileSync(path.join(ROOT,
    'agent3-kit/ci/agent3-h2hc-kit/fixtures/public_lobby_create_action_44264567018.json'),'utf8'));
  const fixtureHashArray=hex=>Array.from(Buffer.from(hex,'hex'));
  const fixtureOriginal={
    header:{
      author:fixtureHashArray(fixture.header_author_hex),
      timestamp:fixture.timestamp,action_seq:fixture.action_seq,
      prev_action:fixtureHashArray(fixture.header_prev_action_hex)
    },
    data:{
      type:'Create',entry_type:fixture.entry_type,
      entry_hash:fixtureHashArray(fixture.data_entry_hash_hex)
    }
  };
  const fixtureIncorrectBytes=serializeAction(fixtureOriginal);
  must(fixtureIncorrectBytes.length===330&&
    Buffer.from(fixtureIncorrectBytes).toString('hex')===fixture.invalid_arrays_msgpack_hex&&
    publicHoloHash(hashAction(fixtureOriginal))===fixture.invalid_arrays_hash,
    'Captured 330-byte old-array serialization/hash regression drift');
  const fixtureRestored=restoreSignedCreateAction(fixtureOriginal);
  const fixtureCorrectBytes=serializeAction(fixtureRestored);
  const fixtureCorrectHash=hashAction(fixtureRestored);
  must(fixtureCorrectBytes.length===271&&
    Buffer.from(fixtureCorrectBytes).toString('hex')===fixture.corrected_binary_msgpack_hex&&
    Buffer.from(fixtureCorrectHash).subarray(3,35).toString('hex')===
      fixture.corrected_blake2b_256&&
    publicHoloHash(fixtureCorrectHash)===fixture.corrected_hash,
    'Captured 271-byte schema-binary serialization/hash regression drift');
  must(fixtureRestored.header.timestamp===fixture.timestamp&&
    fixtureRestored.header.action_seq===fixture.action_seq&&
    JSON.stringify(fixtureRestored.data.entry_type)===JSON.stringify(fixture.entry_type),
    'Schema reconstruction unexpectedly changed non-hash action fields');
  record('PUBLIC_LOBBY_CANONICAL_RECONSTRUCTION_FIXTURE','PASS',
    '330-byte incorrect hash and 271-byte corrected hash match captured public Create action');
  const lobbyAction=restoreSignedCreateAction(
    createdLobby?.signed_action?.hashed?.content);
  must(lobbyAction?.header&&lobbyAction?.data,
    'Actual create_lobby Record lacks signed action content required for exact op proof');
  const derivedActionHash=publicHoloHash(hashAction(lobbyAction));
  // Capture the public Create action's canonical bytes BEFORE enforcing the
  // exact-hash assertion. This distinguishes Record reconstruction, canonical
  // serialization and hashing without exposing any entry/CapGrant content.
  const canonicalBytes=serializeAction(lobbyAction);
  const signedContent=createdLobby?.signed_action?.hashed?.content;
  const bytesShape=v=>v instanceof Uint8Array?'Uint8Array('+v.length+')':
    Array.isArray(v)?'Array('+v.length+')':
    v&&typeof v==='object'?'Object('+Object.keys(v).length+')':
    typeof v;
  const actionFields={
    header:Object.fromEntries(Object.entries(lobbyAction.header).map(([k,v])=>
      [k,k==='timestamp'||k==='action_seq'?v:bytesShape(v)])),
    data:Object.fromEntries(Object.entries(lobbyAction.data).map(([k,v])=>
      [k,k==='type'?v:bytesShape(v)])),
  };
  evidence.exact_hash_diagnostic={
    source:'returned signed_action.hashed.content (public Create action only)',
    expected_action_hash:lobbyActionHash,
    reconstructed_action_hash:derivedActionHash,
    equal:derivedActionHash===lobbyActionHash,
    canonical_msgpack_hex:Buffer.from(canonicalBytes).toString('hex'),
    canonical_msgpack_length:canonicalBytes.length,
    original_action_fields:{
      header:Object.fromEntries(Object.entries(signedContent?.header||{}).map(([k,v])=>[k,bytesShape(v)])),
      data:Object.fromEntries(Object.entries(signedContent?.data||{}).map(([k,v])=>[k,bytesShape(v)])),
    },
    reconstructed_fields:actionFields,
    signed_action_hash_shape:bytesShape(lobbyHashCandidate),
    signed_action_content_shape:bytesShape(signedContent),
    // Signature, entry bytes and any CapGrant body are intentionally omitted.
  };
  record('REAL_LOBBY_CANONICAL_HASH_DIAGNOSTIC',
    derivedActionHash===lobbyActionHash?'PASS':'MISMATCH',
    JSON.stringify({
      expected:lobbyActionHash,derived:derivedActionHash,
      msgpack_hex:evidence.exact_hash_diagnostic.canonical_msgpack_hex,
      fields:actionFields,
      original_fields:evidence.exact_hash_diagnostic.original_action_fields,
    }));
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
