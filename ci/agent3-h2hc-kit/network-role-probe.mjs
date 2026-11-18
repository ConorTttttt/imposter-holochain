// CI-only three independent signed identities. No real roles or private keys logged.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPrivateKey, sign, randomBytes} from 'node:crypto';
const f=JSON.parse(readFileSync(process.env.H2HC_FIXTURE_FILE,'utf8'));
const [A,B,C]=f.agents,base=process.env.H2HC_BASE_URL,secret=process.env.H2HC_LINKER_ADMIN_SECRET;
function priv(i){return createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(i.seed_hex,'hex')]),format:'der',type:'pkcs8'});}
function signIt(i,buf){return sign(null,buf,priv(i)).toString('base64');}
function hash(s){const b=Buffer.from(s.slice(1),'base64url');assert.equal(b.length,39);return b;}
function n16(n){const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;}
function n32(n){const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;}
function n64(n){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;}
const prefix=Buffer.from('IMPOSTER-H2HC-ROLE-SIGNED\0\x01','binary');
function bytes(e,operation){
 const ct=Buffer.from(e.ciphertext,'base64');
 return Buffer.concat([prefix,Buffer.from([operation==='role_request_v1'?1:2]),hash(e.dna_hash),
  hash(e.sender_agent),hash(e.recipient_agent),hash(e.role_commit),n16(e.seat),
  Buffer.from(e.recipient_key_id,'hex'),Buffer.from(e.message_id,'hex'),
  n64(e.created_at_ms),n64(e.expires_at_ms),Buffer.from([0]),
  Buffer.from(e.hpke_enc,'base64'),n32(ct.length),ct]);
}
function frame(op,from,to,overrides={}){
 const now=Date.now();
 const e={version:1,domain:'imposter.h2hc.private-role.v1',dna_hash:f.dna,
   sender_agent:from.agent,recipient_agent:to.agent,role_commit:A.action_hash,
   seat:1,recipient_key_id:'11111111111111111111111111111111',
   message_id:randomBytes(16).toString('hex'),created_at_ms:now,expires_at_ms:now+30000,
   in_reply_to:null,hpke_enc:randomBytes(32).toString('base64'),
   ciphertext:randomBytes(64).toString('base64'),...overrides};
 return {type:op,envelope:e,signature:signIt(from,bytes(e,op))};
}
async function admin(method,body){
 const res=await fetch(base+'/admin/agents',{method,headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal(res.status,204);
}
async function socket(info){
 return new Promise((ok,bad)=>{
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws'),messages=[];let pending,closed=false;
  const timer=setTimeout(()=>bad(Error('socket timeout')),10000);
  const p={send:x=>ws.send(JSON.stringify(x)),close:()=>ws.close(),closed:()=>closed,
   closedPromise:()=>closed?Promise.resolve():new Promise(yes=>ws.addEventListener('close',yes,{once:true})),
   next:async (types,ms=10000)=>{
    types=Array.isArray(types)?types:[types];
    const idx=messages.findIndex(x=>types.includes(x.type));
    if(idx>=0)return messages.splice(idx,1)[0];
    assert(!pending);
    return new Promise((yes,no)=>{const t=setTimeout(()=>{pending=null;no(Error('response timeout'))},ms);
      pending={types,yes:x=>{clearTimeout(t);yes(x)}};});
   }};
  ws.addEventListener('open',()=>{clearTimeout(timer);ok(p)});
  ws.addEventListener('close',()=>{closed=true});
  ws.addEventListener('message',evt=>{
    const m=JSON.parse(String(evt.data));
    if(m.type==='sign_agent_info'){
      const x=m.agent_info;
      const canonical=JSON.stringify({agent:x.agent,space:x.space,createdAt:x.createdAt,expiresAt:x.expiresAt,
        isTombstone:x.isTombstone,url:x.url,storageArc:x.storageArc});
      p.send({type:'sign_response',request_id:m.request_id,signature:signIt(info,Buffer.from(canonical))});
      return;
    }
    if(pending&&pending.types.includes(m.type)){const done=pending;pending=null;done.yes(m);}
    else messages.push(m);
  });
  ws.addEventListener('error',()=>{});
 });
}
async function login(info){
 const p=await socket(info);
 p.send({type:'auth',agent_pubkey:info.agent});
 const c=await p.next(['auth_challenge','auth_error']);assert.equal(c.type,'auth_challenge');
 p.send({type:'auth_challenge_response',signature:signIt(info,Buffer.from(c.challenge,'hex'))});
 assert.equal((await p.next(['auth_ok','auth_error'])).type,'auth_ok');
 p.send({type:'register',dna_hash:f.dna,agent_pubkey:info.agent});
 assert.equal((await p.next(['registered','error'])).type,'registered');
 return p;
}
async function main(){
 for(const [i,caps] of [[A,['dht_read','k2','game_role_deliver']],
                        [B,['dht_read','k2','game_role_request']],
                        [C,['dht_read','k2','game_role_request']]]){
   await admin('POST',{agent_pubkey:i.agent,capabilities:caps});
 }
 const [a,b,c]=await Promise.all([login(A),login(B),login(C)]);
 try{
  const ok=frame('role_delivery_v1',A,B);
  a.send(ok);
  assert.equal((await a.next(['role_queued_v1','error'])).type,'role_queued_v1');
  const inbound=await b.next(['role_delivery_v1','error']);
  assert.equal(inbound.type,'role_delivery_v1');
  assert.equal(inbound.envelope.message_id,ok.envelope.message_id);
  assert.equal('origin_token' in inbound,false);
  const req=frame('role_request_v1',B,A);
  b.send(req);
  assert.equal((await b.next(['role_queued_v1','error'])).type,'role_queued_v1');
  assert.equal((await a.next(['role_request_v1','error'])).type,'role_request_v1');
  for(const [peer,msg] of [
    [b,frame('role_delivery_v1',B,C)],
    [a,frame('role_request_v1',A,B)],
    [a,frame('role_delivery_v1',A,B,{dna_hash:f.other_dna})],
    [a,frame('role_delivery_v1',A,B,{sender_agent:C.agent})],
    [a,frame('role_delivery_v1',A,B,{expires_at_ms:Date.now()-1})],
  ]){
   peer.send(msg);assert.equal((await peer.next(['error','role_queued_v1'])).type,'error');
  }
  const tamper=frame('role_delivery_v1',A,B);tamper.envelope.ciphertext='bad';
  a.send(tamper);assert.equal((await a.next(['error','role_queued_v1'])).type,'error');
  a.send({type:'role_delivery_v1',envelope:{...ok.envelope,ciphertext:'A'.repeat(15000)},signature:ok.signature});
  assert.equal((await a.next(['error','role_queued_v1'])).type,'error');
  a.send({type:'send_remote_signal',dna_hash:f.dna,signals:[]});
  assert.equal((await a.next(['error','role_queued_v1'])).type,'error');
  await admin('DELETE',{agent_pubkey:A.agent});
  await Promise.race([a.closedPromise(),new Promise((_,no)=>setTimeout(()=>no(Error('revocation close timeout')),8000))]);
  for(const p of [b,c]){p.send({type:'ping'});assert.equal((await p.next(['pong','error'])).type,'pong');}
  await admin('POST',{agent_pubkey:A.agent,capabilities:['dht_read','k2','game_role_deliver']});
  const fresh=await login(A);
  try{
   const q=frame('role_delivery_v1',A,B);
   fresh.send(q);
   assert.equal((await fresh.next(['role_queued_v1','error'])).type,'role_queued_v1');
   assert.equal((await b.next(['role_delivery_v1','error'])).envelope.message_id,q.envelope.message_id);
  }finally{fresh.close();}
  console.log('ROLE_GATEWAY_THREE_AGENT_NETWORK=PASS; HWC_RECEIVER=NOT_TESTED');
 }finally{a.close();b.close();c.close();}
}
main().catch(e=>{console.error('ROLE_GATEWAY_THREE_AGENT_NETWORK=FAIL',e.message);process.exitCode=1;});
