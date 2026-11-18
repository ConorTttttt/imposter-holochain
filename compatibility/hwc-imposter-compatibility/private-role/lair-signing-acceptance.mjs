/**
 * Executes the pinned HWC workspace's GENUINE @holo-host/lair client.
 * Synthetic live-Lair test identities, native-typed HoloHashes, no private keys archived.
 * Proves Ed25519 transcript signing, NOT installed-hApp native state or a receiver.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createRecipientKey,rawPublicKey,openForCell} from './hpke.mjs';
import {attestKey,verifyKeyAttestation,makeRoleDelivery,internalsForTests,HPKE_INFO} from './wire.mjs';
const requireFromHwc=createRequire(resolve('hwc/package.json'));
const {createLairClient,MemoryKeyStorage}=await import(pathToFileURL(resolve('hwc/packages/lair/dist/index.js')).href);
const {hashFrom32AndType,HoloHashType}=await import(pathToFileURL(requireFromHwc.resolve('@holochain/client')).href);
const fixture=JSON.parse((await import('node:fs')).readFileSync(new URL('./native-role-vectors.json',import.meta.url),'utf8'));
const typed=(core,kind)=>new Uint8Array(hashFrom32AndType(core,kind));
const decodeHash=s=>new Uint8Array(Buffer.from(s.slice(1).replace(/-/g,'+').replace(/_/g,'/'),'base64'));
const cellDna=decodeHash(fixture.dna);
const commit=decodeHash(fixture.commit);
const lair=await createLairClient(new MemoryKeyStorage());
const host=await lair.newSeed('host-live-lair-role-test',false);
const guest=await lair.newSeed('guest-live-lair-role-test',false);
const foreign=await lair.newSeed('foreign-live-lair-role-test',false);
const hostId=typed(host.entry_info.ed25519_pub_key,HoloHashType.Agent);
const guestId=typed(guest.entry_info.ed25519_pub_key,HoloHashType.Agent);
const foreignId=typed(foreign.entry_info.ed25519_pub_key,HoloHashType.Agent);
const sign=(pub,data)=>lair.signByPubKey(pub,data);
const {privateKey,publicKey}=await createRecipientKey();
assert.equal(privateKey.extractable,false);
const rolePublic=await rawPublicKey(publicKey);
const now=Date.now();
const attestation=await attestKey({dna:cellDna,agent:guestId,epoch:1,publicKey:rolePublic,sign,now});
assert.equal(await verifyKeyAttestation(attestation,{dna:cellDna,agent:guestId,now}),true);
await assert.rejects(verifyKeyAttestation(attestation,{dna:cellDna,agent:hostId,now}),/cell/);
await assert.rejects(verifyKeyAttestation(attestation,{dna:cellDna,agent:guestId,minEpoch:2,now}),/old key/);
await assert.rejects(verifyKeyAttestation({...attestation,publicKey:new Uint8Array(32)},{dna:cellDna,agent:guestId,now}),/forged/);
await assert.rejects(attestKey({dna:cellDna,agent:guestId,epoch:1,publicKey:rolePublic,sign:async(_pub,data)=>lair.signByPubKey(host.entry_info.ed25519_pub_key,data),now}),/Lair signer identity/);
const payload=new TextEncoder().encode('not-a-live-game-role');
const signed=await makeRoleDelivery({dna:cellDna,sender:hostId,recipient:guestId,commit,seat:1,attestation,roleBytes:payload,sign,now});
assert.equal(await internalsForTests.verify(signed.signature,signed.sender,internalsForTests.roleTranscript(signed)),true);
assert.deepEqual(await openForCell({privateKey,publicKey:rolePublic},signed.enc,signed.ciphertext,internalsForTests.aadBytes(signed),HPKE_INFO),payload);
await assert.rejects(openForCell({privateKey,publicKey:rolePublic},signed.enc,signed.ciphertext,new Uint8Array([1]),HPKE_INFO));
assert.equal((await internalsForTests.verify(signed.signature,foreignId,internalsForTests.roleTranscript(signed))),false);
console.log('GENUINE_PINNED_HWC_LAIR_ROLE_SIGNING=PASS');
console.log('SIGNATURE_DOMAINS_KEY_ATTESTATION_AND_ROLE_DELIVERY=PASS');
console.log('NO_INSTALLED_GAME_CELL_OR_REMOTE_COORDINATOR_ACCEPTANCE');
