/** Canonical INNER encrypted role_request_v1 key body candidate.
 * Outer Agent 3 signed wire/HPKE unchanged. Only public rev-2 key-attestation
 * fields, no private key or role leaf: byte 0 = version 1, then
 * DNA39, agent39, keyId16, X25519 pub32, epoch/notBefore/notAfter u64BE,
 * Lair Ed25519 signature64. Total 215 bytes.
 * Inner body format is NOT a frozen Agent 2/3 protocol yet.
 */
import {verifyKeyAttestation} from './wire.mjs';
const cat=(...parts)=>{let b=new Uint8Array(parts.reduce((n,p)=>n+p.length,0)),i=0;for(let p of parts){b.set(p,i);i+=p.length;}return b;};
const ck=(b,n)=>{if(!(b instanceof Uint8Array)||b.length!==n)throw Error('invalid key body field');return b;};
const u64=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('invalid key body time/epoch');let o=new Uint8Array(8),b=BigInt(n);for(let i=7;i>=0;i--){o[i]=Number(b&255n);b>>=8n;}return o;};
const fromU64=b=>{let n=0n;for(const x of b)n=n*256n+BigInt(x);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('unsafe key body epoch/time');return Number(n);};
export function encodeAttestationBody(a){
 return cat(new Uint8Array([1]),ck(a.dna,39),ck(a.agent,39),ck(a.keyId,16),
   ck(a.publicKey,32),u64(a.epoch),u64(a.notBefore),u64(a.notAfter),
   ck(a.signature,64));
}
export async function decodeAttestationBody(payload,{dna,agent,now=Date.now()}){
 ck(payload,215);if(payload[0]!==1)throw Error('wrong encrypted key body version');
 const a={dna:payload.slice(1,40),agent:payload.slice(40,79),
   keyId:payload.slice(79,95),publicKey:payload.slice(95,127),
   epoch:fromU64(payload.slice(127,135)),notBefore:fromU64(payload.slice(135,143)),
   notAfter:fromU64(payload.slice(143,151)),signature:payload.slice(151,215)};
 await verifyKeyAttestation(a,{dna,agent,now});
 return a;
}
