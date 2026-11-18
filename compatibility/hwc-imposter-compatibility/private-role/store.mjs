/** Extension-origin-only IndexedDB: per-(exact DNA, Lair agent) key and replay ledger.
 * No clearing on revocation, restart or reauthorization. */
import {createRecipientKey,rawPublicKey} from './hpke.mjs';
const hex=a=>{if(!(a instanceof Uint8Array))throw Error('byte array required');return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');};
const hash=(a,label)=>{if(!(a instanceof Uint8Array)||a.length!==39)throw Error(label+' must be full 39-byte hash');return hex(a);};
const key=x=>`${hash(x.dna,'dna')}:${hash(x.agent,'agent')}`;
const req=p=>new Promise((resolve,reject)=>{p.onsuccess=()=>resolve(p.result);p.onerror=()=>reject(p.error??Error('IndexedDB request failed'));});
const done=t=>new Promise((resolve,reject)=>{t.oncomplete=resolve;t.onabort=()=>reject(t.error??Error('IndexedDB transaction aborted'));t.onerror=()=>reject(t.error??Error('IndexedDB transaction failed'));});
export async function openRoleStore(name='hwc-imposter-private-role-v1'){
 if(typeof indexedDB==='undefined')throw Error('IndexedDB unavailable; private role transport disabled');
 const connection=indexedDB.open(name,1);
 connection.onupgradeneeded=()=>{const d=connection.result;d.createObjectStore('cells',{keyPath:'cell'});d.createObjectStore('replay',{keyPath:'id'});};
 const db=await req(connection);
 db.onversionchange=()=>db.close();
 return {
   close(){db.close();},
   async getCell(dna,agent){const t=db.transaction('cells','readonly'),v=await req(t.objectStore('cells').get(key({dna,agent})));return v??null;},
   async rotateCell(dna,agent,epoch){
     if(!Number.isSafeInteger(epoch)||epoch<1)throw Error('invalid epoch');
     const pair=await createRecipientKey();
     if(pair.privateKey.extractable)throw Error('exportable recipient secret refused');
     const publicKey=await rawPublicKey(pair.publicKey);
     const cell=key({dna,agent});
     const t=db.transaction('cells','readwrite',{durability:'strict'}),finished=done(t);
     const s=t.objectStore('cells');
     const previous=await req(s.get(cell));
     if(previous&&previous.epoch>=epoch){t.abort();try{await finished;}catch{}throw Error('non-monotonic key rotation');}
     const keyId=crypto.getRandomValues(new Uint8Array(16));
     const value={cell,dna,agent,epoch,keyId,publicKey,privateKey:pair.privateKey};
     s.put(value);
     await finished;
     return value;
   },
   async reserve({dna,recipient,sender,commit,messageId}){
     if(!(messageId instanceof Uint8Array)||messageId.length!==16)throw Error('invalid replay message id');
     // RoleCommit remains signed in the message but is deliberately NOT part of\n     // replay identity: the same message ID cannot be reused in another round.\n     hash(commit,'commit');\n     const id=[hash(dna,'dna'),hash(recipient,'recipient'),hash(sender,'sender'),hex(messageId)].join(':');
     const t=db.transaction('replay','readwrite',{durability:'strict'}),finished=done(t);
     try{t.objectStore('replay').add({id,receivedAt:Date.now()});await finished;}catch(e){try{t.abort();}catch{}try{await finished;}catch{}throw Error('role delivery replay or persistence failure');}
   },
 };
}
