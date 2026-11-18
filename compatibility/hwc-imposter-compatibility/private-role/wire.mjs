/**
 * Agent 3 restricted H2HC role relay v1, byte-exact transcript implementation.
 * Protocol: ci/agent3-h2hc-kit/RESTRICTED_ROLE_RELAY_V1.md @ 204cd95a.
 * Pure extension-side primitives only: NOT a remote handler or coordinator bridge.
 */
import {seal,openForCell} from './hpke.mjs';
const utf8=s=>new TextEncoder().encode(s);
const concat=(...chunks)=>{const out=new Uint8Array(chunks.reduce((n,a)=>n+a.length,0));let p=0;for(const a of chunks){out.set(a,p);p+=a.length;}return out;};
const bytes=(x,n,label)=>{if(!(x instanceof Uint8Array)||(n!==null&&x.length!==n))throw Error(label+' length');return x;};
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=(s,label)=>{if(typeof s!=='string'||!/^[0-9a-f]{32}$/.test(s))throw Error('invalid '+label);return Uint8Array.from(s.match(/../g),c=>parseInt(c,16));};
const b64=b=>BufferlessB64.encode(b);
const fromB64=(s,label)=>BufferlessB64.decode(s,label);
/** RFC 4648 padded standard base64; browser and Node without Buffer dependency. */
const BufferlessB64={
 encode(b){bytes(b,null,'base64');let t='';for(let i=0;i<b.length;i+=0x8000)t+=String.fromCharCode(...b.subarray(i,i+0x8000));return btoa(t);},
 decode(s,label){if(typeof s!=='string'||s.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))throw Error('invalid '+label+' base64');let b;try{b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));}catch{throw Error('invalid '+label+' base64');}if(this.encode(b)!==s)throw Error('noncanonical '+label+' base64');return b;}
};
const u16=n=>{if(!Number.isInteger(n)||n<0||n>65535)throw Error('u16');return new Uint8Array([n>>8,n&255]);};
const u32=n=>{if(!Number.isSafeInteger(n)||n<0||n>0xffffffff)throw Error('u32');return new Uint8Array([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255]);};
const u64=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('u64');let v=BigInt(n),o=new Uint8Array(8);for(let i=7;i>=0;i--){o[i]=Number(v&255n);v>>=8n;}return o;};
const PREFIX=Object.freeze({dna:[0x84,0x2d,0x24],agent:[0x84,0x20,0x24],action:[0x84,0x29,0x24]});
/* Location/checksum must also be validated by the installed native HoloHash parser
 * at the privileged boundary; no invented 39-byte hash may be considered installed. */
const chkHash=(x,kind)=>{bytes(x,39,kind);if(!PREFIX[kind].every((v,i)=>x[i]===v))throw Error('invalid '+kind+' HoloHash prefix');return x;};
const id=(x,label)=>bytes(x,16,label);
const positiveEpoch=n=>{if(!Number.isSafeInteger(n)||n<1)throw Error('invalid recipient key epoch');return u64(n);};
const randomId=()=>crypto.getRandomValues(new Uint8Array(16));
const KEY_PREFIX=utf8('IMPOSTER-H2HC-ROLE-KEY\0\x01');
const SIGN_PREFIX=utf8('IMPOSTER-H2HC-ROLE-SIGNED\0\x01');
const AAD_PREFIX=utf8('IMPOSTER-H2HC-ROLE-AAD\0\x01');
export const HPKE_INFO=utf8('imposter.h2hc.private-role/hpke-v1');
export const WIRE_DOMAIN='imposter.h2hc.private-role.v1';
export const OPERATIONS=Object.freeze({role_request_v1:1,role_delivery_v1:2});
const operation=a=>{const k=a.operation??a.type;if(!Object.hasOwn(OPERATIONS,k))throw Error('unsupported role operation');return k;};
function keyTranscript(a){return concat(KEY_PREFIX,chkHash(a.dna,'dna'),chkHash(a.agent,'agent'),id(a.keyId,'key ID'),bytes(a.publicKey,32,'X25519 public key'),u64(a.epoch),u64(a.notBefore),u64(a.notAfter));}
function roleHeader(a){const op=operation(a);const reply=a.inReplyTo??null;if(op==='role_request_v1'&&reply!==null)throw Error('role request cannot reply');return concat(new Uint8Array([OPERATIONS[op]]),chkHash(a.dna,'dna'),chkHash(a.sender,'agent'),chkHash(a.recipient,'agent'),chkHash(a.commit,'action'),u16(a.seat),id(a.keyId,'key ID'),positiveEpoch(a.keyEpoch),id(a.messageId,'message ID'),u64(a.createdAt),u64(a.expiresAt),new Uint8Array([reply===null?0:1]),...(reply===null?[]:[id(reply,'in_reply_to')]));}
function aadBytes(a){return concat(AAD_PREFIX,roleHeader(a));}
function roleTranscript(a){const ct=bytes(a.ciphertext,null,'ciphertext');if(ct.length<16||ct.length>4096)throw Error('ciphertext length');return concat(SIGN_PREFIX,roleHeader(a),bytes(a.enc,32,'HPKE enc'),u32(ct.length),ct);}
async function verify(signature,agent,transcript){bytes(signature,64,'signature');chkHash(agent,'agent');const pub=await crypto.subtle.importKey('raw',agent.slice(3,35),'Ed25519',false,['verify']);return crypto.subtle.verify('Ed25519',pub,signature,transcript);}
function fresh(a,now){if(!Number.isSafeInteger(now)||!Number.isSafeInteger(a.createdAt)||!Number.isSafeInteger(a.expiresAt)||a.createdAt>now+30000||a.expiresAt<=now||a.expiresAt<=a.createdAt||a.expiresAt-a.createdAt>60000)throw Error('stale or invalid role timestamp');}
function keyFresh(a,now){if(!Number.isSafeInteger(now)||!Number.isSafeInteger(a.notBefore)||!Number.isSafeInteger(a.notAfter)||a.notAfter<=a.notBefore||now<a.notBefore||now>a.notAfter)throw Error('expired or not-yet-valid key attestation');}
async function trustedSign(sign,agent,transcript){if(typeof sign!=='function')throw Error('extension Lair signer required');const signature=bytes(await sign(chkHash(agent,'agent').slice(3,35),transcript),64,'signature');if(!await verify(signature,agent,transcript))throw Error('Lair signer identity mismatch');return signature;}
/** sign MUST be a verified extension-owned Lair signByPubKey binding. */
export async function attestKey({dna,agent,keyId:providedId,epoch,publicKey,sign,now=Date.now(),validForMs=60000}){
 if(!Number.isSafeInteger(epoch)||epoch<1||!Number.isSafeInteger(validForMs)||validForMs<1||validForMs>60000)throw Error('invalid epoch or key validity');
 const a={dna,agent,keyId:providedId??randomId(),epoch,publicKey,notBefore:now,notAfter:now+validForMs};
 return {...a,signature:await trustedSign(sign,agent,keyTranscript(a))};
}
export async function verifyKeyAttestation(a,{dna,agent,minEpoch=1,now=Date.now()}){
 if(!eq(chkHash(a.dna,'dna'),chkHash(dna,'dna'))||!eq(chkHash(a.agent,'agent'),chkHash(agent,'agent')))throw Error('wrong attested cell');
 if(!Number.isSafeInteger(a.epoch)||a.epoch<minEpoch||a.epoch<1)throw Error('old key epoch');
 keyFresh(a,now);
 if(!await verify(a.signature,a.agent,keyTranscript(a)))throw Error('forged key attestation');
 return true;
}
/** Key lookup is NOT a gateway API; caller must supply separately authenticated enrollment. */
export async function makeRoleMessage({operation:op,dna,sender,recipient,commit,seat,attestation,roleBytes,sign,now=Date.now(),inReplyTo=null}){
 if(!Object.hasOwn(OPERATIONS,op))throw Error('unsupported role operation');
 await verifyKeyAttestation(attestation,{dna,agent:recipient,now});
 if(!(roleBytes instanceof Uint8Array)||roleBytes.length>4080)throw Error('invalid role payload');
 const a={operation:op,dna,sender,recipient,commit,seat,keyId:attestation.keyId,keyEpoch:attestation.epoch,messageId:randomId(),createdAt:now,expiresAt:now+30000,inReplyTo};
 const {enc,ciphertext}=await seal(attestation.publicKey,roleBytes,aadBytes(a),HPKE_INFO);
 const packet={...a,enc,ciphertext};
 return {...packet,signature:await trustedSign(sign,sender,roleTranscript(packet))};
}
export const makeRoleDelivery=opts=>makeRoleMessage({...opts,operation:'role_delivery_v1'});
export const makeRoleRequest=opts=>makeRoleMessage({...opts,operation:'role_request_v1',inReplyTo:null});
function rawHash(s,kind){if(typeof s!=='string'||!/^u[A-Za-z0-9_-]{52}$/.test(s))throw Error('noncanonical '+kind+' hash');const body=s.slice(1).replace(/-/g,'+').replace(/_/g,'/');const raw=fromB64(body,kind);chkHash(raw,kind);if(toWireHash(raw)!==s)throw Error('noncanonical '+kind+' hash');return raw;}
function toWireHash(x){const v=b64(bytes(x,39,'HoloHash')).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');return 'u'+v;}
const assertFields=(x,fields)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==fields.length||!fields.every(k=>Object.hasOwn(x,k)))throw Error('unexpected role frame fields');};
const frameFields=['version','domain','dna_hash','sender_agent','recipient_agent','role_commit','seat','recipient_key_id','recipient_key_epoch','message_id','created_at_ms','expires_at_ms','in_reply_to','hpke_enc','ciphertext'];
export function toRoleFrame(p){const op=operation(p);roleTranscript(p);const env={version:1,domain:WIRE_DOMAIN,dna_hash:toWireHash(chkHash(p.dna,'dna')),sender_agent:toWireHash(chkHash(p.sender,'agent')),recipient_agent:toWireHash(chkHash(p.recipient,'agent')),role_commit:toWireHash(chkHash(p.commit,'action')),seat:p.seat,recipient_key_id:hex(id(p.keyId,'key ID')),recipient_key_epoch:p.keyEpoch,message_id:hex(id(p.messageId,'message ID')),created_at_ms:p.createdAt,expires_at_ms:p.expiresAt,in_reply_to:p.inReplyTo===null||p.inReplyTo===undefined?null:hex(id(p.inReplyTo,'in_reply_to')),hpke_enc:b64(bytes(p.enc,32,'HPKE enc')),ciphertext:b64(bytes(p.ciphertext,null,'ciphertext'))};return {type:op,envelope:env,signature:b64(bytes(p.signature,64,'signature'))};}
export function fromRoleFrame(frame){assertFields(frame,['type','envelope','signature']);if(!Object.hasOwn(OPERATIONS,frame.type))throw Error('unsupported role operation');const e=frame.envelope;assertFields(e,frameFields);if(e.version!==1||e.domain!==WIRE_DOMAIN)throw Error('unsupported role domain/version');const a={operation:frame.type,dna:rawHash(e.dna_hash,'dna'),sender:rawHash(e.sender_agent,'agent'),recipient:rawHash(e.recipient_agent,'agent'),commit:rawHash(e.role_commit,'action'),seat:e.seat,keyId:unhex(e.recipient_key_id,'key ID'),keyEpoch:e.recipient_key_epoch,messageId:unhex(e.message_id,'message ID'),createdAt:e.created_at_ms,expiresAt:e.expires_at_ms,inReplyTo:e.in_reply_to===null?null:unhex(e.in_reply_to,'in_reply_to'),enc:fromB64(e.hpke_enc,'enc'),ciphertext:fromB64(e.ciphertext,'ciphertext'),signature:fromB64(frame.signature,'signature')};roleTranscript(a);bytes(a.signature,64,'signature');return a;}
export function parseRoleFrame(json){if(typeof json!=='string'||utf8(json).length>8192)throw Error('role frame too large');return fromRoleFrame(JSON.parse(json));}
/**
 * NOT a privileged entry point. Requires independently native-validated
 * coordinator data and a trusted remote-caller context BEFORE use.
 * No remote zome invocation, page callback or gateway ACK is authorized here.
 */
export async function receiveRoleDelivery(a,{installedDna,localAgent,commitState,verifiedRemoteCaller,cellKey,ledger,verifyRoleProof,expectedReplyTo=null,now=Date.now()}){
 if(operation(a)!=='role_delivery_v1')throw Error('not a delivery');
 if(commitState?.nativeValidated!==true||typeof verifyRoleProof!=='function'||typeof ledger?.reserve!=='function'||verifiedRemoteCaller?.authenticated!==true)throw Error('native validation / verified remote caller required');
 if(!eq(chkHash(a.dna,'dna'),chkHash(installedDna,'dna'))||!eq(chkHash(a.recipient,'agent'),chkHash(localAgent,'agent')))throw Error('wrong recipient cell');
 if(!eq(chkHash(a.sender,'agent'),chkHash(commitState.host,'agent'))||!eq(chkHash(a.commit,'action'),chkHash(commitState.action,'action')))throw Error('host/commit mismatch');
 if(!eq(verifiedRemoteCaller.agent,a.sender)||!eq(verifiedRemoteCaller.dna,installedDna)||verifiedRemoteCaller.operation!=='role_delivery_v1')throw Error('verified remote caller mismatch');
 if(!Number.isInteger(a.seat)||a.seat<0||!eq(commitState.seats?.[a.seat],localAgent))throw Error('seat mismatch');
 if(!eq(cellKey?.dna,installedDna)||!eq(cellKey?.agent,localAgent)||!eq(cellKey?.keyId,a.keyId)||!Number.isSafeInteger(cellKey?.epoch)||cellKey.epoch<1||cellKey.epoch!==cellKey?.attestation?.epoch)throw Error('recipient key substitution or rotation');
 if(a.keyEpoch!==cellKey.epoch)throw Error('recipient key epoch mismatch');
 if(!eq(cellKey?.publicKey,cellKey.attestation.publicKey))throw Error('recipient key/attestation mismatch');
 await verifyKeyAttestation(cellKey.attestation,{dna:installedDna,agent:localAgent,minEpoch:cellKey.epoch,now});
 if(a.inReplyTo!==null&&a.inReplyTo!==undefined&&(!expectedReplyTo||!eq(a.inReplyTo,expectedReplyTo)))throw Error('unsolicited reply correlation');
 fresh(a,now);roleTranscript(a);
 if(!await verify(a.signature,a.sender,roleTranscript(a)))throw Error('forged role sender');
 await ledger.reserve({dna:a.dna,recipient:a.recipient,sender:a.sender,commit:a.commit,messageId:a.messageId});
 const plaintext=await openForCell(cellKey,a.enc,a.ciphertext,aadBytes(a),HPKE_INFO);
 if(!await verifyRoleProof({plaintext,seat:a.seat,commit:commitState}))throw Error('invalid role proof');
 return plaintext;
}
export const internalsForTests={keyTranscript,roleHeader,deliveryHeader:roleHeader,aadBytes,roleTranscript,deliveryTranscript:roleTranscript,verify,eq,fromB64,rawHash,toWireHash,fresh};
