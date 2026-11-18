/** Fixed canonical transcript fixtures; NOT independent Holochain/Lair vectors. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {internalsForTests} from './wire.mjs';
const hash=(prefix,n)=>new Uint8Array([...prefix,...new Array(36).fill(n)]);
const digest=b=>createHash('sha256').update(b).digest('hex');
test('canonical key attestation v1 fixed-field transcript',()=>{
 const dna=hash([0x84,0x2d,0x24],1),agent=hash([0x84,0x20,0x24],2);
 const a={dna,agent,keyId:new Uint8Array(16).fill(3),epoch:1,createdAt:1700000000000,expiresAt:1700000120000,publicKey:new Uint8Array(32).fill(4)};
 const bytes=internalsForTests.keyTranscript(a);
 assert.equal(bytes.length,182);
 assert.equal(digest(bytes),'809ac8a578be2731201d8940b82ba6d367eefd1b27f3fb943e171f8d28561573');
});
test('canonical signed role-delivery v1 transcript binds all metadata plus ciphertext',()=>{
 const dna=hash([0x84,0x2d,0x24],1),agent=hash([0x84,0x20,0x24],2);
 const a={dna,sender:hash([0x84,0x20,0x24],5),recipient:agent,commit:hash([0x84,0x29,0x24],9),
 seat:1,keyId:new Uint8Array(16).fill(3),keyEpoch:1,messageId:new Uint8Array(16).fill(6),
 createdAt:1700000000000,expiresAt:1700000120000,enc:new Uint8Array(32).fill(7),ciphertext:new Uint8Array(24).fill(8)};
 const bytes=internalsForTests.deliveryTranscript(a);
 assert.equal(bytes.length,302);
 assert.equal(digest(bytes),'fca5e715a6e0b54c0718fb58e92d69f4c23df413d8df2188f903a914cb6ee375');
 assert.notEqual(digest(internalsForTests.deliveryTranscript({...a,seat:2})),digest(bytes));
});
