/** Agent 3 native Holochain 0.7 signed bytes + independent RFC9180 Python vectors.
 * Source: CI run 44299128149 artifact 14424762920. Historical TEST DATA only.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {seal,openForCell} from './hpke.mjs';
import {verifyKeyAttestation,internalsForTests,fromRoleFrame,toRoleFrame,WIRE_DOMAIN,HPKE_INFO} from './wire.mjs';
import {nativeFixture as fixture} from './native-fixture.mjs';
const hex=b=>Buffer.from(b).toString('hex');
const unhex=s=>Uint8Array.from(Buffer.from(s,'hex'));
const b64=s=>Uint8Array.from(Buffer.from(s,'base64'));
const fromHash=s=>Uint8Array.from(Buffer.from(s.slice(1).replace(/-/g,'+').replace(/_/g,'/'),'base64'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const clear=new TextEncoder().encode('synthetic-not-a-game-role');
const standardFrame=c=>({type:c.operation,envelope:{
 version:1,domain:WIRE_DOMAIN,dna_hash:fixture.dna,sender_agent:fixture[c.sender],recipient_agent:fixture[c.recipient],
 role_commit:fixture.commit,seat:1,recipient_key_id:c.key_id,recipient_key_epoch:c.epoch,message_id:c.message_id,
 created_at_ms:1700000000000,expires_at_ms:1700000030000,in_reply_to:c.in_reply_to,
 hpke_enc:c.enc,ciphertext:c.ciphertext},signature:c.signature});
const pkcs8=(prefix,seed)=>Buffer.concat([Buffer.from(prefix,'hex'),Buffer.alloc(32,seed)]);
const x25519Pair=async seed=>{
 const privateKey=await crypto.subtle.importKey('pkcs8',pkcs8('302e020100300506032b656e04220420',seed),'X25519',false,['deriveBits']);
 const publicKey=await crypto.subtle.importKey('raw',await (async()=>{
  // Derive fixture public key using node crypto for independent fixture setup.
  const {createPrivateKey,createPublicKey}=await import('node:crypto');
  return createPublicKey(createPrivateKey({key:pkcs8('302e020100300506032b656e04220420',seed),format:'der',type:'pkcs8'}))
   .export({format:'der',type:'spki'}).subarray(-32);
 })(),'X25519',true,[]);
 return {privateKey,publicKey};
};
test('both native Holochain role request/delivery preimages, AAD, and exact Ed25519 signatures',async()=>{
 for(const c of fixture.cases){
  const packet=fromRoleFrame(standardFrame(c));
  assert.equal(hex(internalsForTests.roleTranscript(packet)),c.signed_bytes_hex,'signed bytes mismatch');
  assert.equal(hex(internalsForTests.aadBytes(packet)),c.aad_hex,'HPKE AAD mismatch');
  assert.deepEqual(toRoleFrame(packet),standardFrame(c),'wire JSON field agreement');
  assert.equal(await internalsForTests.verify(packet.signature,packet.sender,internalsForTests.roleTranscript(packet)),true);
  const {createPrivateKey,sign}=await import('node:crypto');
  const edseed=c.sender==='host'?27:28;
  const signed=sign(null,Buffer.from(internalsForTests.roleTranscript(packet)),createPrivateKey({
   key:pkcs8('302e020100300506032b657004220420',edseed),format:'der',type:'pkcs8'}));
  assert.equal(signed.toString('base64'),c.signature,'Ed25519 fixture signature bytes');
  const changed={...packet,operation:c.operation==='role_request_v1'?'role_delivery_v1':'role_request_v1',inReplyTo:null};
  assert.equal(await internalsForTests.verify(packet.signature,packet.sender,internalsForTests.roleTranscript(changed)),false,'operation substitution accepted');
  assert.equal(await internalsForTests.verify(new Uint8Array(64),packet.sender,internalsForTests.roleTranscript(packet)),false);
  assert.notEqual(sha(internalsForTests.roleTranscript({...packet,seat:2})),sha(internalsForTests.roleTranscript(packet)));
  assert.equal(await internalsForTests.verify(packet.signature,packet.sender,internalsForTests.roleTranscript({...packet,keyEpoch:packet.keyEpoch+1})),false,'signed recipient epoch substitution accepted');
  assert.throws(()=>fromRoleFrame({...standardFrame(c),envelope:{...standardFrame(c).envelope,dna_hash:fixture.guest}}),/dna HoloHash prefix/);
  assert.throws(()=>fromRoleFrame({...standardFrame(c),envelope:{...standardFrame(c).envelope,domain:'imposter-hwc/v1'}}),/domain/);
 }
});
test('two native Holochain signed recipient-key attestations, epoch/DNA/expiry rejection',async()=>{
 for(const a of fixture.attestations){
  const att={dna:fromHash(fixture.dna),agent:fromHash(fixture[a.agent]),keyId:Uint8Array.from(Buffer.from(a.key_id,'hex')),
   publicKey:b64(a.recipientPublicKey),epoch:a.epoch,notBefore:1699999000000,notAfter:1700000099999,signature:b64(a.signature)};
  assert.equal(hex(internalsForTests.keyTranscript(att)),a.signed_bytes_hex,'key field order');
  assert.equal(await verifyKeyAttestation(att,{dna:att.dna,agent:att.agent,now:1700000000000}),true,'native attestation Ed25519');
  await assert.rejects(verifyKeyAttestation(att,{dna:att.dna,agent:att.agent,now:Date.now()}),/expired/);
  await assert.rejects(verifyKeyAttestation(att,{dna:att.dna,agent:att.agent,minEpoch:a.epoch+1,now:1700000000000}),/old key epoch/);
  await assert.rejects(verifyKeyAttestation(att,{dna:fromHash(fixture.dna),agent:fromHash(fixture[a.agent==='host'?'guest':'host']),now:1700000000000}),/wrong attested cell/);
  await assert.rejects(verifyKeyAttestation({...att,publicKey:Uint8Array.from(att.publicKey,(v,i)=>i===0?v^1:v)},{dna:att.dna,agent:att.agent,now:1700000000000}),/forged/);
  await assert.rejects(verifyKeyAttestation({...att,epoch:a.epoch+1},{dna:att.dna,agent:att.agent,now:1700000000000}),/forged/);
 }
});
test('byte-for-byte native HPKE encapsulation, ciphertext, plaintext and AAD',async()=>{
 assert.equal(hex(HPKE_INFO),hex(new TextEncoder().encode('imposter.h2hc.private-role/hpke-v1')));
 for(const c of fixture.cases){
  const packet=fromRoleFrame(standardFrame(c));
  const recipient=await x25519Pair(c.recipientSeed);
  const ephemeral=await x25519Pair(c.ephemeralSeed);
  const pub=new Uint8Array(await crypto.subtle.exportKey('raw',recipient.publicKey));
  assert.equal(Buffer.from(pub).toString('base64'),c.recipientPublicKey);
  const expected=await seal(pub,clear,internalsForTests.aadBytes(packet),HPKE_INFO,ephemeral);
  assert.equal(Buffer.from(expected.enc).toString('base64'),c.enc,'HPKE enc mismatch');
  assert.equal(Buffer.from(expected.ciphertext).toString('base64'),c.ciphertext,'HPKE ciphertext mismatch');
  const decrypted=await openForCell({privateKey:recipient.privateKey,publicKey:pub},packet.enc,packet.ciphertext,internalsForTests.aadBytes(packet),HPKE_INFO);
  assert.deepEqual(decrypted,clear);
  assert.equal(sha(decrypted),'5d4ac174de32e763c76fb0ef37e14810770fd8a31e8efc94f00bb97c9b30b68f');
  const foreign=await x25519Pair(c.recipientSeed+1);
  const foreignPub=new Uint8Array(await crypto.subtle.exportKey('raw',foreign.publicKey));
  await assert.rejects(openForCell({privateKey:foreign.privateKey,publicKey:foreignPub},packet.enc,packet.ciphertext,internalsForTests.aadBytes(packet),HPKE_INFO));
  await assert.rejects(openForCell({privateKey:recipient.privateKey,publicKey:pub},packet.enc,packet.ciphertext,new Uint8Array([1]),HPKE_INFO));
 }
});
test('wire limits, timestamp windows and malformed reply/IDs fail closed',()=>{
 const c=fixture.cases[1],f=standardFrame(c),valid=fromRoleFrame(f);
 assert.throws(()=>fromRoleFrame({...f,envelope:{...f.envelope,recipient_key_id:'AA'.repeat(16)}}),/key ID/);
 assert.throws(()=>fromRoleFrame({...f,envelope:{...f.envelope,hpke_enc:f.envelope.hpke_enc.replace(/=$/,'A')}}),/base64|enc length/);
 assert.throws(()=>fromRoleFrame({...f,envelope:{...f.envelope,in_reply_to:'bad'}}),/in_reply_to/);
 assert.throws(()=>fromRoleFrame({...f,envelope:{...f.envelope,seat:65536}}),/u16/);
 assert.throws(()=>fromRoleFrame({...f,envelope:{...f.envelope,recipient_key_epoch:0}}),/epoch/);
 assert.throws(()=>fromRoleFrame({...f,envelope:{...f.envelope,recipient_key_epoch:Number.MAX_SAFE_INTEGER+1}}),/epoch/);
 assert.throws(()=>internalsForTests.fresh({...valid,expiresAt:valid.createdAt+60001},valid.createdAt),/stale/);
 assert.throws(()=>internalsForTests.fresh({...valid,createdAt:valid.createdAt+30001},valid.createdAt),/stale/);
 assert.throws(()=>internalsForTests.fresh(valid,Date.now()),/stale/,'historical fixture must not be live');
});

test('all nine Agent 3 declarative negative-vector mutations fail closed',async()=>{
 for(const negative of fixture.negative_cases){
  const source=fixture.cases[negative.case];
  const frame=standardFrame(source),mut=negative.mutate;
  for(const [field,value] of Object.entries(mut)){
   if(field.startsWith('envelope.'))frame.envelope[field.slice('envelope.'.length)]=value;
   else frame[field]=value;
  }
  let parsed;
  try{parsed=fromRoleFrame(frame);}
  catch{continue;} // Parsing rejection is sufficient for structurally invalid frames.
  if(negative.name==='expired_envelope'){
   assert.throws(()=>internalsForTests.fresh(parsed,1700000000000),/stale/);
   continue;
  }
  assert.equal(await internalsForTests.verify(parsed.signature,parsed.sender,internalsForTests.roleTranscript(parsed)),false,negative.name);
 }
});
