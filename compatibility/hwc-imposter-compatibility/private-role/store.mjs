/** Extension-origin-only IndexedDB: per-(exact DNA, Lair agent) key and replay ledger.
 * No clearing on revocation, restart or reauthorization. */
import {createRecipientKey,rawPublicKey} from './hpke.mjs';
import {verifyKeyAttestation} from './wire.mjs';
const hex=a=>{if(!(a instanceof Uint8Array))throw Error('byte array required');return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');};
const hash=(a,label)=>{if(!(a instanceof Uint8Array)||a.length!==39)throw Error(label+' must be full 39-byte hash');return hex(a);};
const key=x=>`${hash(x.dna,'dna')}:${hash(x.agent,'agent')}`;
const req=p=>new Promise((resolve,reject)=>{p.onsuccess=()=>resolve(p.result);p.onerror=()=>reject(p.error??Error('IndexedDB request failed'));});
const done=t=>new Promise((resolve,reject)=>{t.oncomplete=resolve;t.onabort=()=>reject(t.error??Error('IndexedDB transaction aborted'));t.onerror=()=>reject(t.error??Error('IndexedDB transaction failed'));});
export async function openRoleStore(name='hwc-imposter-private-role-v1'){
 if(typeof indexedDB==='undefined')throw Error('IndexedDB unavailable; private role transport disabled');
 const connection=indexedDB.open(name,2);
 connection.onupgradeneeded=()=>{const d=connection.result;if(!d.objectStoreNames.contains('cells'))d.createObjectStore('cells',{keyPath:'cell'});if(!d.objectStoreNames.contains('replay'))d.createObjectStore('replay',{keyPath:'id'});if(!d.objectStoreNames.contains('trusted'))d.createObjectStore('trusted',{keyPath:'cell'});};
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
     if((previous&&previous.epoch+1!==epoch)||(!previous&&epoch!==1)){t.abort();try{await finished;}catch{}throw Error('non-monotonic or skipped key rotation');}
     const keyId=crypto.getRandomValues(new Uint8Array(16));
     const value={cell,dna,agent,epoch,keyId,publicKey,privateKey:pair.privateKey};
     s.put(value);
     await finished;
     return value;
   },
   /** Persist actual Lair-signed attestation only for the currently held
    * private key and exact installed cell. Rotation invalidates older attestations.
    * Does not publish, expose secrets, or establish remote-key discovery.
    */
   async installCellAttestation(dna,agent,attestation,{now=Date.now()}={}){
     await verifyKeyAttestation(attestation,{dna,agent,now});
     const cell=key({dna,agent});
     const t=db.transaction('cells','readwrite',{durability:'strict'}),finished=done(t);
     const s=t.objectStore('cells'),stored=await req(s.get(cell));
     const equal=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
     if(!stored||stored.epoch!==attestation.epoch||!equal(stored.keyId,attestation.keyId)||!equal(stored.publicKey,attestation.publicKey)||!stored.privateKey||stored.privateKey.extractable){
       t.abort();try{await finished;}catch{}throw Error('signed attestation does not match current non-extractable cell key');
     }
     if(stored.attestation &&
       (attestation.notBefore<stored.attestation.notBefore||
        attestation.notAfter<stored.attestation.notAfter)){
       t.abort();try{await finished;}catch{}
       throw Error('installed key attestation validity rollback');
     }
     s.put({...stored,attestation});await finished;
     return true;
   },
   /** Only call with enrollment independently obtained and validated by the
    * extension's native DHT authority. A signature alone is NOT enrollment.
    * No page listener, unsigned H2HC lookup, or Boolean validation shortcut
    * may reach this method. Watermarks survive browser restart/revocation.
    */
   async pinTrustedRecipient(dna,agent,attestation,{now=Date.now()}={}){
     await verifyKeyAttestation(attestation,{dna,agent,now});
     const cell=key({dna,agent});
     const t=db.transaction('trusted','readwrite',{durability:'strict'}),finished=done(t),s=t.objectStore('trusted');
     const prior=await req(s.get(cell));
     const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
     if(prior&&(attestation.epoch<prior.epoch||
       attestation.epoch>prior.epoch+1||
       (attestation.epoch===prior.epoch&&
         (prior.revoked||!eq(attestation.keyId,prior.keyId)||
          !eq(attestation.publicKey,prior.publicKey)||
          attestation.notBefore<prior.attestation.notBefore||
          attestation.notAfter<prior.attestation.notAfter)))){
       t.abort();try{await finished;}catch{}throw Error('trusted recipient rollback, equivocation or revoked epoch');
     }
     s.put({cell,epoch:attestation.epoch,keyId:attestation.keyId,publicKey:attestation.publicKey,attestation,revoked:false});
     await finished;
     return true;
   },
   /** Check validity afresh: an expired public attestation cannot be used to encrypt. */
   async getTrustedRecipient(dna,agent,{now=Date.now()}={}){
     const t=db.transaction('trusted','readonly'),record=await req(t.objectStore('trusted').get(key({dna,agent})));
     if(!record||record.revoked)throw Error('no current trusted recipient enrollment');
     await verifyKeyAttestation(record.attestation,{dna,agent,minEpoch:record.epoch,now});
     return record.attestation;
   },
   /** Keep the old epoch watermark even after a transport revocation. */
   async revokeTrustedRecipient(dna,agent){
     const cell=key({dna,agent});
     const t=db.transaction('trusted','readwrite',{durability:'strict'}),finished=done(t),s=t.objectStore('trusted'),old=await req(s.get(cell));
     if(old)s.put({...old,revoked:true});
     await finished;
   },
   async reserve({dna,recipient,sender,commit,messageId}){
     if(!(messageId instanceof Uint8Array)||messageId.length!==16)throw Error('invalid replay message id');
     // RoleCommit is independently signed. Reused IDs across rounds must fail.
     hash(commit,'commit');
     const id=[hash(dna,'dna'),hash(recipient,'recipient'),hash(sender,'sender'),hex(messageId)].join(':');
     const t=db.transaction('replay','readwrite',{durability:'strict'}),finished=done(t);
     try{t.objectStore('replay').add({id,receivedAt:Date.now()});await finished;}catch(e){try{t.abort();}catch{}try{await finished;}catch{}throw Error('role delivery replay or persistence failure');}
   },
 };
}
