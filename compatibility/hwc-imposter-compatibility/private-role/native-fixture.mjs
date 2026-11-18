/** Exact published Agent 3 revision-2 fixture, gzip+base64 copied verbatim from
 * ci/agent3-h2hc-kit/fixtures/role-public-vectors-v1-candidate.json.gz.base64
 * commit 8c1bedbb2bec78ac0d404ce54c67ce54691ffc8d.
 * Cross-checked against successful native Rust CI 44304051978 artifact 14426467954.
 * Historical deterministic test data only; never a live recipient attestation.
 */
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const source=readFileSync(new URL('./agent3-role-public-vectors-v1-candidate.json.gz.base64',import.meta.url),'utf8').replace(/\s/g,'');
const raw=JSON.parse(gunzipSync(Buffer.from(source,'base64')).toString('utf8'));
if(raw.fixture_only!==true||raw.version!==1||raw.cases?.length!==2||raw.key_attestations?.length!==2||raw.negative_cases?.length!==9)throw Error('unexpected Agent 3 fixture');
const [request,delivery]=raw.cases;
if(request.operation!=='role_request_v1'||delivery.operation!=='role_delivery_v1')throw Error('unexpected Agent 3 operations');
const host=delivery.envelope.sender_agent,guest=request.envelope.sender_agent;
const normCase=(x,recipientSeed,ephemeralSeed)=>({
 ...x, sender:x.envelope.sender_agent===host?'host':'guest',
 recipient:x.envelope.recipient_agent===host?'host':'guest',
 recipientSeed,ephemeralSeed,message_id:x.envelope.message_id,in_reply_to:x.envelope.in_reply_to,
 key_id:x.envelope.recipient_key_id,epoch:x.envelope.recipient_key_epoch,
 enc:x.envelope.hpke_enc,ciphertext:x.envelope.ciphertext,signature:x.signature_b64,
 recipientPublicKey:x.recipient_hpke_pk_b64
});
const normAtt=x=>({
 ...x,agent:x.agent===host?'host':'guest',recipientPublicKey:x.x25519_public_key_b64,
 signature:x.signature_b64
});
export const officialFixture=raw;
export const nativeFixture={
 version:1,fixture_only:true,dna:request.envelope.dna_hash,host,guest,commit:request.envelope.role_commit,
 cases:[normCase(request,51,61),normCase(delivery,52,62)],
 attestations:raw.key_attestations.map(normAtt),negative_cases:raw.negative_cases
};
