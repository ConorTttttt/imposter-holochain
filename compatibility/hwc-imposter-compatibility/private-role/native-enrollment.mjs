/** Agent 4 native game::lookup_recipient_key adapter.
 * MUST be invoked from privileged HWC coordinator execution of the exact
 * installed cell, never a caller-supplied JSON or unsigned H2HC lookup.
 * A native Valid record proves existence and author/DNA binding only.
 * "current_unproven:true" explicitly forbids encryption without the
 * subsequent signed, live role_request_v1 recipient confirmation.
 */
import {verifyKeyAttestation} from './wire.mjs';
const bytes=x=>x instanceof Uint8Array?x:Array.isArray(x)?Uint8Array.from(x):null;
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
export async function validateObservedEnrollment(nativeResult,{dna,recipient,now=Date.now()}){
 if(nativeResult?.status!=='observed'||nativeResult.current_unproven!==true||
    !nativeResult.view)
   throw Error('native recipient enrollment missing or globally unproven');
 const action=bytes(nativeResult.view.action);
 if(!action||action.length!==39||action[0]!==0x84||action[1]!==0x29||action[2]!==0x24)
   throw Error('native recipient enrollment action hash missing or invalid');
 const a=nativeResult.view.attestation;
 if(!a||!eq(bytes(a.dna),dna)||!eq(bytes(a.agent),recipient))
   throw Error('native recipient DNA or author mismatch');
 const attestation={
   dna:bytes(a.dna),agent:bytes(a.agent),keyId:bytes(a.key_id),
   publicKey:bytes(a.x25519_public_key),epoch:a.epoch,
   notBefore:a.not_before_ms,notAfter:a.not_after_ms,signature:bytes(a.signature)
 };
 await verifyKeyAttestation(attestation,{dna,agent:recipient,now});
 return {attestation,action,currentUnproven:true};
}
