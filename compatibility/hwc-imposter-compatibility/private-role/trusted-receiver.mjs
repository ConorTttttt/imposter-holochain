/** Restricted extension-internal receiver / sender. NEVER expose methods to
 * window, content scripts or chrome.runtime messages. The upstream HWC
 * remote-signal and remote-zome-call ban remains in force.
 *
 * Security preconditions:
 * - installedCell(): actual enabled HWC installed context, Lair agent
 * - session: extension's authenticated role-only H2HC WebSocket with an
 *   incarnation/lease ID that changes on disconnect, reauth and revocation
 * - native: extension-owned adapter that independently reads *native-validated*
 *   current Lobby, RoleCommit and recipient key enrollment. NOT webpage values
 * - store: extension-owned IndexedDB, no public store mutation bridge
 * No adapter exists in the accepted HWC patch yet: fail closed, do NOT silently
 * promote this pure module to an accepted installed-cell runtime.
 */
import {verifyKeyAttestation,makeRoleRequest,makeRoleDelivery,receiveRoleDelivery,
  parseRoleFrame,toRoleFrame,internalsForTests,HPKE_INFO} from './wire.mjs';
import {openForCell} from './hpke.mjs';
import {encodeAttestationBody,decodeAttestationBody} from './request-attestation.mjs';
import {validateObservedEnrollment} from './native-enrollment.mjs';
import {verifyRoleOpening,encodeRoleOpening} from './merkle.mjs';
import {requireCurrentRoleState} from './native-state.mjs';
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const full=(a,p)=>a instanceof Uint8Array&&a.length===39&&p.every((v,i)=>v===a[i]);
const D=[0x84,0x2d,0x24],A=[0x84,0x20,0x24],H=[0x84,0x29,0x24];
function cellOf(c){
 if(!full(c?.dna,D)||!full(c?.agent,A)||typeof c?.contextId!=='string'||!c.contextId)
   throw Error('no genuine installed cell');
 return c;
}
function sessionLease(session,cell){
 if(typeof session?.leaseId!=='function'||typeof session?.isRegistered!=='function'||
   typeof session?.isAuthenticated!=='function'||session.isAuthenticated()!==true||
   session.isRegistered(cell.dna,cell.agent)!==true)throw Error('no live registered role transport');
 const lease=session.leaseId();
 if(typeof lease!=='string'||!lease)throw Error('missing signed transport lease');
 return lease;
}
function unchanged(session,cell,lease){
 if(sessionLease(session,cell)!==lease)throw Error('role transport revoked or reauthenticated');
}
function currentGame(state,cell){
 // The response is selected by the extension's installed-cell-only native
 // reader. Agent 4's existing get_game_state cannot supply this proof.
 return requireCurrentRoleState(state,cell);
}
function currentSeat(game,agent,seat){
 if(!Number.isInteger(seat)||seat<0||seat>=game.commit.seats.length||
   !eq(game.commit.seats[seat],agent)||
   game.commit.seats.filter(x=>eq(x,agent)).length!==1)
   throw Error('recipient does not own exact current seat');
}
function requireDependencies(s){
 if(typeof s?.installedCell!=='function'||typeof s?.native?.readCurrentGame!=='function'||
    typeof s?.native?.readKeyEnrollment!=='function'||typeof s?.lair?.signByPubKey!=='function'||
    typeof s?.store?.getCell!=='function'||typeof s?.store?.reserve!=='function'||
    typeof s?.store?.getTrustedRecipient!=='function'||typeof s?.store?.pinTrustedRecipient!=='function')
   throw Error('native HWC authority or private keystore not installed');
}
export function createRestrictedRoleService(s){
 requireDependencies(s);
 // Volatile request/reply correlation dies on restart or WS reauthentication.
 // Durable replay IDs stay in the extension-only IndexedDB store.
 const outboundRequests=new Map(),incomingRequests=new Map();
 const key=(agent,commit,seat)=>[agent,commit].map(x=>Array.from(x,b=>b.toString(16).padStart(2,'0')).join('')).join(':')+':'+seat;
 const read=async()=>{
   const cell=cellOf(await s.installedCell());const lease=sessionLease(s.session,cell);
   const game=currentGame(await s.native.readCurrentGame(cell),cell);
   unchanged(s.session,cell,lease);return {cell,lease,game};
 };
 /** Native entry discovery only; no unsigned key lookup/Boolean shortcut. */
 async function discover(cell,recipient,lease){
   const observed=await validateObservedEnrollment(
     await s.native.readKeyEnrollment(cell,recipient),{dna:cell.dna,recipient});
   unchanged(s.session,cell,lease);
   await s.store.pinTrustedRecipient(cell.dna,recipient,observed.attestation);
   return s.store.getTrustedRecipient(cell.dna,recipient);
 }
 return Object.freeze({
   /** A seated recipient sends a LIVE signed, HPKE protected key attestation
    * to the actual current host. Cold DHT discovery alone does not authorize
    * sending a role. This request carries only PUBLIC key metadata.
    */
   async requestRole({seat}){
     const {cell,game,lease}=await read();
     if(eq(cell.agent,game.lobby.host))throw Error('host cannot request its own role over relay');
     currentSeat(game,cell.agent,seat);
     const own=await s.store.getCell(cell.dna,cell.agent);
     if(!own?.attestation||own.privateKey?.extractable!==false)
       throw Error('Lair attestation and held private key required before requesting');
     await verifyKeyAttestation(own.attestation,{dna:cell.dna,agent:cell.agent});
     const hostAtt=await discover(cell,game.lobby.host,lease);
     const request=await makeRoleRequest({dna:cell.dna,sender:cell.agent,
       recipient:game.lobby.host,commit:game.commit.action,seat,
       attestation:hostAtt,roleBytes:encodeAttestationBody(own.attestation),
       sign:(pub,b)=>s.lair.signByPubKey(pub,b)});
     unchanged(s.session,cell,lease);
     if(typeof s.session?.sendRoleFrame!=='function')throw Error('restricted H2HC relay unavailable');
     const pendingKey=key(cell.agent,game.commit.action,seat);
     if(outboundRequests.has(pendingKey))throw Error('outstanding signed recipient request exists');
     // Install correlation before socket send so a fast reply cannot beat
     // registration. On failure, tear it down; do not report receipt for ACK.
     outboundRequests.set(pendingKey,{id:request.messageId,lease,expiresAt:request.expiresAt});
     try {
       await s.session.sendRoleFrame(toRoleFrame(request));
       unchanged(s.session,cell,lease);
     } catch(e) {outboundRequests.delete(pendingKey);throw e;}
     return {requestSent:true,roleAvailable:false};
   },
   /** Host can send ONLY after an authenticated, independently signed,
    * current-round recipient key request was received on its live WS lease.
    * Merely reading native DHT "Observed current_unproven" is insufficient.
    */
   async sendRole({seat,role,roleSalt,path}){
     const {cell,game,lease}=await read();
     if(!eq(cell.agent,game.lobby.host))throw Error('only the installed host can encrypt roles');
     const recipient=game.commit.seats[seat];
     currentSeat(game,recipient,seat);
     const k=key(recipient,game.commit.action,seat),request=incomingRequests.get(k);
     if(!request||request.lease!==lease||Date.now()>request.expiresAt)
       throw Error('fresh signed recipient request required; DHT current is unproven');
     // Consume before asynchronous crypto/network operations: concurrent
     // sendRole calls must not reuse one live signed recipient request.
     incomingRequests.delete(k);
     const payload=encodeRoleOpening(role,roleSalt,path);
     await verifyRoleOpening({payload,seat,root:game.commit.merkleRoot});
     const attestation=await discover(cell,recipient,lease);
     if(!eq(attestation.keyId,request.attestation.keyId)||
        !eq(attestation.publicKey,request.attestation.publicKey)||
        attestation.epoch!==request.attestation.epoch)
       throw Error('native enrollment differs from signed live recipient request');
     const packet=await makeRoleDelivery({dna:cell.dna,sender:cell.agent,recipient,
       commit:game.commit.action,seat,attestation,roleBytes:payload,
       sign:(pub,b)=>s.lair.signByPubKey(pub,b),inReplyTo:request.id});
     unchanged(s.session,cell,lease);
     if(typeof s.session?.sendRoleFrame!=='function')throw Error('restricted H2HC relay unavailable');
     await s.session.sendRoleFrame(toRoleFrame(packet));
     unchanged(s.session,cell,lease);
     return {queuedOnly:true};
   },
   /** Exclusive WS callback: no public chrome.runtime/page relay to this API.
    * Either a host-bound authenticated recipient key request OR a correlated,
    * recipient-bound encrypted role delivery; never a generic WASM call.
    */
   async receiveFromSocket(json){
     const {cell,game,lease}=await read();
     if(typeof json!=='string')throw Error('role frame must come from authenticated WS parser');
     const packet=parseRoleFrame(json);
     if(!eq(packet.commit,game.commit.action)||!eq(packet.dna,cell.dna)||
        !eq(packet.recipient,cell.agent))
       throw Error('wrong recipient, DNA or current RoleCommit');
     if(!await internalsForTests.verify(packet.signature,packet.sender,
       internalsForTests.roleTranscript(packet)))
       throw Error('forged remote caller signature');
     internalsForTests.fresh(packet,Date.now());
     unchanged(s.session,cell,lease);
     const held=await s.store.getCell(cell.dna,cell.agent);
     if(!held?.attestation||held.privateKey?.extractable!==false)
       throw Error('no current locally attested X25519 key');
     await verifyKeyAttestation(held.attestation,{dna:cell.dna,agent:cell.agent});
     if(!eq(held.keyId,packet.keyId)||held.epoch!==packet.keyEpoch)
       throw Error('recipient key epoch or ID mismatch');
     if(packet.operation==='role_request_v1'){
       if(!eq(cell.agent,game.lobby.host))throw Error('nonhost cannot receive role requests');
       currentSeat(game,packet.sender,packet.seat);
       // Authoritative native DHT lookup cannot establish global newest epoch.
       // The live role_request signature plus encrypted signed attestation
       // closes that gap for this single requester and round only.
       await s.store.reserve({dna:packet.dna,recipient:packet.recipient,
         sender:packet.sender,commit:packet.commit,messageId:packet.messageId});
       const body=await openForCell(held,packet.enc,packet.ciphertext,
         internalsForTests.aadBytes(packet),HPKE_INFO);
       const att=await decodeAttestationBody(body,{dna:cell.dna,agent:packet.sender});
       const seen=await validateObservedEnrollment(
         await s.native.readKeyEnrollment(cell,packet.sender),
         {dna:cell.dna,recipient:packet.sender});
       if(!eq(seen.attestation.keyId,att.keyId)||
          !eq(seen.attestation.publicKey,att.publicKey)||
          seen.attestation.epoch!==att.epoch)
         throw Error('native enrollment differs from signed recipient request');
       await s.store.pinTrustedRecipient(cell.dna,packet.sender,att);
       unchanged(s.session,cell,lease);
       incomingRequests.set(key(packet.sender,packet.commit,packet.seat),{
         id:packet.messageId,lease,expiresAt:packet.expiresAt,attestation:att});
       return {validatedRecipientRequest:true,coordinatorInvoked:false};
     }
     if(packet.operation!=='role_delivery_v1')throw Error('unsupported role operation');
     currentSeat(game,cell.agent,packet.seat);
     if(!eq(packet.sender,game.lobby.host))
       throw Error('wrong current lobby host');
     const replyKey=key(cell.agent,packet.commit,packet.seat);
     const request=outboundRequests.get(replyKey);
     if(!request||request.lease!==lease||Date.now()>request.expiresAt||
        !packet.inReplyTo||!eq(request.id,packet.inReplyTo))
       throw Error('unsolicited, stale or uncorrelated role delivery');
     const verifiedRemoteCaller={authenticated:true,agent:packet.sender,
       dna:cell.dna,operation:'role_delivery_v1'};
     const commitState={nativeValidated:true,host:game.lobby.host,
       action:game.commit.action,seats:game.commit.seats};
     const plaintext=await receiveRoleDelivery(packet,{
       installedDna:cell.dna,localAgent:cell.agent,commitState,
       verifiedRemoteCaller,cellKey:held,ledger:s.store,expectedReplyTo:request.id,
       verifyRoleProof:async({plaintext:opening,seat:actual})=>{
         try{await verifyRoleOpening({payload:opening,seat:actual,
           root:game.commit.merkleRoot});return true;}catch{return false;}
       }});
     unchanged(s.session,cell,lease);
     const role=await verifyRoleOpening({payload:plaintext,seat:packet.seat,
       root:game.commit.merkleRoot});
     outboundRequests.delete(replyKey);
     // SECURE EXTENSION-LOCAL RECEIVE ONLY: do not execute the coordinator
     // with local ChainAuthor as a substitute for verified remote provenance.
     return Object.freeze({role,seat:packet.seat,roleCommit:packet.commit,
       coordinatorInvoked:false});
   },
 });
}
