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
import {verifyKeyAttestation,makeRoleDelivery,receiveRoleDelivery,
  fromRoleFrame,parseRoleFrame,toRoleFrame,internalsForTests} from './wire.mjs';
import {verifyRoleOpening,encodeRoleOpening} from './merkle.mjs';
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
 const lobby=state?.lobby,commit=state?.commit;
 // The source of state, not a "nativeValidated" field, MUST be the privileged
 // native-validated authority adapter. These assertions additionally protect
 // against the wrong room, substituted host, unseated recipients, and old round.
 if(!full(lobby?.action,H)||!full(lobby?.author,A)||!full(lobby?.host,A)||
    !full(commit?.action,H)||!full(commit?.author,A)||!full(commit?.lobby,H)||
    !eq(lobby.host,lobby.author)||!eq(commit.author,lobby.host)||
    !eq(commit.lobby,lobby.action)||!Array.isArray(commit.seats)||
    !commit.seats.every(a=>full(a,A))||commit.seats.length<1||
    commit.seats.length>64||!(commit.merkleRoot instanceof Uint8Array)||
    commit.merkleRoot.length!==32||!Number.isSafeInteger(lobby.round)||
    lobby.round<1||commit.round!==lobby.round||state.currentRound!==lobby.round||
    state.active!==true||!eq(state.dna,cell.dna))
   throw Error('missing current host-authored native game state');
 return {lobby,commit};
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
 const read=async()=>{
   const cell=cellOf(await s.installedCell());const lease=sessionLease(s.session,cell);
   const game=currentGame(await s.native.readCurrentGame(cell),cell);
   unchanged(s.session,cell,lease);return {cell,lease,game};
 };
 /** Native entry discovery only; no unsigned key lookup/Boolean shortcut. */
 async function discover(cell,recipient,lease){
   const enrolled=await s.native.readKeyEnrollment(cell,recipient);
   if(!eq(enrolled?.dna,cell.dna)||!eq(enrolled?.author,recipient)||
      !eq(enrolled?.attestation?.agent,recipient))
     throw Error('recipient attestation was not native-enrolled');
   await verifyKeyAttestation(enrolled.attestation,{dna:cell.dna,agent:recipient});
   unchanged(s.session,cell,lease);
   await s.store.pinTrustedRecipient(cell.dna,recipient,enrolled.attestation);
   return s.store.getTrustedRecipient(cell.dna,recipient);
 }
 return Object.freeze({
   /** Host-only send to ONE seat. No plaintext, capability, or role vector
    * enters gateway logs, browser page, DHT or chrome.storage.
    */
   async sendRole({seat,role,roleSalt,path,inReplyTo=null}){
     const {cell,game,lease}=await read();
     if(!eq(cell.agent,game.lobby.host))throw Error('only the installed host can encrypt roles');
     const recipient=game.commit.seats[seat];
     currentSeat(game,recipient,seat);
     const payload=encodeRoleOpening(role,roleSalt,path);
     await verifyRoleOpening({payload,seat,root:game.commit.merkleRoot});
     const attestation=await discover(cell,recipient,lease);
     const packet=await makeRoleDelivery({dna:cell.dna,sender:cell.agent,recipient,
       commit:game.commit.action,seat,attestation,roleBytes:payload,
       sign:(pub,b)=>s.lair.signByPubKey(pub,b),inReplyTo});
     unchanged(s.session,cell,lease);
     if(typeof s.session?.sendRoleFrame!=='function')throw Error('restricted H2HC relay unavailable');
     await s.session.sendRoleFrame(toRoleFrame(packet));
     unchanged(s.session,cell,lease);
     return {queuedOnly:true}; // never a delivery, native commit or game success ACK
   },
   /** Only the private authenticated WS dispatch may call this function.
    * Do NOT route a webpage command or public onMessage listener here.
    * Signed role sender is verified independently of any claimed "from".
    */
   async receiveFromSocket(json){
     const {cell,game,lease}=await read();
     if(typeof json!=='string')throw Error('role frame must come from authenticated WS parser');
     const packet=parseRoleFrame(json);
     if(packet.operation!=='role_delivery_v1')throw Error('not a role delivery');
     currentSeat(game,cell.agent,packet.seat);
     if(!eq(packet.commit,game.commit.action)||!eq(packet.sender,game.lobby.host))
       throw Error('wrong host or current RoleCommit');
     if(!await internalsForTests.verify(packet.signature,packet.sender,
       internalsForTests.roleTranscript(packet)))
       throw Error('forged remote caller signature');
     unchanged(s.session,cell,lease);
     const held=await s.store.getCell(cell.dna,cell.agent);
     if(!held?.attestation||held.privateKey?.extractable!==false)
       throw Error('no current locally attested X25519 key');
     const verifiedRemoteCaller={authenticated:true,agent:packet.sender,
       dna:cell.dna,operation:'role_delivery_v1'};
     // This shim is built only after: authenticated WS session AND Lair
     // signature AND authoritative native state; no user-controlled flag.
     const commitState={nativeValidated:true,host:game.lobby.host,
       action:game.commit.action,seats:game.commit.seats};
     const expectedReplyTo=typeof s.pendingReplyId==='function'?
       s.pendingReplyId(cell,game.commit.action):null;
     const plaintext=await receiveRoleDelivery(packet,{
       installedDna:cell.dna,localAgent:cell.agent,commitState,
       verifiedRemoteCaller,cellKey:held,ledger:s.store,expectedReplyTo,
       verifyRoleProof:async({plaintext:opening,seat:actual})=>{
         try{await verifyRoleOpening({payload:opening,seat:actual,
           root:game.commit.merkleRoot});return true;}catch{return false;}
       }});
     unchanged(s.session,cell,lease);
     const role=await verifyRoleOpening({payload:plaintext,seat:packet.seat,
       root:game.commit.merkleRoot});
     // SECURE EXTENSION-LOCAL RECEIVE ONLY: do not execute the coordinator
     // with local ChainAuthor as a substitute for verified remote provenance.
     return Object.freeze({role,seat:packet.seat,roleCommit:packet.commit,
       coordinatorInvoked:false});
   },
 });
}
