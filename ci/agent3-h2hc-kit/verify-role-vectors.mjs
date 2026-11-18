#!/usr/bin/env node
// Independent Node 22 consumer of the PUBLIC synthetic HPKE/Rust vectors.
// Never runs inside HWC or receives real role leaves, bearer tokens or Lair keys.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHmac, createPrivateKey, createPublicKey, diffieHellman, createDecipheriv, verify} from 'node:crypto';

const fixturePath=process.argv[2];
const file=readFileSync(fixturePath,'utf8');
const unpack=p=>gunzipSync(Buffer.from(p.replace(/\\s/g,''),'base64'));
const raw=fixturePath.endsWith('.gz.base64')?unpack(file):Buffer.from(file,'utf8');
if(process.argv[3]) {
 const pinned=unpack(readFileSync(process.argv[3],'utf8'));
 assert(raw.equals(pinned),'committed fixture bytes differ from freshly generated native vectors');
}
const v=JSON.parse(raw.toString('utf8'));
assert.equal(v.version,1);
assert.equal(v.fixture_only,true);
assert.equal(v.status,'candidate-pending-agent2-approval');
assert.equal(v.cases.length,2);
assert.equal(v.key_attestations.length,2);
const buf=(hex)=>Buffer.from(hex,'hex');
const text=s=>Buffer.from(s,'utf8');
const cat=(...x)=>Buffer.concat(x);
const u16=n=>{assert(Number.isInteger(n)&&n>=0&&n<=65535);const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const u32=n=>{assert(Number.isInteger(n)&&n>=0&&n<=0xffffffff);const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const u64=n=>{assert(Number.isSafeInteger(n)&&n>=0);const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;};
const b64=s=>{const b=Buffer.from(s,'base64');assert.equal(b.toString('base64'),s,'canonical padded base64');return b;};
function hash(s,kind) {
 assert(s.startsWith('u'));
 const h=Buffer.from(s.slice(1),'base64url');
 assert.equal(h.length,39);
 assert.equal(h.toString('base64url'),s.slice(1));
 const prefixes={dna:[0x84,0x2d,0x24],agent:[0x84,0x20,0x24],action:[0x84,0x29,0x24]};
 assert(h.subarray(0,3).equals(Buffer.from(prefixes[kind])));
 return h;
}
function header(e,op) {
 assert.equal(e.version,1);assert.equal(e.domain,'imposter.h2hc.private-role.v1');
 assert(['role_request_v1','role_delivery_v1'].includes(op));
 assert(Number.isSafeInteger(e.recipient_key_epoch)&&e.recipient_key_epoch>=1);
 if(op==='role_request_v1')assert.equal(e.in_reply_to,null);
 assert.match(e.recipient_key_id,/^[a-f0-9]{32}$/);
 assert.match(e.message_id,/^[a-f0-9]{32}$/);
 const reply=e.in_reply_to===null?Buffer.from([0]):(assert.match(e.in_reply_to,/^[a-f0-9]{32}$/),cat(Buffer.from([1]),buf(e.in_reply_to)));
 return cat(Buffer.from([op==='role_request_v1'?1:2]),
    hash(e.dna_hash,'dna'),hash(e.sender_agent,'agent'),
    hash(e.recipient_agent,'agent'),hash(e.role_commit,'action'),
    u16(e.seat),buf(e.recipient_key_id),u64(e.recipient_key_epoch),
    buf(e.message_id),u64(e.created_at_ms),u64(e.expires_at_ms),reply);
}
const SIGN=text('IMPOSTER-H2HC-ROLE-SIGNED\0\x01');
const AAD=text('IMPOSTER-H2HC-ROLE-AAD\0\x01');
const INFO=text('imposter.h2hc.private-role/hpke-v1');
const KEM=cat(text('KEM'),u16(0x20));
const HPKE=cat(text('HPKE'),u16(0x20),u16(1),u16(2));
function signBytes(e,op) {
 const enc=b64(e.hpke_enc),ct=b64(e.ciphertext);
 assert.equal(enc.length,32);assert(ct.length>=16&&ct.length<=4096);
 return cat(SIGN,header(e,op),enc,u32(ct.length),ct);
}
function edKey(agent) {
 return createPublicKey({key:cat(buf('302a300506032b6570032100'),hash(agent,'agent').subarray(3,35)),type:'spki',format:'der'});
}
function mac(key,data){return createHmac('sha256',key).update(data).digest();}
function extract(salt,data){return mac(salt.length?salt:Buffer.alloc(32),data);}
function expand(prk,info,len){
 let result=Buffer.alloc(0),previous=Buffer.alloc(0);
 for(let i=1;result.length<len;i++){previous=mac(prk,cat(previous,info,Buffer.from([i])));result=cat(result,previous);}
 return result.subarray(0,len);
}
function lex(suite,salt,label,data){return extract(salt,cat(text('HPKE-v1'),suite,text(label),data));}
function lxp(suite,prk,label,data,len){return expand(prk,cat(u16(len),text('HPKE-v1'),suite,text(label),data),len);}
function hpkeKeyNonce(sk,enc,pk){
 const epk=createPublicKey({key:cat(buf('302a300506032b656e032100'),enc),type:'spki',format:'der'});
 const dh=diffieHellman({privateKey:sk,publicKey:epk});
 const eae=lex(KEM,Buffer.alloc(0),'eae_prk',dh);
 const shared=lxp(KEM,eae,'shared_secret',cat(enc,pk),32);
 const psk=lex(HPKE,Buffer.alloc(0),'psk_id_hash',Buffer.alloc(0));
 const ih=lex(HPKE,Buffer.alloc(0),'info_hash',INFO);
 const ctx=cat(Buffer.from([0]),psk,ih);
 const secret=lex(HPKE,shared,'secret',Buffer.alloc(0));
 return [lxp(HPKE,secret,'key',ctx,32),lxp(HPKE,secret,'base_nonce',ctx,12)];
}
function recipientKey(seed){
 return createPrivateKey({key:cat(buf('302e020100300506032b656e04220420'),Buffer.alloc(32,seed)),type:'pkcs8',format:'der'});
}
function decrypt(key,enc,ciphertext,aad,pk){
 const [aes,nonce]=hpkeKeyNonce(key,enc,pk);
 const dec=createDecipheriv('aes-256-gcm',aes,nonce);
 dec.setAAD(aad);dec.setAuthTag(ciphertext.subarray(-16));
 return cat(dec.update(ciphertext.subarray(0,-16)),dec.final());
}
for(const [i,c] of v.cases.entries()){
 const {envelope:e,operation:op}=c;
 const signed=signBytes(e,op),associated=cat(AAD,header(e,op));
 assert.equal(signed.toString('hex'),c.signed_bytes_hex);
 assert.equal(header(e,op).toString('hex'),c.header_hex);
 assert.equal(associated.toString('hex'),c.aad_hex);
 assert.equal(INFO.toString('hex'),c.hpke_info_hex);
 assert.equal(b64(e.hpke_enc).toString('hex'),c.hpke_enc_hex);
 assert.equal(b64(e.ciphertext).toString('hex'),c.ciphertext_hex);
 const sig=b64(c.signature_b64);
 assert.equal(sig.toString('hex'),c.signature_hex);
 assert(verify(null,signed,edKey(e.sender_agent),sig),'Ed25519 signed transcript');
 const keyAtt=v.key_attestations[i],pk=b64(keyAtt.x25519_public_key_b64);
 const att=cat(text('IMPOSTER-H2HC-ROLE-KEY\0\x01'),
   hash(keyAtt.dna_hash,'dna'),hash(keyAtt.agent,'agent'),
   buf(keyAtt.key_id),pk,u64(keyAtt.epoch),u64(keyAtt.not_before_ms),u64(keyAtt.not_after_ms));
 assert.equal(att.toString('hex'),keyAtt.signed_bytes_hex);
 assert.equal(keyAtt.epoch,e.recipient_key_epoch);
 assert.equal(keyAtt.key_id,e.recipient_key_id);
 assert(keyAtt.agent===e.recipient_agent);
 assert.equal(b64(keyAtt.signature_b64).toString('hex'),keyAtt.signature_hex);
 assert(verify(null,att,edKey(keyAtt.agent),b64(keyAtt.signature_b64)));
 const sk=recipientKey(i===0?51:52);
 const localPub=createPublicKey(sk).export({format:'der',type:'spki'}).subarray(-32);
 assert(localPub.equals(pk),'native recipient X25519 public key');
 const ct=b64(e.ciphertext),enc=b64(e.hpke_enc);
 assert.equal(decrypt(sk,enc,ct,associated,pk).toString(),'synthetic-not-a-game-role');
 assert.throws(()=>decrypt(sk,enc,ct,cat(associated,Buffer.from('!')),pk));
 const foreign=recipientKey(99);
 assert.throws(()=>decrypt(foreign,enc,ct,associated,pk));
 const epoch={...e,recipient_key_epoch:e.recipient_key_epoch+1};
 assert.equal(verify(null,signBytes(epoch,op),edKey(e.sender_agent),sig),false);
 if(i===0)assert.equal(e.in_reply_to,null);
 if(i===1)assert.equal(e.in_reply_to,v.cases[0].envelope.message_id);
}
for(const n of v.negative_cases){
 const c=v.cases[n.case],op=c.operation,e={...c.envelope};
 let signature=c.signature_b64;
 for(const [path,value] of Object.entries(n.mutate)){
   if(path==='signature_b64')signature=value;
   else {assert(path.startsWith('envelope.'));e[path.slice(9)]=value;}
 }
 let rejected=false;
 try{const transcript=signBytes(e,op);rejected=!verify(null,transcript,edKey(e.sender_agent),b64(signature));}
 catch{rejected=true;}
 // For receiver-level mismatched request id a newly re-signed envelope would
 // still route: durable HWC request-correlation checks remain independently required.
 assert(rejected,'synthetic mutant MUST fail original signature: '+n.name);
}
console.log('ROLE_NODE_CROSS_LANGUAGE_VECTORS=PASS; HWC_LAIR_RECEIVER=NOT_TESTED');
