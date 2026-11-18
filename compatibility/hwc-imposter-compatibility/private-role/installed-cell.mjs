/** Extension background ONLY. Derive the attested identity from the actual
 * HWC installed context and sign via its Lair client (never a web callback).
 * The caller MUST be the extension's own background service; never forward
 * a public page message to this function or expose its IndexedDB handle.
 */
import {attestKey,verifyKeyAttestation} from './wire.mjs';
import {seal,openForCell} from './hpke.mjs';
const bytes=x=>x instanceof Uint8Array?x:Array.isArray(x)?Uint8Array.from(x):null;
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const raw39=(x,prefix)=>x instanceof Uint8Array&&x.length===39&&prefix.every((v,i)=>x[i]===v);
export async function attestInstalledCell({dna,contextManager,lair,store,contextId,now=Date.now()}){
 if(!raw39(dna,[0x84,0x2d,0x24])||typeof contextId!=='string'||!contextId||
    typeof contextManager?.listContexts!=='function'||
    typeof lair?.signByPubKey!=='function'||typeof store?.getCell!=='function'||
    typeof store?.rotateCell!=='function'||typeof store?.installCellAttestation!=='function')
   throw Error('privileged installed-cell dependencies required');
 const contexts=await contextManager.listContexts();
 const matches=contexts.filter(c=>c?.id===contextId&&c.enabled===true&&
   Array.isArray(c.dnas)&&c.dnas.some(d=>eq(bytes(d.hash),dna)));
 if(matches.length!==1)throw Error('no unique enabled installed Imposter DNA context');
 const agent=bytes(matches[0].agentPubKey);
 if(!raw39(agent,[0x84,0x20,0x24]))throw Error('installed Lair agent identity invalid');
 let cell=await store.getCell(dna,agent);
 if(!cell)cell=await store.rotateCell(dna,agent,1);
 if(!eq(cell.dna,dna)||!eq(cell.agent,agent)||cell.privateKey?.extractable!==false)
   throw Error('stored cell does not match installed identity');
 // An old same-epoch attestation may be refreshed, but never copy in a
 // caller-provided key: the key ID and public key come only from this cell.
 const sign=(pub,data)=>lair.signByPubKey(pub,data);
 const attestation=await attestKey({dna,agent,keyId:cell.keyId,epoch:cell.epoch,
   publicKey:cell.publicKey,sign,now});
 await verifyKeyAttestation(attestation,{dna,agent,minEpoch:cell.epoch,now});
 // Proof of possession of the persisted non-extractable private key, not just
 // a matching untrusted IDB record with a public key and arbitrary key ID.
 const challenge=crypto.getRandomValues(new Uint8Array(32));
 const aad=crypto.getRandomValues(new Uint8Array(24));
 const sealed=await seal(cell.publicKey,challenge,aad);
 const opened=await openForCell(cell,sealed.enc,sealed.ciphertext,aad);
 if(!eq(challenge,opened))throw Error('installed recipient key possession failure');
 await store.installCellAttestation(dna,agent,attestation,{now});
 return attestation; // public only: never return the signing or X25519 secret
}
