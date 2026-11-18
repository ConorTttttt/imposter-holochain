/** Installed HWC cell -> Agent 4 native Imposter key enrollment.
 * Extension background execution ONLY. Neither the page nor H2HC may supply
 * the signer, installed identity, X25519 public key, native result or floor.
 * This module does not install a public webpage API.
 */
import {attestInstalledCell} from './installed-cell.mjs';
import {validateObservedEnrollment} from './native-enrollment.mjs';
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
export async function publishInstalledRecipientKey({
  contextId,dna,contextManager,lair,store,native,now=Date.now()
}){
 if(typeof native?.publishSignedRecipientKey!=='function'||
    typeof native?.lookupRecipientKey!=='function')
   throw Error('installed native Imposter key-enrollment zome unavailable');
 // This creates/loads the protected X25519 key, proves its possession, and
 // obtains REAL Lair Ed25519 signature for the exact installed cell author.
 const a=await attestInstalledCell({contextId,dna,contextManager,lair,store,now});
 const entry={dna:a.dna,agent:a.agent,key_id:a.keyId,
   x25519_public_key:a.publicKey,epoch:a.epoch,
   not_before_ms:a.notBefore,not_after_ms:a.notAfter,signature:a.signature};
 // Exact Agent4 game::publish_signed_recipient_key_attestation; coordinator
 // uses native Holochain action author, integrity zome and DHT link rules.
 const published=await native.publishSignedRecipientKey(contextId,entry);
 if(!published?.action||!published?.attestation)
   throw Error('native enrollment did not return signed action and entry');
 // Host-side independently native-validated lookup and immutable action
 // must agree. The DHT view is NOT considered globally newest.
 const response=await native.lookupRecipientKey(contextId,{
   recipient:a.agent,min_epoch:a.epoch,min_key_id:a.keyId
 });
 const observed=await validateObservedEnrollment(response,{dna,recipient:a.agent,now});
 if(!eq(observed.attestation.keyId,a.keyId)||
    !eq(observed.attestation.publicKey,a.publicKey)||
    !eq(observed.attestation.signature,a.signature)||
    observed.attestation.epoch!==a.epoch)
   throw Error('native indexed entry differs from locally held signed X25519 key');
 return Object.freeze({action:observed.action,epoch:a.epoch,
   keyId:a.keyId,publicKey:a.publicKey,observedCurrentUnproven:true});
}
