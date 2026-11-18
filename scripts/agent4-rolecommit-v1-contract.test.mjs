/** Pinned Agent 4 native RoleCommit v1 ↔ Agent 2 receiver contract fixture.
 * This is NOT an installed HWC execution or global DHT finality test. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=process.env.AGENT2_ROLE_V1_DIR;
if(!dir) throw Error('exact pinned Agent 2 adapter directory required');
const load=async f=>import(pathToFileURL(resolve(dir,f)).href);
const {requireCurrentRoleState}=await load('native-state.mjs');
const {createInstalledNativeAuthority}=await load('native-authority.mjs');
const {encodeRoleOpening,verifyRoleOpening}=await load('merkle.mjs');
const coordinator=readFileSync('dnas/game/zomes/coordinator/game/src/lib.rs','utf8');
const integrity=readFileSync('dnas/game/zomes/integrity/game_integrity/src/lib.rs','utf8');
const merkle=readFileSync('crates/imposter-core/src/merkle.rs','utf8');
const raw=(kind,n)=>[...({dna:[0x84,0x2d,0x24],agent:[0x84,0x20,0x24],action:[0x84,0x29,0x24]}[kind]),...Array(36).fill(n)];
const u8=x=>Uint8Array.from(x),same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
function fields(src,name){
 const r=new RegExp('pub struct '+name+' \\{([\\s\\S]*?)\\n\\}');
 const match=src.match(r);assert(match,'missing native Rust struct '+name);
 return Array.from(match[1].matchAll(/^\s*pub\s+(\w+)\s*:\s*([^,\n]+),/gm),m=>[m[1],m[2].trim()]);
}
const expect={
 NativeGameViewQuery:[['expected_lobby','ActionHash'],['expected_role_commit','Option<ActionHash>'],['expected_recipient','Option<AgentPubKey>'],['expected_seat','Option<u16>']],
 NativeSeatEvidence:[['seat','u16'],['agent','AgentPubKey'],['join_action','ActionHash'],['display_name','String']],
 NativeGameViewV1:[['schema_version','u8'],['dna','DnaHash'],['network_seed','String'],['host','AgentPubKey'],['lobby_action','ActionHash'],['lobby','Lobby'],['role_commit_action','Option<ActionHash>'],['merkle_root','Option<[u8; 32]>'],['seats','Vec<NativeSeatEvidence>'],['phase','Phase'],['observed_only','bool']],
 HostRoleOpeningQuery:[['expected_lobby','ActionHash'],['expected_role_commit','ActionHash'],['expected_recipient','AgentPubKey'],['expected_seat','u16']],
 HostRoleOpening:[['role_commit','ActionHash'],['recipient','AgentPubKey'],['seat','u16'],['role','u8'],['proof','RoleProof']]
};
const dna=raw('dna',7),host=raw('agent',4),guest=raw('agent',2),third=raw('agent',9);
const lobby=raw('action',10),commit=raw('action',11),joins=[raw('action',32),raw('action',30),raw('action',31)];
const sha=async b=>new Uint8Array(await crypto.subtle.digest('SHA-256',b));
const cat=(...v)=>Buffer.concat(v.map(x=>Buffer.from(x)));
async function proof(seat=0,role=1){
 const role_salt=Array(16).fill(8),path=Array.from({length:6},(_,i)=>Array(32).fill(i+4));
 let node=await sha(cat([0],new TextEncoder().encode('imposter:role:v1'),[seat>>8,seat&255,role],role_salt));
 for(let i=0;i<6;i++)node=await sha(seat&(1<<i)?cat([1],path[i],node):cat([1],node,path[i]));
 return {role,proof:{role_salt,path},root:Array.from(node)};
}
async function view(){
 const p=await proof();return {schema_version:1,dna,network_seed:'g1.host.fixture',host,
  lobby_action:lobby,lobby:{code:'ROOM',player_count:3,impostor_count:1,task_target:4},
  role_commit_action:commit,merkle_root:p.root,
  seats:[guest,host,third].map((agent,seat)=>({seat,agent,join_action:joins[seat],display_name:'seat-'+seat})),
  phase:'playing',observed_only:true};
}
test('native Rust schema names, exact types and no synthetic round',()=>{
 for(const [name,expected] of Object.entries(expect))assert.deepEqual(fields(coordinator,name),expected,name);
 assert.deepEqual(fields(integrity,'Lobby'),[['code','String'],['player_count','u16'],['impostor_count','u16'],['task_target','u32']]);
 assert.deepEqual(fields(integrity,'PlayerJoin'),[['lobby','ActionHash'],['player','AgentPubKey'],['display_name','String']]);
 assert.deepEqual(fields(integrity,'RoleCommit'),[['lobby','ActionHash'],['merkle_root','[u8; 32]'],['player_count','u16'],['impostor_count','u16'],['seats','Vec<AgentPubKey>'],['joins','Vec<ActionHash>']]);
 assert.deepEqual(fields(merkle,'RoleProof'),[['role_salt','[u8; 16]'],['path','Vec<Hash>']]);
});
test('Agent 2 native-state accepts exact native view and rejects stale phase / malformed hash / wrong sorted seat',async()=>{
 const g=await view(),cell={dna:u8(dna),agent:u8(guest)};
 const result=requireCurrentRoleState(g,cell);
 assert(same(result.lobby.action,lobby)&&same(result.lobby.host,host));
 assert(same(result.commit.action,commit)&&same(result.commit.joins[0],joins[0]));
 assert(same(result.commit.seats[0],guest)&&same(result.commit.seats[1],host));
 assert(!('round' in g)&&!('round' in g.lobby)&&!('currentRound' in g));
 for(const phase of ['lobby','ended'])assert.throws(()=>requireCurrentRoleState({...g,phase},cell),/committed phase/);
 assert.equal(requireCurrentRoleState({...g,phase:'meeting'},cell).commit.seats.length,3);
 assert.throws(()=>requireCurrentRoleState({...g,seats:[g.seats[1],g.seats[0],g.seats[2]]},cell),/noncanonical/);
 assert.throws(()=>requireCurrentRoleState({...g,lobby_action:raw('agent',1)},cell),/action hash/);
 assert.throws(()=>requireCurrentRoleState({...g,merkle_root:Array(16).fill(0)},cell),/Merkle/);
});
test('Agent 2 native-authority uses installed cell, discovery then exact action and one host-private opening',async()=>{
 const g=await view(),p=await proof(),cell={contextId:'installed:v1',dna:u8(dna),agent:u8(host),enabled:true};
 const calls=[],native=createInstalledNativeAuthority({
  installedCell:async()=>cell,pinnedLobby:async()=>u8(lobby),trustedFloor:async()=>null,
  zomeCall:async c=>{calls.push(c);if(c.fn==='get_authoritative_game_view')return g;
   if(c.fn==='host_role_opening')return {role_commit:commit,recipient:guest,seat:0,role:p.role,proof:p.proof};
   throw Error('unexpected privileged native invocation');}
 });
 assert.equal((await native.readCurrentGame(cell)).schema_version,1);
 assert.deepEqual(calls.map(c=>c.fn),['get_authoritative_game_view','get_authoritative_game_view']);
 assert.equal(calls[0].payload.expected_role_commit,null);
 assert(same(calls[1].payload.expected_role_commit,commit));
 assert(calls.every(c=>c.zome==='game'&&c.contextId===cell.contextId&&same(c.provenance,cell.agent)));
 const opening=await native.readHostRoleOpening(cell,{expected_lobby:u8(lobby),expected_role_commit:u8(commit),expected_recipient:u8(guest),expected_seat:0});
 assert.equal(calls[2].fn,'host_role_opening');
 assert.equal(opening.proof.role_salt.length,16);
 assert.equal(opening.proof.path.length,6);
 // Native serde's number[] must become strictly typed bytes before encoding;
 // this test adapts the fixture. Production conversion remains Agent 2's gate.
 const salt=u8(opening.proof.role_salt),path=opening.proof.path.map(u8);
 assert(path.every(x=>x.length===32));
 const payload=encodeRoleOpening(opening.role,salt,path);
 assert.equal(payload.length,209);
 assert.equal(await verifyRoleOpening({payload,seat:0,root:u8(g.merkle_root)}),1);
 await assert.rejects(verifyRoleOpening({payload,seat:1,root:u8(g.merkle_root)}),/Merkle/);
});
