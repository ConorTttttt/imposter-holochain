#!/usr/bin/env node
/* CI ONLY: modifies only the ephemeral runner's checked-out HWC worker.
 * This read-only probe is NOT a public HWC API and must never be deployed. */
import fs from 'node:fs';
import path from 'node:path';
if(process.env.CI!=='true'||process.env.BROWSER_POC_IDENTITY_SOURCE!=='EPHEMERAL_HWC_BROWSER_PROFILE')
 throw Error('Refusing to instrument any non-CI or non-ephemeral HWC build');
const file=path.resolve(process.argv[2]||'hwc','packages/extension/src/offscreen/ribosome-worker.ts');
let code=fs.readFileSync(file,'utf8');
const edits=[
  {
    "anchor": "import { callZome, type ZomeCallRequest } from '@hwc/core/ribosome';",
    "after": "import { callZome, type ZomeCallRequest } from '@hwc/core/ribosome';\nimport { buildRecords } from '@hwc/core/dht';"
  },
  {
    "anchor": "let sqlite3: any = null;",
    "after": "let sqlite3: any = null;\nlet ciStorageBackend='UNKNOWN';\nlet ciLairSignCount=0;"
  },
  {
    "anchor": "  log.info('Entry schema ready', migration.status, migration.entries);",
    "after": "  log.info('Entry schema ready', migration.status, migration.entries);\n  ciStorageBackend=usingOpfs?'OPFS_SAHPOOL':'MEMORY_FALLBACK';"
  },
  {
    "anchor": "const storage = new DirectSQLiteStorage();",
    "after": "const storage = new DirectSQLiteStorage();\n// The CI-only build reports READ-ONLY metadata directly to a loopback sink.\n// Entry contents, capability grant body and Lair secrets are never exported.\nasync function reportCi(dna: DnaHash, agent: AgentPubKey, fn: string): Promise<void> {\n try {\n  const acts=storage.queryActions(dna,agent);\n  const grants: any[]=acts.filter((a: any)=>a.actionType==='Create'&&a.entryType==='CapGrant');\n  const records=buildRecords(grants.map((a: any)=>({action:a,entry:storage.getEntry(a.entryHash)??undefined})));\n  const capHash: any = grants.length === 1 ? (grants[0] as any).entryHash : null;\n  let p0TwoRealCells: any = { ready: false };\n  if (capHash) {\n    const cell = btoa(String.fromCharCode(...dna)) + ':' +\n      btoa(String.fromCharCode(...agent));\n    const counts = (sql: string, params: any[]) => {\n      const q = db.prepare(sql);\n      try {\n        q.bind(params);\n        return q.step() ? Number(q.get({}).n) : -1;\n      } finally { q.finalize(); }\n    };\n    const total = counts('SELECT COUNT(*) AS n FROM entries WHERE entry_hash = ?', [toBytes(capHash)]);\n    const own = counts('SELECT COUNT(*) AS n FROM entries WHERE cell_id = ? AND entry_hash = ?',\n      [cell, toBytes(capHash)]);\n    const stranger = new Uint8Array(agent);\n    stranger[stranger.length - 1] ^= 0x7f;\n    storage.setCellContext(dna, stranger);\n    const denied = storage.getEntry(capHash) === null;\n    storage.setCellContext(dna, agent);\n    p0TwoRealCells = { ready: true, total, own, third_denied: denied,\n      capgrant_hash: encodeHashToBase64(capHash), source: 'real-Lair-genesis' };\n  }\n  const snap={\n    marker:'IMPOSTER_CI_PRIVATE_INSPECTOR',fn,\n    dna:encodeHashToBase64(dna),agent:encodeHashToBase64(agent),\n    backend:ciStorageBackend,storage_class:storage.constructor.name,\n    lair_signatures:ciLairSignCount,chrome_lair_signing:!!signSignalBuffer&&!!signResultBuffer,\n    capgrant_count:grants.length,capgrant_stored:grants.every((a:any)=>!!storage.getEntry(a.entryHash)),\n    capgrant_wire_hidden:records.length===grants.length&&records.every((r:any)=>\n      r.entry==='Hidden'||(r.entry&&typeof r.entry==='object'&&'Hidden' in r.entry)),\n    p0_two_real_cells:p0TwoRealCells,\n    links:acts.filter((a:any)=>a.actionType==='CreateLink').length,\n    actions:acts.map((a:any)=>({\n       seq:a.actionSeq,type:a.actionType,\n       hash:encodeHashToBase64(a.actionHash),prev:a.prevActionHash?encodeHashToBase64(a.prevActionHash):null,\n       signature_length:a.signature?.length??0,entry_type:a.entryType??null\n    }))\n  };\n  await fetch('http://127.0.0.1:8765/__ci_source_chain',{method:'POST',\n    headers:{'Content-Type':'text/plain'},body:JSON.stringify(snap)});\n }catch(e){console.warn('[CI-only source chain probe]',(e as Error).message.slice(0,160));}\n}"
  },
  {
    "anchor": "    const signature = new Uint8Array(signResultBuffer!, 5, 64);",
    "after": "    const signature = new Uint8Array(signResultBuffer!, 5, 64);\n    ciLairSignCount++;"
  },
  {
    "anchor": "  const zomeResult = await callZome(request);",
    "after": "  let zomeResult;\n  try { zomeResult=await callZome(request); }\n  finally { void reportCi(cellIdBytes[0],cellIdBytes[1],fn); }"
  }
];
for(const edit of edits){
 const n=code.split(edit.anchor).length-1;
 if(n!==1)throw Error('HWC source drift at '+edit.anchor.slice(0,70)+'; matches='+n);
 code=code.replace(edit.anchor,edit.after);
}
fs.writeFileSync(file,code);
console.log('IMPOSTER_HWC_CI_READ_ONLY_WORKER_INSTRUMENT_APPLIED');
