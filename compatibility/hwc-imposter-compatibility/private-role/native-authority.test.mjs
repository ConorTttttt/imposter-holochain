import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstalledNativeAuthority} from './native-authority.mjs';
const h=(kind,n)=>{const prefix={dna:[0x84,0x2d,0x24],agent:[0x84,0x20,0x24],action:[0x84,0x29,0x24]}[kind],out=new Uint8Array(39);out.set(prefix);out.fill(n,3);return out;};
const dna=h('dna',1),a=h('agent',1),host=h('agent',1),b=h('agent',2),lobby=h('action',1),commit=h('action',2);
const game={schema_version:1,dna,network_seed:'native-g1-seed',
 host,lobby_action:lobby,lobby:{code:'native',player_count:2,impostor_count:1,task_target:4},
 role_commit_action:commit,merkle_root:new Uint8Array(32),
 seats:[{seat:0,agent:host,join_action:h('action',11),display_name:'host'},
        {seat:1,agent:b,join_action:h('action',12),display_name:'guest'}],
 phase:'playing',observed_only:true};
function setup({revoked=false,changed=false,disabled=false}={}){
 const calls=[],cell={contextId:'installed:game',dna,agent:a,enabled:!disabled};
 const service=createInstalledNativeAuthority({
  installedCell:async()=>cell,pinnedLobby:async()=>lobby,
  trustedFloor:async()=>({epoch:3,keyId:new Uint8Array(16),revoked}),
  zomeCall:async request=>{
   calls.push(request);
   if(request.fn==='get_authoritative_game_view'){
     if(!request.payload.expected_role_commit)return game;
     return changed?{...game,merkle_root:new Uint8Array(32).fill(1)}:game;
   }
   if(request.fn==='host_role_opening')return {role_commit:commit,
     recipient:b,seat:1,role:0,proof:{role_salt:new Uint8Array(16),path:[]}};
   if(request.fn==='lookup_recipient_key')return {status:'observed',current_unproven:true};
   return {action:h('action',14),attestation:request.payload};
  }
 });
 return {service,calls,cell};
}
test('native installed action pin and observed-to-exact-role-commit requery',async()=>{
 const f=setup(),v=await f.service.readCurrentGame(f.cell);
 assert.equal(v.schema_version,1);
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].fn,'get_authoritative_game_view');
 assert.equal(f.calls[0].payload.expected_role_commit,null);
 assert.deepEqual(f.calls[1].payload.expected_role_commit,commit);
 assert(f.calls.every(c=>c.contextId===f.cell.contextId&&c.zome==='game'&&
   c.provenance===f.cell.agent));
});
test('native changes between query and pinned requery fail closed',async()=>{
 const f=setup({changed:true});
 await assert.rejects(f.service.readCurrentGame(f.cell),/changed between/);
});
test('native role opening only for installed pinned lobby, exact recipient and action',async()=>{
 const f=setup(),r=await f.service.readHostRoleOpening(f.cell,
  {expected_lobby:lobby,expected_role_commit:commit,expected_recipient:b,expected_seat:1});
 assert.equal(r.seat,1);
 await assert.rejects(f.service.readHostRoleOpening(f.cell,
  {expected_lobby:h('action',77),expected_role_commit:commit,expected_recipient:b,expected_seat:1}),/not bound/);
});
test('native read uses protected epoch watermark, never default false freshness',async()=>{
 const f=setup();await f.service.readKeyEnrollment(f.cell,b);
 assert.equal(f.calls[0].payload.min_epoch,3);
 assert.deepEqual(f.calls[0].payload.min_key_id,new Uint8Array(16));
 const revoked=setup({revoked:true});
 await assert.rejects(revoked.service.readKeyEnrollment(revoked.cell,b),/revoked/);
 assert.equal(revoked.calls.length,0);
});
test('uninstalled, disabled or foreign context never accesses native executor',async()=>{
 const f=setup({disabled:true});
 await assert.rejects(f.service.readCurrentGame(f.cell),/disabled/);
 assert.equal(f.calls.length,0);
 const ok=setup();
 await assert.rejects(ok.service.readCurrentGame({...ok.cell,agent:b}),/changed/);
 assert.equal(ok.calls.length,0);
 await assert.rejects(ok.service.publishSignedRecipientKey('fake',{dna,agent:a}),/foreign/);
});
