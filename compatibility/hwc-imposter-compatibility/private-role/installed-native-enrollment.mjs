/** Installed HWC cell -> Agent 4 native Imposter key enrollment.
 * Extension background execution ONLY. Neither the page nor H2HC may supply
 * the signer, installed identity, X25519 public key, native result or floor.
 * This module does not install a public webpage API.
 */
import {attestInstalledCell} from './installed-cell.mjs';
import {validateObservedEnrollment} from './native-enrollment.mjs';
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const nativeBytes=(value,length,label)=>{
 let bytes;
 if(value instanceof Uint8Array)bytes=value;
 else if(Array.isArray(value)&&value.every(v=>Number.isInteger(v)&&v>=0&&v<=255))
   bytes=Uint8Array.from(value);
 else if(value&&typeof value==='object'){
   const keys=Object.keys(value);
   if(keys.length===length&&keys.every((k,i)=>k===String(i))&&
      keys.every(k=>Number.isInteger(value[k])&&value[k]>=0&&value[k]<=255))
     bytes=Uint8Array.from(keys.map(k=>value[k]));
 }
 if(!bytes||bytes.length!==length)throw Error('invalid native '+label+' bytes');
 return bytes;
};
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
 const publishedAction=nativeBytes(published.action,39,'published action');
 if(!publishedAction||publishedAction.length!==39||
    publishedAction[0]!==0x84||publishedAction[1]!==0x29||publishedAction[2]!==0x24)
   throw Error('native enrollment returned invalid action hash');
 const signed=published.attestation;
 if(!eq(nativeBytes(signed.dna,39,'published DNA'),a.dna)||
    !eq(nativeBytes(signed.agent,39,'published agent'),a.agent)||
    !eq(nativeBytes(signed.key_id,16,'published key ID'),a.keyId)||
    !eq(nativeBytes(signed.x25519_public_key,32,'published key'),a.publicKey)||
    !eq(nativeBytes(signed.signature,64,'published signature'),a.signature)||
    signed.epoch!==a.epoch||
    signed.not_before_ms!==a.notBefore||signed.not_after_ms!==a.notAfter)
   throw Error('native published action does not match locally signed key');
 // Host-side independently native-validated lookup and immutable action
 // must agree. The DHT view is NOT considered globally newest.
 const response=await native.lookupRecipientKey(contextId,{
   recipient:a.agent,min_epoch:a.epoch,min_key_id:a.keyId
 });
 const observed=await validateObservedEnrollment(response,{dna,recipient:a.agent,now});
 if(!eq(observed.action,publishedAction)||!eq(observed.attestation.keyId,a.keyId)||
    !eq(observed.attestation.publicKey,a.publicKey)||
    !eq(observed.attestation.signature,a.signature)||
    observed.attestation.epoch!==a.epoch)
   throw Error('native indexed entry differs from locally held signed X25519 key');
 return Object.freeze({action:observed.action,epoch:a.epoch,
   keyId:a.keyId,publicKey:a.publicKey,expiresAt:a.notAfter,observedCurrentUnproven:true});
}
