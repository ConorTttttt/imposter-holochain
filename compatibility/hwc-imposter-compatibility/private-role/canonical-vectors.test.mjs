/** Canonical transcripts must match Agent 3 native Holochain 0.7 bytes, not synthetic fingerprints. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {internalsForTests,fromRoleFrame,WIRE_DOMAIN} from './wire.mjs';
const fixture=JSON.parse(readFileSync(new URL('./native-role-vectors.json',import.meta.url),'utf8'));
const hex=x=>Buffer.from(x).toString('hex');
test('native Holochain 0.7 fixed request and delivery transcripts, including optional reply',()=>{
 for(const c of fixture.cases){
  const packet=fromRoleFrame({type:c.operation,envelope:{
   version:1,domain:WIRE_DOMAIN,dna_hash:fixture.dna,sender_agent:fixture[c.sender],recipient_agent:fixture[c.recipient],
   role_commit:fixture.commit,seat:1,recipient_key_id:'11'.repeat(16),message_id:c.message_id,
   created_at_ms:1700000000000,expires_at_ms:1700000030000,in_reply_to:c.in_reply_to,hpke_enc:c.enc,ciphertext:c.ciphertext
  },signature:c.signature});
  assert.equal(hex(internalsForTests.deliveryTranscript(packet)),c.signed_bytes_hex);
  assert.equal(hex(internalsForTests.aadBytes(packet)),c.aad_hex);
 }
});
