/** Restricted role-only signed transcripts. No remote zome execution or page API. */
import {seal,openForCell} from './hpke.mjs';
const utf8=s=>new TextEncoder().encode(s);
const concat=(...chunks)=>{const o=new Uint8Array(chunks.reduce((n,a)=>n+a.length,0));let i=0;for(const a of chunks){o.set(a,i);i+=a.length;}return o;};
const bytes=(x,n,label)=>{if(!(x instanceof Uint8Array)||x.length!==n)throw Error(label+' length');return x;};
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const u16=n=>{if(!Number.isInteger(n)||n<0||n>65535)throw Error('u16');return new Uint8Array([n>>8,n&255]);};
const u64=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('u64');let v=BigInt(n),o=new Uint8Array(8);for(let i=7;i>=0;i--){o[i]=Number(v&255n);v>>=8n;}return o;};
const keyDomain=utf8('imposter-hwc/key-attestation/v1\0');
const roleDomain=utf8('imposter-hwc/role-delivery/v1\0');
const hpkeInfo=utf8('imposter-hwc/role-hpke/v1');
const chkHash=(x,kind)=>{bytes(x,39,kind);const p=kind==='dna'?[0x84,0x2d,0x24]:kind==='agent'?[0x84,0x20,0x24]:[0x84,0x29,0x24];if(!p.every((v,i)=>x[i]===v))throw Error('invalid '+kind+' HoloHash prefix');return x;};
const keyId=x=>bytes(x,16,'key id');
const rand16=()=>crypto.getRandomValues(new Uint8Array(16));
function keyTranscript(a){return concat(keyDomain,chkHash(a.dna,'dna'),chkHash(a.agent,'agent'),keyId(a.keyId),u64(a.epoch),u64(a.createdAt),u64(a.expiresAt),bytes(a.publicKey,32,'X25519 pubkey'));}
function deliveryHeader(a){return concat(roleDomain,chkHash(a.dna,'dna'),chkHash(a.sender,'agent'),chkHash(a.recipient,'agent'),chkHash(a.commit,'action'),u16(a.seat),keyId(a.keyId),u64(a.keyEpoch),bytes(a.messageId,16,'message id'),u64(a.createdAt),u64(a.expiresAt));}
function deliveryTranscript(a){return concat(deliveryHeader(a),bytes(a.enc,32,'HPKE enc'),u16(a.ciphertext.length),a.ciphertext);}
async function verify(signature,agent,transcript){bytes(signature,64,'signature');chkHash(agent,'agent');const key=await crypto.subtle.importKey('raw',agent.slice(3,35),'Ed25519',false,['verify']);return crypto.subtle.verify('Ed25519',key,signature,transcript);}
function fresh(a,now){if(!Number.isSafeInteger(now)||!Number.isSafeInteger(a.createdAt)||!Number.isSafeInteger(a.expiresAt)||a.createdAt>now+30000||a.expiresAt<=now||a.expiresAt<=a.createdAt||a.expiresAt-a.createdAt>120000)throw Error('stale or invalid role timestamp');}
/** Callback signs these ORIGINAL bytes using Lair signByPubKey(agent_core, bytes). */
export async function attestKey({dna,agent,keyId:providedId,epoch,publicKey,sign,now=Date.now()}){
 if(typeof sign!=='function')throw Error('Lair signer required');
 const a={dna,agent,keyId:providedId??rand16(),epoch,publicKey,createdAt:now,expiresAt:now+120000};
 const signature=bytes(await sign(chkHash(agent,'agent').slice(3,35),keyTranscript(a)),64,'signature');
 return {...a,signature};
}
export async function verifyKeyAttestation(a,{dna,agent,minEpoch=0,now=Date.now()}){
 if(!eq(chkHash(a.dna,'dna'),chkHash(dna,'dna'))||!eq(chkHash(a.agent,'agent'),chkHash(agent,'agent')))throw Error('wrong attested cell');
 if(!Number.isSafeInteger(a.epoch)||a.epoch<minEpoch)throw Error('old key epoch');
 fresh(a,now);
 if(!await verify(a.signature,a.agent,keyTranscript(a)))throw Error('forged key attestation');
 return true;
}
/** Host uses only an independently validated recipient-key attestation. */
export async function makeRoleDelivery({dna,sender,recipient,commit,seat,attestation,roleBytes,sign,now=Date.now()}){
 await verifyKeyAttestation(attestation,{dna,agent:recipient,now});
 if(typeof sign!=='function'||!(roleBytes instanceof Uint8Array)||roleBytes.length>3500)throw Error('invalid role payload or signer');
 const a={dna,sender,recipient,commit,seat,keyId:attestation.keyId,keyEpoch:attestation.epoch,messageId:rand16(),createdAt:now,expiresAt:now+120000};
 const {enc,ciphertext}=await seal(attestation.publicKey,roleBytes,deliveryHeader(a),hpkeInfo);
 const withCipher={...a,enc,ciphertext};
 const signature=bytes(await sign(chkHash(sender,'agent').slice(3,35),deliveryTranscript(withCipher)),64,'signature');
 return {...withCipher,signature};
}
/** Caller must be an extension-owned, verified-auth-session receiver.
 * It supplies an independently NATIVE-VALIDATED commitment, never browser JSON.
 * This function does NOT call a zome, emit a signal or expose plaintext.
 * Replay is reserved transactionally BEFORE decryption / proof validation.
 */
export async function receiveRoleDelivery(a,{installedDna,localAgent,commitState,cellKey,ledger,verifyRoleProof,now=Date.now()}){
 if(!commitState?.nativeValidated||typeof verifyRoleProof!=='function'||typeof ledger?.reserve!=='function')throw Error('native validation / verified recipient handler required');
 if(!eq(chkHash(a.dna,'dna'),chkHash(installedDna,'dna'))||!eq(chkHash(a.recipient,'agent'),chkHash(localAgent,'agent')))throw Error('wrong recipient cell');
 if(!eq(chkHash(a.sender,'agent'),chkHash(commitState.host,'agent'))||!eq(chkHash(a.commit,'action'),chkHash(commitState.action,'action')))throw Error('host/commit mismatch');
 if(!Number.isInteger(a.seat)||a.seat<0||!eq(commitState.seats?.[a.seat],localAgent))throw Error('seat mismatch');
 if(!eq(cellKey?.dna,installedDna)||!eq(cellKey?.agent,localAgent)||!eq(cellKey?.keyId,a.keyId)||cellKey.epoch!==a.keyEpoch)throw Error('recipient key substitution or rotation');
 fresh(a,now);
 if(!(a.ciphertext instanceof Uint8Array)||a.ciphertext.length<16||a.ciphertext.length>4096)throw Error('ciphertext length');
 if(!await verify(a.signature,a.sender,deliveryTranscript(a)))throw Error('forged role sender');
 await ledger.reserve({dna:a.dna,recipient:a.recipient,sender:a.sender,commit:a.commit,messageId:a.messageId});
 const plaintext=await openForCell(cellKey,a.enc,a.ciphertext,deliveryHeader(a),hpkeInfo);
 if(!await verifyRoleProof({plaintext,seat:a.seat,commit:commitState}))throw Error('invalid role proof');
 return plaintext;
}
export const internalsForTests={keyTranscript,deliveryHeader,deliveryTranscript,eq};
