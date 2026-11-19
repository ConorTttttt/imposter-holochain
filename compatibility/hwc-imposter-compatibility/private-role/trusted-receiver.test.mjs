import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecipientKey,rawPublicKey} from './hpke.mjs';
import {attestKey} from './wire.mjs';
import {attestInstalledCell} from './installed-cell.mjs';
import {createRestrictedRoleService} from './trusted-receiver.mjs';
import {encodeRoleOpening,verifyRoleOpening} from './merkle.mjs';
import {publishInstalledRecipientKey} from './installed-native-enrollment.mjs';
import {requireCurrentRoleState} from './native-state.mjs';
const utf8=s=>new TextEncoder().encode(s);
const cat=(...a)=>{const o=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let k=0;for(const x of a){o.set(x,k);k+=x.length;}return o;};
const sha=async b=>new Uint8Array(await crypto.subtle.digest('SHA-256',b));
const dna=n=>new Uint8Array([0x84,0x2d,0x24,...Array(36).fill(n)]);
const hash=n=>new Uint8Array([0x84,0x29,0x24,...Array(36).fill(n)]);
async function identity(){
 const k=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const pub=new Uint8Array(await crypto.subtle.exportKey('raw',k.publicKey));
 return {agent:new Uint8Array([0x84,0x20,0x24,...pub,0,0,0,0]),
   lair:{signByPubKey:async(publicCore,data)=>{
     // Test Lair-like signer can be pointed at the WRONG installed identity;
     // production verifier must reject the foreign signature regardless.
     return new Uint8Array(await crypto.subtle.sign('Ed25519',k.privateKey,data));
   }}};
}
async function roleProof(seat=1,role=1,saltByte=8){
 const salt=new Uint8Array(16).fill(saltByte);
 const leaf=await sha(cat(new Uint8Array([0]),utf8('imposter:role:v1'),
   new Uint8Array([seat>>8,seat&255,role]),salt));
 const pad=await sha(cat(new Uint8Array([0]),utf8('imposter:pad:v1')));
 let layer=Array.from({length:64},(_,i)=>i===seat?leaf:pad),index=seat,path=[];
 for(let depth=0;depth<6;depth++){
   path.push(layer[index^1]);let next=[];
   for(let j=0;j<layer.length;j+=2)next.push(await sha(cat(new Uint8Array([1]),layer[j],layer[j+1])));
   layer=next;index>>=1;
 }
 return {salt,path,root:layer[0],payload:encodeRoleOpening(role,salt,path)};
}
class Keys{
 constructor(){this.cells=new Map();this.trusted=new Map();this.replays=new Set();}
 key(d,a){return Buffer.from(d).toString('hex')+':'+Buffer.from(a).toString('hex');}
 async rotateCell(dna,agent,epoch){const pair=await createRecipientKey();const cell={dna,agent,epoch,keyId:crypto.getRandomValues(new Uint8Array(16)),privateKey:pair.privateKey,publicKey:await rawPublicKey(pair.publicKey)};this.cells.set(this.key(dna,agent),cell);return cell;}
 async getCell(dna,agent){return this.cells.get(this.key(dna,agent))??null;}
 async installCellAttestation(dna,agent,attestation){this.cells.set(this.key(dna,agent),{...await this.getCell(dna,agent),attestation});}
 async pinTrustedRecipient(dna,agent,attestation){const k=this.key(dna,agent),old=this.trusted.get(k);if(old&&old.epoch>attestation.epoch)throw Error('rollback');this.trusted.set(k,attestation);}
 async getTrustedRecipient(dna,agent){const a=this.trusted.get(this.key(dna,agent));if(!a)throw Error('not trusted');return a;}
 async reserve({dna,recipient,sender,messageId}){const k=this.key(dna,recipient)+':'+Buffer.from(sender).toString('hex')+':'+Buffer.from(messageId).toString('hex');if(this.replays.has(k))throw Error('replay');this.replays.add(k);}
}
function session(dna,agent,origin){
 let live=true,epoch=1;const sent=[];
 return {sent, isAuthenticated:()=>live,isRegistered:(d,a)=>Buffer.compare(d,dna)===0&&Buffer.compare(a,agent)===0,
   leaseId:()=>live?origin+':'+epoch:null,
   sendRoleFrame:async msg=>{sent.push(JSON.stringify(msg));},
   revoke:()=>{live=false;epoch++;}, reconnect:()=>{live=true;epoch++;}};
}
async function fixture(){
 const d=dna(1),ids=await Promise.all([identity(),identity(),identity()]);
 ids.sort((x,y)=>Buffer.compare(x.agent,y.agent));
 const [host,b,c]=ids,proof=await roleProof();
 const storeB=new Keys(),storeHost=new Keys(),stored=await storeB.rotateCell(d,b.agent,1);
 const hostCell=await storeHost.rotateCell(d,host.agent,1);
 const now=Date.now(),att=await attestKey({dna:d,agent:b.agent,epoch:stored.epoch,
   keyId:stored.keyId,publicKey:stored.publicKey,sign:b.lair.signByPubKey,now});
 await storeB.installCellAttestation(d,b.agent,att);
 const hostAtt=await attestKey({dna:d,agent:host.agent,epoch:hostCell.epoch,
   keyId:hostCell.keyId,publicKey:hostCell.publicKey,sign:host.lair.signByPubKey,now});
 await storeHost.installCellAttestation(d,host.agent,hostAtt);
 const game={schema_version:1,dna:d,network_seed:'test-native-seed',
   observed_only:true,phase:'playing',host:host.agent,
   lobby_action:hash(1),
   lobby:{code:'TESTROOM',player_count:3,impostor_count:1,task_target:4},
   role_commit_action:hash(2),merkle_root:proof.root,
   seats:[host.agent,b.agent,c.agent].map((agent,seat)=>({
     seat,agent,join_action:hash(3+seat),display_name:'seat'+seat
   }))};
 const observed=(a)=>({status:'observed',current_unproven:true,
   view:{action:hash(11),attestation:{
     dna:a.dna,agent:a.agent,key_id:a.keyId,x25519_public_key:a.publicKey,
     epoch:a.epoch,not_before_ms:a.notBefore,not_after_ms:a.notAfter,signature:a.signature
   }}});
 const enrollment=observed(att);
 const hostEnrollment=observed(hostAtt);
 const native={readCurrentGame:async()=>game,readKeyEnrollment:async(_,recipient)=>
   Buffer.compare(recipient,host.agent)===0?hostEnrollment:enrollment,
   readHostRoleOpening:async(_cell,request)=>{
     assert.deepEqual(request.expected_lobby,game.lobby_action);
     assert.deepEqual(request.expected_role_commit,game.role_commit_action);
     assert.deepEqual(request.expected_recipient,b.agent);
     assert.equal(request.expected_seat,1);
     return {role_commit:game.role_commit_action,recipient:b.agent,seat:1,
       role:1,proof:{role_salt:proof.salt,path:proof.path}};
   }};
 const a=agent=>({dna:d,agent,contextId:'installed-happ'});
 const hostSession=session(d,host.agent,'host'),bSession=session(d,b.agent,'guest-b');
 const hostSvc=createRestrictedRoleService({installedCell:async()=>a(host.agent),
   native,lair:host.lair,session:hostSession,store:storeHost});
 const guestSvc=createRestrictedRoleService({installedCell:async()=>a(b.agent),
   native,lair:b.lair,session:bSession,store:storeB});
 return {d,host,b,c,proof,att,stored,game,enrollment,hostEnrollment,
   hostSession,bSession,hostSvc,guestSvc,storeB,storeHost};
}
test('Merkle verifier matches native leaf/node domains and denies wrong seat, role, root, salt',async()=>{
 const p=await roleProof();assert.equal(await verifyRoleOpening({payload:p.payload,seat:1,root:p.root}),1);
 await assert.rejects(verifyRoleOpening({payload:p.payload,seat:2,root:p.root}),/Merkle/);
 await assert.rejects(verifyRoleOpening({payload:p.payload,seat:1,root:new Uint8Array(32)}),/Merkle/);
 const mutated=p.payload.slice();mutated[1]^=1;
 await assert.rejects(verifyRoleOpening({payload:mutated,seat:1,root:p.root}),/Merkle/);
 await assert.rejects(verifyRoleOpening({payload:new Uint8Array([1]),seat:1,root:p.root}),/payload/);
});
test('installed-cell signer uses enabled context, exact DNA, Lair signer and held X25519 secret',async()=>{
 const d=dna(5),id=await identity(),store=new Keys();
 const manager={listContexts:async()=>[{id:'real-happ',enabled:true,agentPubKey:id.agent,dnas:[{hash:d}]}]};
 const att=await attestInstalledCell({dna:d,contextId:'real-happ',contextManager:manager,lair:id.lair,store});
 assert.deepEqual(att.agent,id.agent);assert.deepEqual(att.dna,d);
 assert.equal((await store.getCell(d,id.agent)).privateKey.extractable,false);
 await assert.rejects(attestInstalledCell({dna:dna(6),contextId:'real-happ',contextManager:manager,lair:id.lair,store}),/installed/);
 await assert.rejects(attestInstalledCell({dna:d,contextId:'wrong',contextManager:manager,lair:id.lair,store}),/installed/);
 const foreign=await identity();
 await assert.rejects(attestInstalledCell({dna:d,contextId:'real-happ',contextManager:manager,lair:foreign.lair,store}),/signer identity/);
});
test('independent host/guest signed role: B extension receives correct opening only once, never invokes coordinator',async()=>{
 const f=await fixture();
 await assert.rejects(f.hostSvc.sendRole({seat:1}),/fresh signed recipient request/);
 assert.deepEqual(await f.guestSvc.requestRole({seat:1}),{requestSent:true,roleAvailable:false});
 assert.deepEqual(await f.hostSvc.receiveFromSocket(f.bSession.sent[0]),{validatedRecipientRequest:true,coordinatorInvoked:false});
 assert.deepEqual(await f.hostSvc.sendRole({seat:1}),{queuedOnly:true});
 assert.equal(f.hostSession.sent.length,1);
 const out=await f.guestSvc.receiveFromSocket(f.hostSession.sent[0]);
 assert.equal(out.role,1);assert.equal(out.seat,1);assert.equal(out.coordinatorInvoked,false);
 await assert.rejects(f.guestSvc.receiveFromSocket(f.hostSession.sent[0]),/replay|uncorrelated/);
 const cSvc=createRestrictedRoleService({installedCell:async()=>({dna:f.d,agent:f.c.agent,contextId:'installed-happ'}),
   native:{readCurrentGame:async()=>f.game,readKeyEnrollment:async()=>f.enrollment,
     readHostRoleOpening:async()=>{throw Error('not host');}},
   lair:f.c.lair,session:session(f.d,f.c.agent,'guest-c'),store:new Keys()});
 await assert.rejects(cSvc.receiveFromSocket(f.hostSession.sent[0]),/recipient|seat/);
});
test('native wrong round/host/seat and revoked session deny before plaintext disclosure',async()=>{
 const f=await fixture();
 await f.guestSvc.requestRole({seat:1});
 await f.hostSvc.receiveFromSocket(f.bSession.sent[0]);
 await f.hostSvc.sendRole({seat:1});
 const frame=f.hostSession.sent[0];
 f.game.phase='ended';
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/committed phase/);
 f.game.phase='playing';
 f.game.lobby_action=hash(41);
 f.game.role_commit_action=hash(42);
 f.game.merkle_root=(await roleProof(1,1,9)).root;
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/RoleCommit/);
 await assert.rejects(verifyRoleOpening({payload:f.proof.payload,seat:1,root:f.game.merkle_root}),/Merkle/);
 f.game.lobby_action=hash(1);
 f.game.role_commit_action=hash(2);
 f.game.merkle_root=f.proof.root;
 f.game.seats[1].agent=f.c.agent;
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/noncanonical|seat/);
 f.game.seats[1].agent=f.b.agent;f.bSession.revoke();
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/live registered/);
});
test('a lost request can be retried after expiry without accepting its stale reply',async(t)=>{
 const f=await fixture();
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 await f.guestSvc.requestRole({seat:1});
 await assert.rejects(f.guestSvc.requestRole({seat:1}),/outstanding signed/);
 await f.hostSvc.receiveFromSocket(f.bSession.sent[0]);
 t.mock.timers.tick(10000);
 await f.hostSvc.sendRole({seat:1});
 // The first reply is still within its own lifetime when the request expires.
 t.mock.timers.tick(20000);
 await f.guestSvc.requestRole({seat:1});
 await assert.rejects(f.guestSvc.receiveFromSocket(f.hostSession.sent[0]),/uncorrelated/);
 await f.hostSvc.receiveFromSocket(f.bSession.sent[1]);
 await f.hostSvc.sendRole({seat:1});
 assert.equal((await f.guestSvc.receiveFromSocket(f.hostSession.sent[1])).seat,1);
});
test('signed message has no forged browser bool or generic remote API; absent native adapter rejects',async()=>{
 const f=await fixture();
 await assert.rejects(f.guestSvc.receiveFromSocket(JSON.stringify({verifiedRemoteCaller:true,nativeValidated:true})),/role frame/);
 assert.equal(Object.hasOwn(f.guestSvc,'call_remote'),false);
 assert.equal(Object.hasOwn(f.guestSvc,'send_remote_signal'),false);
 assert.throws(()=>createRestrictedRoleService({...f,native:null}),/native HWC authority/);
});
test('host fails closed on missing native recipient enrollment and unregistered session',async()=>{
 const f=await fixture();f.enrollment.view.attestation.agent=f.c.agent;
 await f.guestSvc.requestRole({seat:1});
 await assert.rejects(f.hostSvc.receiveFromSocket(f.bSession.sent[0]),/native recipient DNA or author/);
 f.enrollment.view.attestation.agent=f.b.agent;f.hostSession.revoke();
 await assert.rejects(f.hostSvc.sendRole({seat:1}),/live registered/);
});

test('installed cell publishes real-signed public attestation via native zome and rechecks native Valid DHT action',async()=>{
 const d=dna(28),id=await identity(),store=new Keys(),contextId='real-happ';
 const manager={listContexts:async()=>[{id:contextId,enabled:true,agentPubKey:id.agent,dnas:[{hash:d}]}]};
 let published=null;
 const native={
   publishSignedRecipientKey:async(ctx,entry)=>{
     assert.equal(ctx,contextId);published=entry;
     // Native serde over the HWC executor returns arrays, not necessarily
     // Uint8Array objects. Must match the locally held Lair signature.
     return {action:Array.from(hash(29)),attestation:Object.fromEntries(
       Object.entries(entry).map(([k,v])=>[k,v instanceof Uint8Array?Array.from(v):v]))};
   },
   lookupRecipientKey:async(ctx,options)=>{
     assert.equal(ctx,contextId);assert.deepEqual(options.recipient,id.agent);
     return {status:'observed',current_unproven:true,
       view:{action:Array.from(hash(29)),attestation:Object.fromEntries(
         Object.entries(published).map(([k,v])=>[k,v instanceof Uint8Array?Array.from(v):v]))}};
   }
 };
 const registered=await publishInstalledRecipientKey({contextId,dna:d,contextManager:manager,
   lair:id.lair,store,native});
 assert.equal(registered.epoch,1);
 assert.equal(registered.observedCurrentUnproven,true);
 assert.equal((await store.getCell(d,id.agent)).privateKey.extractable,false);
 assert.equal(Object.hasOwn(published,'privateKey'),false);
 const malicious={...native,lookupRecipientKey:async()=>({
   status:'observed',current_unproven:true,
   view:{action:hash(29),attestation:{...published,agent:(await identity()).agent}}
 })};
 await assert.rejects(publishInstalledRecipientKey({contextId,dna:d,contextManager:manager,
   lair:id.lair,store,native:malicious}),/native recipient DNA or author mismatch/);
 await assert.rejects(publishInstalledRecipientKey({contextId,dna:d,contextManager:manager,
   lair:id.lair,store,native:{publishSignedRecipientKey:async()=>({action:hash(29)})}}),/zome unavailable/);
});

test('real Agent4 v1 native view rejects wrong schema, DNA, seat, root and phase without invented rounds',async()=>{
 const f=await fixture(),cell={dna:f.d,agent:f.b.agent};
 assert.equal(requireCurrentRoleState(f.game,cell).commit.seats.length,3);
 const wrong=fn=>{const copy=structuredClone(f.game);fn(copy);return copy;};
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.schema_version=2),cell),/committed phase/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.observed_only=false),cell),/committed phase/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.dna=dna(44)),cell),/committed phase/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.merkle_root=new Uint8Array(16)),cell),/Merkle/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.seats.reverse()),cell),/noncanonical/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.phase='lobby'),cell),/committed phase/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.seats[0].join_action=x.seats[1].join_action),cell),/noncanonical/);
 assert.throws(()=>requireCurrentRoleState(wrong(x=>x.lobby.player_count=4),cell),/configuration/);
});
test('host role uses only privileged native private opening, never caller-supplied role bytes',async()=>{
 const f=await fixture();
 await f.guestSvc.requestRole({seat:1});
 await f.hostSvc.receiveFromSocket(f.bSession.sent[0]);
 // Adversarial caller supplies false role+proof: these fields are ignored.
 assert.deepEqual(await f.hostSvc.sendRole({seat:1,role:0,roleSalt:new Uint8Array(16)}),{queuedOnly:true});
 const accepted=await f.guestSvc.receiveFromSocket(f.hostSession.sent[0]);
 assert.equal(accepted.role,1);
});
test('native enrollment publication must match independently looked-up action and original exact attestation',async()=>{
 const d=dna(27),id=await identity(),store=new Keys();
 const cm={listContexts:async()=>[{id:'ctx',enabled:true,agentPubKey:id.agent,dnas:[{hash:d}]}]};
 let publish=null;
 const fake={
  publishSignedRecipientKey:async(_ctx,att)=>{publish=att;return {action:hash(25),attestation:att};},
  lookupRecipientKey:async()=>({status:'observed',current_unproven:true,
   view:{action:hash(26),attestation:publish}})
 };
 await assert.rejects(publishInstalledRecipientKey({contextId:'ctx',dna:d,contextManager:cm,lair:id.lair,store,native:fake}),/native indexed entry differs|native enrollment differs|native published action|/);
});
