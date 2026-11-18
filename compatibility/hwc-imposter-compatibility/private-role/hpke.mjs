/** RFC 9180 HPKE Base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
 * One-shot seq=0 only. WebCrypto primitives; NOT independently audited.
 * Keep disabled in product until Agent 3's native vectors are accepted. */
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...items) => { const out=new Uint8Array(items.reduce((n,a)=>n+a.length,0)); let o=0; for(const a of items){out.set(a,o);o+=a.length;}return out; };
const n2 = (n) => new Uint8Array([(n>>8)&255,n&255]);
const KEM=concat(utf8('KEM'),n2(0x20));
const SUITE=concat(utf8('HPKE'),n2(0x20),n2(1),n2(2));
const subtle=()=>{if(!globalThis.crypto?.subtle)throw Error('WebCrypto unavailable');return crypto.subtle;};
async function mac(key,data){const k=await subtle().importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await subtle().sign('HMAC',k,data));}
async function extract(salt,ikm){return mac(salt.length?salt:new Uint8Array(32),ikm);}
async function expand(prk,info,length){if(!Number.isInteger(length)||length<0||length>255*32)throw Error('HKDF length');let out=new Uint8Array(0), prev=new Uint8Array(0);for(let i=1;out.length<length;i++){prev=await mac(prk,concat(prev,info,new Uint8Array([i])));out=concat(out,prev);}return out.slice(0,length);}
function lbl(suite,label,data){return concat(utf8('HPKE-v1'),suite,utf8(label),data);}
const lex=(salt,suite,label,data)=>extract(salt,lbl(suite,label,data));
const lexp=(prk,suite,label,info,length)=>expand(prk,concat(n2(length),lbl(suite,label,info)),length);
async function schedule(shared,info){const p=await lex(new Uint8Array(0),SUITE,'psk_id_hash',new Uint8Array(0));const h=await lex(new Uint8Array(0),SUITE,'info_hash',info);const ctx=concat(new Uint8Array([0]),p,h);const secret=await lex(shared,SUITE,'secret',new Uint8Array(0));return { key:await lexp(secret,SUITE,'key',ctx,32),nonce:await lexp(secret,SUITE,'base_nonce',ctx,12) };}
async function sharedSecret(dh,enc,pub){const prk=await lex(new Uint8Array(0),KEM,'eae_prk',dh);return lexp(prk,KEM,'shared_secret',concat(enc,pub),32);}
function raw32(b){if(!(b instanceof Uint8Array)||b.length!==32)throw Error('expected 32 bytes');return b;}
export async function createRecipientKey(){return subtle().generateKey('X25519',false,['deriveBits']);}
export async function rawPublicKey(publicKey){return raw32(new Uint8Array(await subtle().exportKey('raw',publicKey)));}
export async function seal(recipientPublicKey,plaintext,aad,info=new Uint8Array(0)){
  raw32(recipientPublicKey);
  if(!(plaintext instanceof Uint8Array)||!(aad instanceof Uint8Array)||!(info instanceof Uint8Array))throw Error('bytes required');
  const ephemeral=await createRecipientKey();const enc=await rawPublicKey(ephemeral.publicKey);
  const pub=await subtle().importKey('raw',recipientPublicKey,'X25519',false,[]);
  const dh=new Uint8Array(await subtle().deriveBits({name:'X25519',public:pub},ephemeral.privateKey,256));
  const s=await sharedSecret(dh,enc,recipientPublicKey);const {key,nonce}=await schedule(s,info);
  const k=await subtle().importKey('raw',key,'AES-GCM',false,['encrypt']);
  const ciphertext=new Uint8Array(await subtle().encrypt({name:'AES-GCM',iv:nonce,additionalData:aad,tagLength:128},k,plaintext));
  return {enc,ciphertext};
}
export async function openForCell(cellKey,enc,ciphertext,aad,info=new Uint8Array(0)){
  raw32(cellKey.publicKey);raw32(enc);
  if(!cellKey.privateKey||cellKey.privateKey.type!=='private'||cellKey.privateKey.extractable||cellKey.privateKey.algorithm?.name!=='X25519')throw Error('invalid recipient private key');
  const ephemeral=await subtle().importKey('raw',enc,'X25519',false,[]);
  const dh=new Uint8Array(await subtle().deriveBits({name:'X25519',public:ephemeral},cellKey.privateKey,256));
  const s=await sharedSecret(dh,enc,cellKey.publicKey);const {key,nonce}=await schedule(s,info);
  const k=await subtle().importKey('raw',key,'AES-GCM',false,['decrypt']);
  return new Uint8Array(await subtle().decrypt({name:'AES-GCM',iv:nonce,additionalData:aad,tagLength:128},k,ciphertext));
}
