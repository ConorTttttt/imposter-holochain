import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecipientKey,rawPublicKey} from './hpke.mjs';
import {attestKey} from './wire.mjs';
import {attestInstalledCell} from './installed-cell.mjs';
import {createRestrictedRoleService} from './trusted-receiver.mjs';
import {encodeRoleOpening,verifyRoleOpening} from './merkle.mjs';
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
async function roleProof(seat=1,role=1){
 const salt=new Uint8Array(16).fill(8);
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
 const d=dna(1),host=await identity(),b=await identity(),c=await identity(),proof=await roleProof();
 const storeB=new Keys(),stored=await storeB.rotateCell(d,b.agent,1);
 const now=Date.now(),att=await attestKey({dna:d,agent:b.agent,epoch:stored.epoch,
   keyId:stored.keyId,publicKey:stored.publicKey,sign:b.lair.signByPubKey,now});
 await storeB.installCellAttestation(d,b.agent,att);
 const game={dna:d,currentRound:3,active:true,
   lobby:{action:hash(1),author:host.agent,host:host.agent,round:3},
   commit:{action:hash(2),author:host.agent,lobby:hash(1),round:3,
     seats:[host.agent,b.agent,c.agent],merkleRoot:proof.root}};
 const enrollment={dna:d,author:b.agent,attestation:att};
 const a=agent=>({dna:d,agent,contextId:'installed-happ'});
 const hostSession=session(d,host.agent,'host'),bSession=session(d,b.agent,'guest-b');
 const hostSvc=createRestrictedRoleService({installedCell:async()=>a(host.agent),
   native:{readCurrentGame:async()=>game,readKeyEnrollment:async()=>enrollment},
   lair:host.lair,session:hostSession,store:new Keys()});
 const guestSvc=createRestrictedRoleService({installedCell:async()=>a(b.agent),
   native:{readCurrentGame:async()=>game,readKeyEnrollment:async()=>enrollment},
   lair:b.lair,session:bSession,store:storeB});
 return {d,host,b,c,proof,att,stored,game,enrollment,hostSession,bSession,hostSvc,guestSvc,storeB};
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
 assert.deepEqual(await f.hostSvc.sendRole({seat:1,role:1,roleSalt:f.proof.salt,path:f.proof.path}),{queuedOnly:true});
 assert.equal(f.hostSession.sent.length,1);
 const out=await f.guestSvc.receiveFromSocket(f.hostSession.sent[0]);
 assert.equal(out.role,1);assert.equal(out.seat,1);assert.equal(out.coordinatorInvoked,false);
 await assert.rejects(f.guestSvc.receiveFromSocket(f.hostSession.sent[0]),/replay/);
 const cSvc=createRestrictedRoleService({installedCell:async()=>({dna:f.d,agent:f.c.agent,contextId:'installed-happ'}),
   native:{readCurrentGame:async()=>f.game,readKeyEnrollment:async()=>f.enrollment},
   lair:f.c.lair,session:session(f.d,f.c.agent,'guest-c'),store:new Keys()});
 await assert.rejects(cSvc.receiveFromSocket(f.hostSession.sent[0]),/seat/);
});
test('native wrong round/host/seat and revoked session deny before plaintext disclosure',async()=>{
 const f=await fixture();
 await f.hostSvc.sendRole({seat:1,role:1,roleSalt:f.proof.salt,path:f.proof.path});
 const frame=f.hostSession.sent[0];
 f.game.currentRound=4;
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/current host-authored/);
 f.game.currentRound=3;f.game.commit.author=f.c.agent;
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/current host-authored/);
 f.game.commit.author=f.host.agent;f.game.commit.seats[1]=f.c.agent;
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/seat/);
 f.game.commit.seats[1]=f.b.agent;f.bSession.revoke();
 await assert.rejects(f.guestSvc.receiveFromSocket(frame),/live registered/);
});
test('signed message has no forged browser bool or generic remote API; absent native adapter rejects',async()=>{
 const f=await fixture();
 await assert.rejects(f.guestSvc.receiveFromSocket(JSON.stringify({verifiedRemoteCaller:true,nativeValidated:true})),/role frame/);
 assert.equal(Object.hasOwn(f.guestSvc,'call_remote'),false);
 assert.equal(Object.hasOwn(f.guestSvc,'send_remote_signal'),false);
 assert.throws(()=>createRestrictedRoleService({...f,native:null}),/native HWC authority/);
});
test('host fails closed on missing native recipient enrollment and unregistered session',async()=>{
 const f=await fixture();f.enrollment.author=f.c.agent;
 await assert.rejects(f.hostSvc.sendRole({seat:1,role:1,roleSalt:f.proof.salt,path:f.proof.path}),/native-enrolled/);
 f.enrollment.author=f.b.agent;f.hostSession.revoke();
 await assert.rejects(f.hostSvc.sendRole({seat:1,role:1,roleSalt:f.proof.salt,path:f.proof.path}),/live registered/);
});
