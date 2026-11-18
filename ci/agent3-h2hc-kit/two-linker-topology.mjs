#!/usr/bin/env node
/**
 * Two independent authenticated H2HC processes, no native authority assumed.
 * CI-only deterministic Ed25519 identities; never real host keys or role data.
 * Outputs an evidence JSON with four distinct gates. Uses native 0.7 MsgPack
 * AgentActivity fixture independently verified against the pinned Rust example.
 */
import assert from "node:assert/strict";
import { createPrivateKey, sign as edSign, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const bin=process.env.H2HC_BINARY;
assert(bin && process.env.H2HC_LINKER_ALLOW_INSECURE_DEV!=="true","provide precompiled secure H2HC_BINARY");
const out=process.env.H2HC_EVIDENCE_DIR||"/tmp/agent3-topology";
mkdirSync(out,{recursive:true});
const bootstrap=process.env.H2HC_TEST_BOOTSTRAP_URL||"https://dev-test-bootstrap2.holochain.org/";
const relay=process.env.H2HC_TEST_RELAY_URL||bootstrap;
const portA=Number(process.env.H2HC_PORT_A||18430), portB=Number(process.env.H2HC_PORT_B||18431);
const waitMs=Number(process.env.H2HC_DISCOVERY_MS||12000);
const fixture={
 dna:"uhC0kBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQXgLsOE",
 actionHash:"uhCkkflncV3IJKdotVf3lWVHz3zpW4IgRf0R9c2xetY8ob49Wr0fG",
 agents:[
  {label:"A",pub:"uhCAkHioTfH_iJ5-dfwZEAwoOnAtF94Hc5xrkUZwPQ4QDFlQuKfUS",seed:27},
  {label:"B",pub:"uhCAktAiM07iWLmSorDcW-4b8fnrh0CXx61YhVatmNhGyzCi72XOo",seed:28}
 ],
 op:{
  op_data:"gadDaGFpbk9wga1BZ2VudEFjdGl2aXR5gqRkYXRhgqZoZWFkZXKEpmF1dGhvcsQnhCAkHioTfH/iJ5+dfwZEAwoOnAtF94Hc5xrkUZwPQ4QDFlQuKfUSqXRpbWVzdGFtcGSqYWN0aW9uX3NlcQCrcHJldl9hY3Rpb27ApGRhdGGCpHR5cGWjRG5hqGRuYV9oYXNoxCeELSQFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBeAuw4Spc2lnbmF0dXJlxEBJCbLzh7hW7dQzQKDu4XITa2SvQL9vN47pBcRjNtC9omk7P9i2Mv0bGjagHTkUqnL4NevvbYQIF2DtN06AjAMK",
  signature:"SQmy84e4Vu3UM0Cg7uFyE2tkr0C/bzeO6QXEYzbQvaJpOz/YtjL9Gxo2oB05FKpy+DXr722ECBdg7TdOgIwDCg=="
 }
};
const result={
 test:"P0_TWO_INDEPENDENT_ZERO_ARC_H2HC_TOPOLOGY",
 source:"pinned H2HC security-patched CI binary; no rebuild",
 bootstrap,relay,
 identities:"two synthetic Ed25519 agents in separate processes and sockets",
 production_auth:true,insecure_dev:false,local_authority_fallback:false,
 accepted_to_queue:"NOT_RUN",sent_to_peer:"NOT_RUN",
 native_authority_validated:"NOT_RUN",retrieved_by_other_authorized_agent:"NOT_RUN",
 completion_criterion_met:false,observations:[],result:"NOT_STARTED"
};
const privateKeysDir=mkdtempSync(join(tmpdir(),"agent3-linker-keys-"));
const children=[], sockets=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function log(label,data) {
 const event={label,...data}; result.observations.push(event);
 console.log(JSON.stringify(event)); // never output tokens, secrets, or private fixture seed
}
function keyFor(agent) {
 const der=Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.alloc(32,agent.seed)]);
 return createPrivateKey({key:der,format:"der",type:"pkcs8"});
}
function sign(agent,bytes){return edSign(null,Buffer.from(bytes),keyFor(agent)).toString("base64");}
function canonical(info) {
 const keys=["agent","space","createdAt","expiresAt","isTombstone","url","storageArc"];
 return "{"+keys.map(k=>JSON.stringify(k)+":"+JSON.stringify(info[k])).join(",")+"}";
}
async function request(port,path,method="GET",token,body) {
 let r=await fetch("http://127.0.0.1:"+port+path,{
  method,headers:{...(token?{"Authorization":"Bearer "+token}:{}),
    ...(body?{"Content-Type":"application/json"}:{})},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(35000)
 });
 const t=await r.text();let parsed;
 try{parsed=JSON.parse(t)}catch{parsed=t||null}
 return {status:r.status,body:parsed};
}
function socket(port,agent) {
 return new Promise((resolve,reject)=>{
  let timer=setTimeout(()=>reject(Error("WS open timeout")),10000);
  const ws=new WebSocket("ws://127.0.0.1:"+port+"/ws");
  const pending=[],messages=[];
  let waiter=null;
  ws.addEventListener("open",()=>{clearTimeout(timer);
    resolve({
      ws,agent,
      send:x=>ws.send(JSON.stringify(x)),
      receive(types,ms=40000) {
        const choices=Array.isArray(types)?types:[types];
        const i=messages.findIndex(m=>choices.includes(m.type));
        if(i>=0)return Promise.resolve(messages.splice(i,1)[0]);
        assert(!waiter,"one pending receive allowed");
        return new Promise((yes,no)=>{const clock=setTimeout(()=>{
          waiter=null;no(Error("no WS message in "+choices.join(",")));
        },ms);waiter={choices,yes:m=>{clearTimeout(clock);yes(m);}}});
      },
      close:()=>ws.close()
    });
  });
  ws.addEventListener("message",event=>{
    const m=JSON.parse(String(event.data));
    if(m.type==="sign_agent_info") {
      const raw=Buffer.from(agent.pub.slice(1),"base64url");
      const want=raw.subarray(3,35).toString("base64url");
      const info=m.agent_info;
      if(m.agent_pubkey!==agent.pub||info.agent!==want||info.storageArc!==null)
        ws.send(JSON.stringify({type:"sign_response",request_id:m.request_id,error:"invalid agent/arc"}));
      else ws.send(JSON.stringify({type:"sign_response",request_id:m.request_id,
        signature:sign(agent,Buffer.from(canonical(info),"utf8"))}));
      return;
    }
    if(waiter && waiter.choices.includes(m.type)){
      const w=waiter;waiter=null;w.yes(m);
    }else messages.push(m);
  });
  ws.addEventListener("error",()=>log("ws-error",{agent:agent.label}));
 });
}
async function login(port,agent,secret) {
 const adm=await request(port,"/admin/agents","POST",secret,{
  agent_pubkey:agent.pub,capabilities:["dht_read","dht_write","k2"],label:"synthetic-"+agent.label
 });
 assert.equal(adm.status,204);
 const peer=await socket(port,agent);sockets.push(peer);
 peer.send({type:"auth",agent_pubkey:agent.pub});
 const challenge=await peer.receive(["auth_challenge","auth_error"]);
 assert.equal(challenge.type,"auth_challenge",JSON.stringify(challenge));
 peer.send({type:"auth_challenge_response",signature:sign(agent,Buffer.from(challenge.challenge,"hex"))});
 const auth=await peer.receive(["auth_ok","auth_error"]);assert.equal(auth.type,"auth_ok");
 assert.match(auth.session_token,/^[0-9a-f]{64}$/);
 peer.send({type:"register",agent_pubkey:agent.pub,dna_hash:fixture.dna});
 const reg=await peer.receive(["registered","error"]);assert.equal(reg.type,"registered",JSON.stringify(reg));
 log("authenticated-agent-registered",{agent:agent.label,port});
 return auth.session_token;
}
function start(port,id,secret) {
 const env={...process.env,
  H2HC_LINKER_ADDRESS:"127.0.0.1",H2HC_LINKER_PORT:String(port),
  H2HC_LINKER_BOOTSTRAP_URL:bootstrap,H2HC_LINKER_RELAY_URL:relay,
  H2HC_LINKER_ADMIN_SECRET:secret,H2HC_LINKER_ALLOW_INSECURE_DEV:"false",
  H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK:"false",
  H2HC_LINKER_KEY_FILE:join(privateKeysDir,"gateway-"+id+"-identity.key"),
  RUST_LOG:"h2hc_linker=debug,kitsune2=info,iroh=warn"
 };
 const child=spawn(bin,["--address","127.0.0.1","--port",String(port)],{env,stdio:["ignore","pipe","pipe"]});
 const stream=createWriteStream(join(out,"gateway-"+id+".log"));
 child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
 children.push(child);
}
async function waitForServer(port) {
 for(let i=0;i<100;i++) {
  try{if((await request(port,"/health")).status===200)return;}catch{}
  await sleep(100);
 }
 throw Error("H2HC did not start on "+port);
}
let exitCode=0;
try {
 const secretA=randomBytes(32).toString("hex"),secretB=randomBytes(32).toString("hex");
 start(portA,"A",secretA);start(portB,"B",secretB);
 await Promise.all([waitForServer(portA),waitForServer(portB)]);
 const [a,b]=fixture.agents;
 const [tokenA,tokenB]=await Promise.all([
  login(portA,a,secretA),login(portB,b,secretB)
 ]);
 await sleep(waitMs);
 const path="/dht/"+fixture.dna;
 const post=await request(portA,path+"/publish","POST",tokenA,{ops:[fixture.op]});
 assert.equal(post.status,200);
 assert.equal(post.body.queued,1);assert.equal(post.body.failed,0);
 result.accepted_to_queue="PASS";
 log("native-encoded-signed-dht-op",{queued:post.body.queued,failed:post.body.failed,
  published:post.body.published,success:post.body.success});
 result.sent_to_peer=post.body.published>0?"TRANSPORT_ACK_ONLY":"BLOCKED_NO_REMOTE_AUTHORITY";
 result.peer_publish_count=post.body.published;
 const get=await request(portB,path+"/record/"+fixture.actionHash,"GET",tokenB);
 result.peer_get_http=get.status;
 result.retrieved_by_other_authorized_agent=
   get.status===200 && get.body && typeof get.body==="object" &&
   get.body.action?"CANDIDATE_RECORD_UNVALIDATED":"BLOCKED_NULL_OR_ERROR";
 // NOT a validated peer. This topology has no native conductor and cannot pass native validation.
 result.native_authority_validated="NOT_RUN";
 result.result=(post.body.published>0||result.retrieved_by_other_authorized_agent==="CANDIDATE_RECORD_UNVALIDATED")
   ?"PARTIAL_TRANSPORT_ONLY":"BLOCKED_NO_NATIVE_AUTHORITY";
 log("separate-authorized-peer-get",{http:get.status,nonNull:Boolean(get.body),
  classification:result.retrieved_by_other_authorized_agent});
 if(process.env.H2HC_REQUIRE_NATIVE_PROOF==="true") {
   exitCode=1;result.result="FAIL_NATIVE_PROOF_NOT_CONFIGURED";
 }
}catch(e){exitCode=1;result.result="FAIL_SETUP_OR_AUTH";result.error=String(e.message||e);}
finally {
 for(const peer of sockets){try{peer.close();}catch{}}
 for(const child of children){try{child.kill("SIGTERM");}catch{}}
 // Gateway key files NEVER enter the artifacts directory.
 await sleep(250);
 rmSync(privateKeysDir,{recursive:true,force:true});
 writeFileSync(join(out,"results.json"),JSON.stringify(result,null,2));
 console.log("TOPOLOGY_RESULT",result.result);
 process.exitCode=exitCode;
}
