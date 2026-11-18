/** Strict Agent 4 installed-cell-only native coordinator adapter.
 * All code runs in privileged HWC extension context. The caller MUST supply
 * a private, installed-cell-bound zomeCall callback (the existing local
 * executor), not a generic page or gateway zome-call router.
 *
 * This is a contract adapter, NOT an HWC installation or a proof of transport.
 */
import {requireCurrentRoleState} from './native-state.mjs';
/** Native serde/Chrome structured-clone can return a typed array, a dense
 * number array or a dense integer-key object. Never silently truncate bytes.
 * No untrusted page result is allowed to reach this native-only adapter.
 */
const b=x=>{
 if(x instanceof Uint8Array)return x;
 if(Array.isArray(x))return x.every(n=>Number.isInteger(n)&&n>=0&&n<=255)?Uint8Array.from(x):null;
 if(x&&typeof x==='object'){
   const keys=Object.keys(x);
   if(!keys.length||!keys.every((k,i)=>k===String(i)))return null;
   const values=keys.map(k=>x[k]);
   return values.every(n=>Number.isInteger(n)&&n>=0&&n<=255)?Uint8Array.from(values):null;
 }
 return null;
};
const exactBytes=(x,n,what)=>{const v=b(x);if(!v||v.length!==n)throw Error('invalid native '+what+' bytes');return v;};
const eq=(a,c)=>a instanceof Uint8Array&&c instanceof Uint8Array&&a.length===c.length&&a.every((v,i)=>v===c[i]);
const valid=(x,p)=>{const v=b(x);if(!v||v.length!==39||!p.every((n,i)=>v[i]===n))throw Error('invalid installed HoloHash');return v;};
const ACTION=[0x84,0x29,0x24],AGENT=[0x84,0x20,0x24],DNA=[0x84,0x2d,0x24];
const same=(a,c)=>a.contextId===c.contextId&&eq(a.dna,c.dna)&&eq(a.agent,c.agent);
export function createInstalledNativeAuthority({installedCell,pinnedLobby,pinRoleCommit,readPinnedRoleCommit,zomeCall,trustedFloor}){
 if(typeof installedCell!=='function'||typeof pinnedLobby!=='function'||
    typeof pinRoleCommit!=='function'||typeof readPinnedRoleCommit!=='function'||
    typeof zomeCall!=='function'||typeof trustedFloor!=='function')
   throw Error('extension-only native authority dependencies missing');
 async function context(cell){
   const live=await installedCell();
   if(!cell?.contextId||!same(live,cell)||!live.enabled)
     throw Error('installed HWC cell changed, revoked or disabled');
   valid(cell.dna,DNA);valid(cell.agent,AGENT);
   return live;
 }
 async function execute(cell,fn,payload){
   await context(cell);
   // Trusted HWC local executor is the sole authority: no receiver-controlled
   // zome/function, remote provenance or page-supplied "native valid" bit.
   const result=await zomeCall({
      contextId:cell.contextId,cellId:[cell.dna,cell.agent],zome:'game',
      fn,payload,provenance:cell.agent
   });
   await context(cell);
   if(result===undefined||result===null)throw Error('native coordinator unavailable');
   return result;
 }
 async function selectedLobby(cell){
   await context(cell);
   const anchor=await pinnedLobby(cell);
   await context(cell);
   return valid(anchor,ACTION);
 }
 async function queryView(cell,expectedLobby,commit,recipient=null,seat=null){
   return execute(cell,'get_authoritative_game_view',{
     expected_lobby:expectedLobby,expected_role_commit:commit,
     expected_recipient:recipient,expected_seat:seat
   });
 }
 return Object.freeze({
   async readCurrentGame(cell){
     const lobby=await selectedLobby(cell);
     // First native Valid observation discovers the sole RoleCommit.
     // Then pin exact commitment and require a second native observation.
     const observed=await queryView(cell,lobby,null);
     if(!eq(b(observed.lobby_action),lobby))
       throw Error('observed Lobby differs from protected installed pin');
     const commit=valid(observed.role_commit_action,ACTION);
     const pinned=await queryView(cell,lobby,commit);
     const first=requireCurrentRoleState(observed,cell);
     const exact=requireCurrentRoleState(pinned,cell);
     if(!eq(first.lobby.action,exact.lobby.action)||
        !eq(first.lobby.host,exact.lobby.host)||
        !eq(first.commit.action,exact.commit.action)||
        !eq(first.commit.merkleRoot,exact.commit.merkleRoot)||
        first.commit.seats.length!==exact.commit.seats.length||
        first.commit.seats.some((v,i)=>!eq(v,exact.commit.seats[i])||
          !eq(first.commit.joins[i],exact.commit.joins[i]))||
        observed.network_seed!==pinned.network_seed)
       throw Error('native game view changed between commitment observations');
     // This is a protected, atomic, irreversible IDB write. A second native
     // observation alone is not an action pin across browser restarts.
     await pinRoleCommit(cell.dna,cell.agent,lobby,commit);
     await context(cell);
     const durable=valid(await readPinnedRoleCommit(cell.dna,cell.agent),ACTION);
     if(!eq(durable,commit))throw Error('native RoleCommit pin did not persist');
     return pinned;
   },
   async readHostRoleOpening(cell,query){
     const lobby=await selectedLobby(cell);
     if(!eq(b(query?.expected_lobby),lobby)||
        !valid(query?.expected_role_commit,ACTION)||
        !valid(query?.expected_recipient,AGENT)||
        !Number.isInteger(query?.expected_seat)||query.expected_seat<0||
        query.expected_seat>63)
       throw Error('host opening is not bound to installed native game');
     const durable=valid(await readPinnedRoleCommit(cell.dna,cell.agent),ACTION);
     if(!eq(durable,b(query.expected_role_commit)))
       throw Error('host opening differs from durable RoleCommit action');
     const result=await execute(cell,'host_role_opening',{
       expected_lobby:lobby,expected_role_commit:query.expected_role_commit,
       expected_recipient:query.expected_recipient,expected_seat:query.expected_seat
     });
     if(!eq(b(result.role_commit),b(query.expected_role_commit))||
        !eq(b(result.recipient),b(query.expected_recipient))||
        result.seat!==query.expected_seat)
       throw Error('host-only native opening identity mismatch');
     if(result.role!==0&&result.role!==1)
       throw Error('invalid native role byte');
     const salt=exactBytes(result.proof?.role_salt,16,'role salt');
     if(!Array.isArray(result.proof?.path)||result.proof.path.length!==6)
       throw Error('invalid native role path');
     const path=result.proof.path.map(p=>exactBytes(p,32,'role sibling'));
     await context(cell);
     return {role_commit:durable,recipient:valid(query.expected_recipient,AGENT),
       seat:result.seat,role:result.role,proof:{role_salt:salt,path}};
   },
   async readKeyEnrollment(cell,recipient){
     await context(cell);
     valid(recipient,AGENT);
     const floor=await trustedFloor(cell.dna,recipient);
     if(floor?.revoked)throw Error('native recipient enrollment was revoked');
     if(floor&&(floor.keyId==null||!Number.isSafeInteger(floor.epoch)||
         floor.epoch<1||!b(floor.keyId)||b(floor.keyId).length!==16))
       throw Error('protected native recipient floor corrupted');
     return execute(cell,'lookup_recipient_key',{
       recipient,min_epoch:floor?.epoch??null,min_key_id:floor?.keyId??null
     });
   },
   async publishSignedRecipientKey(contextId,entry){
     const cell=await installedCell();
     if(cell?.contextId!==contextId||!eq(b(entry?.dna),cell.dna)||
        !eq(b(entry?.agent),cell.agent))throw Error('foreign installed native cell');
     return execute(cell,'publish_signed_recipient_key_attestation',entry);
   },
   async lookupRecipientKey(contextId,query){
     const cell=await installedCell();
     if(cell?.contextId!==contextId)throw Error('foreign installed native context');
     valid(query?.recipient,AGENT);
     if(query.min_epoch!=null&&(!Number.isSafeInteger(query.min_epoch)||query.min_epoch<1))
       throw Error('invalid trusted recipient epoch floor');
     if(query.min_key_id!=null&&(!b(query.min_key_id)||b(query.min_key_id).length!==16))
       throw Error('invalid trusted recipient key floor');
     return execute(cell,'lookup_recipient_key',query);
   }
 });
}
