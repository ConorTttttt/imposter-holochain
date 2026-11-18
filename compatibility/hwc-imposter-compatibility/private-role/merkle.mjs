/** Exact JS verifier of imposter-core::merkle::verify_role_proof (64 leaves).
 * No role vector, salt master, or plaintext is logged or persisted.
 * Ciphertext payload v1 is 209 bytes: role(1), role_salt(16), siblings(6*32).
 * This payload format is extension-local CANDIDATE; Agent 3's outer wire
 * already pins its ciphertext but does NOT yet freeze an inner role format.
 */
const utf8=s=>new TextEncoder().encode(s);
const cat=(...a)=>{const out=new Uint8Array(a.reduce((n,b)=>n+b.length,0));let o=0;for(const b of a){out.set(b,o);o+=b.length;}return out;};
const sha=async b=>new Uint8Array(await crypto.subtle.digest('SHA-256',b));
const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
export const ROLE_PROOF_BYTES=209;
export function encodeRoleOpening(role,roleSalt,path){
 if(role!==0&&role!==1)throw Error('invalid role');
 if(!(roleSalt instanceof Uint8Array)||roleSalt.length!==16||
   !Array.isArray(path)||path.length!==6||
   !path.every(x=>x instanceof Uint8Array&&x.length===32))throw Error('invalid role opening');
 return cat(new Uint8Array([role]),roleSalt,...path);
}
export function decodeRoleOpening(payload){
 if(!(payload instanceof Uint8Array)||payload.length!==ROLE_PROOF_BYTES)throw Error('invalid role opening payload');
 if(payload[0]!==0&&payload[0]!==1)throw Error('invalid role');
 return {role:payload[0],roleSalt:payload.slice(1,17),
   path:Array.from({length:6},(_,i)=>payload.slice(17+i*32,49+i*32))};
}
/** Must only be invoked with a root read independently from the current
 * accepted host-authored RoleCommit; this verifier cannot grant that trust. */
export async function verifyRoleOpening({payload,seat,root}){
 if(!Number.isInteger(seat)||seat<0||seat>=64)throw Error('invalid seat');
 if(!(root instanceof Uint8Array)||root.length!==32)throw Error('invalid Merkle root');
 const {role,roleSalt,path}=decodeRoleOpening(payload);
 let cursor=await sha(cat(new Uint8Array([0]),utf8('imposter:role:v1'),
   new Uint8Array([seat>>8,seat&255,role]),roleSalt));
 let i=seat;
 for(const sibling of path){
   cursor=await sha(cat(new Uint8Array([1]),...(i&1?[sibling,cursor]:[cursor,sibling])));
   i>>=1;
 }
 if(!eq(cursor,root))throw Error('invalid role Merkle proof');
 return role;
}
