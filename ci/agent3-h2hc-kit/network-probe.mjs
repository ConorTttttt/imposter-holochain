// Actual HTTP/WebSocket integration probe; no mocks. Only CI-only synthetic keys.
// Fail closed: if join/publish fails, record it and fail the job; never claim convergence.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign as edSign } from 'node:crypto';

const fixture = JSON.parse(readFileSync(process.env.H2HC_FIXTURE_FILE, 'utf8'));
const root = process.env.H2HC_BASE_URL || 'http://127.0.0.1:18090';
const secret = process.env.H2HC_LINKER_ADMIN_SECRET;
assert(secret && process.env.H2HC_LINKER_ALLOW_INSECURE_DEV === 'false', 'production authentication required');
const observations = [];
function record(label, detail) {
  const line = { label, ...detail };
  observations.push(line);
  console.log(JSON.stringify(line)); // never print secrets, tokens, or private keys
}
function signer(info, bytes) {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(info.seed_hex, 'hex')]),
    format: 'der', type: 'pkcs8'
  });
  return edSign(null, Buffer.from(bytes), key).toString('base64');
}
function canonical(info) {
  const parts = [
    '"agent":' + JSON.stringify(info.agent),
    '"space":' + JSON.stringify(info.space),
    '"createdAt":' + JSON.stringify(info.createdAt),
    '"expiresAt":' + JSON.stringify(info.expiresAt),
    '"isTombstone":' + String(info.isTombstone),
    '"url":' + JSON.stringify(info.url),
    '"storageArc":' + (info.storageArc === null ? 'null' : JSON.stringify(info.storageArc)),
  ];
  return '{' + parts.join(',') + '}';
}
async function http(path, opts = {}) {
  const res = await fetch(root + path, { ...opts, signal: AbortSignal.timeout(10000) });
  const response = await res.text();
  let body;
  try { body = JSON.parse(response); } catch { body = response.slice(0, 250); }
  return { status: res.status, body };
}
function tokenHeader(token) {
  return { authorization: 'Bearer ' + token };
}
async function admin(method, path, body, secretOverride = secret) {
  return http(path, {
    method, headers: { 'authorization': 'Bearer ' + secretOverride, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}
function socket(info) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(root.replace(/^http/, 'ws') + '/ws');
    const messages = [];
    let waiter;
    let closed = false;
    const time = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(time);
      const peer = {
        ws, info,
        send(payload) { ws.send(JSON.stringify(payload)); },
        async next(types, ms = 15000) {
          const candidates = Array.isArray(types) ? types : [types];
          const idx = messages.findIndex(m => candidates.includes(m.type));
          if (idx >= 0) return messages.splice(idx, 1)[0];
          assert(!waiter, 'only one pending WS next');
          return new Promise((ok, bad) => {
            const timer = setTimeout(() => { waiter = null; bad(new Error('no WS response: ' + candidates.join('/'))); }, ms);
            waiter = { candidates, ok: (m) => { clearTimeout(timer); ok(m); } };
          });
        },
        close() { if (!closed) ws.close(); },
        waitClosed(ms = 8000) {
          if (closed) return Promise.resolve();
          return new Promise((ok,bad) => {
            const timer = setTimeout(() => bad(new Error('revoked WebSocket was not closed')), ms);
            ws.addEventListener('close', () => { clearTimeout(timer); ok(); }, {once:true});
          });
        }
      };
      resolve(peer);
    });
    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'sign_agent_info') {
        if (msg.agent_pubkey !== info.agent) {
          ws.send(JSON.stringify({type:'sign_response',request_id:msg.request_id,error:'wrong agent'}));
        } else {
          ws.send(JSON.stringify({
            type:'sign_response', request_id:msg.request_id,
            signature: signer(info, Buffer.from(canonical(msg.agent_info), 'utf8'))
          }));
        }
        return;
      }
      if (waiter && waiter.candidates.includes(msg.type)) {
        const w = waiter; waiter = null; w.ok(msg);
      } else messages.push(msg);
    });
    ws.addEventListener('close', () => { closed = true; });
    ws.addEventListener('error', () => { if (!closed) record('ws-error', {agent:info.label}); });
  });
}
async function login(info) {
  const peer = await socket(info);
  peer.send({type:'auth',agent_pubkey:info.agent});
  const challenge = await peer.next(['auth_challenge','auth_error']);
  assert.equal(challenge.type, 'auth_challenge', 'agent must be allowlisted');
  peer.send({type:'auth_challenge_response', signature: signer(info, Buffer.from(challenge.challenge, 'hex'))});
  const result = await peer.next(['auth_ok', 'auth_error']);
  assert.equal(result.type, 'auth_ok', 'signed challenge must authenticate');
  assert.match(result.session_token, /^[a-f0-9]{64}$/);
  record('signed-ws-auth', {agent:info.label, result: 'PASS'});
  return {peer, token:result.session_token};
}
async function register(peer, dna, agent, expected) {
  peer.send({type:'register',dna_hash:dna,agent_pubkey:agent});
  const m = await peer.next(['registered','error'], 30000);
  assert.equal(m.type, expected, 'registration: ' + JSON.stringify(m));
  record('ws-register', {agent:peer.info.label, result:m.type, dna: dna === fixture.dna ? 'primary' : 'other'});
}
function getOp(path, token, body) {
  return http(path, {
    method:'POST',
    headers:{...tokenHeader(token), 'content-type':'application/json'},
    body: JSON.stringify({ops:[body]})
  });
}
async function main() {
  const [a,b,c] = fixture.agents;
  const health = await http('/health');
  assert.equal(health.status, 200);
  record('service-startup', {http: health.status});
  assert.equal((await http('/test/signal',{method:'POST'})).status,404);
  assert.equal((await http('/api/' + fixture.dna + '/game/test')).status,404);
  record('removed-unauthenticated-routes',{test_signal:404,legacy_zome:404});
  const publishPath = '/dht/' + fixture.dna + '/publish';
  assert.equal((await getOp(publishPath, 'bogus', a.op)).status,401);
  assert.equal((await http('/dht/' + fixture.dna + '/record/' + a.action_hash)).status,401);
  assert.equal((await admin('GET','/admin/agents',undefined,'wrong-secret')).status,401);
  record('http-auth-required',{result:'PASS'});
  for (const [info,caps] of [[a,['dht_read','dht_write','k2']], [b,['dht_read','k2']]]) {
    const res = await admin('POST','/admin/agents',{
      agent_pubkey:info.agent,capabilities:caps,label:'synthetic-' + info.label
    });
    assert.equal(res.status,204,'admin allowlist '+ info.label);
  }
  const denied = await socket(c);
  denied.send({type:'auth',agent_pubkey:c.agent});
  assert.equal((await denied.next(['auth_error','auth_challenge'])).type,'auth_error');
  denied.close();
  record('unauthorized-identity-rejected',{result:'PASS'});
  const authA = await login(a), authB = await login(b);
  try {
    await register(authA.peer,fixture.dna,b.agent,'error');
    await register(authB.peer,fixture.dna,a.agent,'error');
    await register(authA.peer,fixture.dna,a.agent,'registered');
    await register(authB.peer,fixture.dna,b.agent,'registered');
    const wrong = await http('/dht/' + fixture.other_dna + '/record/' + a.action_hash,
      {headers:tokenHeader(authA.token)});
    assert.equal(wrong.status,403,'DNA scope');
    record('dna-scope',{result:'PASS',status:wrong.status});
    const noWrite = await getOp(publishPath, authB.token, b.op);
    assert.equal(noWrite.status,403,'capability restriction');
    record('write-capability',{result:'PASS',status:noWrite.status});
    authA.peer.send({type:'unregister',dna_hash:fixture.dna,agent_pubkey:b.agent});
    assert.equal((await authA.peer.next(['unregistered','error'])).type,'error');
    record('unauthorized-unregister',{result:'PASS'});
    const valid = await getOp(publishPath,authA.token,a.op);
    assert.equal(valid.status,200);
    assert.equal(valid.body.queued,1,'valid signed op must reach queue');
    assert.equal(valid.body.failed,0);
    record('valid-signed-dht-op',{
      queued:valid.body.queued, published:valid.body.published,
      success:valid.body.success, status:valid.status
    });
    const forged = await getOp(publishPath,authA.token,a.forged);
    assert.equal(forged.status,200);
    assert.equal(forged.body.queued,0);
    assert.equal(forged.body.failed,1);
    const wrongAuthor = await getOp(publishPath,authA.token,b.op);
    assert.equal(wrongAuthor.status,200);
    assert.equal(wrongAuthor.body.queued,0);
    assert.equal(wrongAuthor.body.failed,1);
    record('forged-and-wrong-author-rejected',{result:'PASS'});
    authA.peer.send({type:'send_remote_signal',dna_hash:fixture.dna,signals:[]});
    assert.equal((await authA.peer.next(['error','signal'])).type,'error');
    record('remote-signals-disabled',{result:'PASS'});
    // This is NOT a native authority proof: null and timeout are NOT acceptance.
    const get = await http('/dht/' + fixture.dna + '/record/' + a.action_hash,
      {headers:tokenHeader(authA.token)});
    record('native-validated-record-retrieval',{
      status:get.status, returnedValidatedRecord: Boolean(get.body && typeof get.body === 'object' && get.body.action),
      classification:'UNVERIFIED_WITHOUT_NATIVE_AUTHORITY'
    });
    authA.peer.send({type:'unregister',dna_hash:fixture.dna,agent_pubkey:a.agent});
    const unreg = await authA.peer.next(['unregistered','error'],30000);
    assert.equal(unreg.type,'unregistered');
    record('owned-unregister',{result:'PASS'});

    // Two fully authenticated, simultaneously connected sockets for A.
    // B stays independently authenticated and must not be disconnected.
    const authA2 = await login(a);
    try {
      await register(authA2.peer,fixture.dna,a.agent,'registered');
      const readPath='/dht/'+fixture.dna+'/record/'+a.action_hash;
      const beforeA1=await http(readPath,{headers:tokenHeader(authA.token)});
      const beforeA2=await http(readPath,{headers:tokenHeader(authA2.token)});
      const beforeB=await http(readPath,{headers:tokenHeader(authB.token)});
      assert.equal(beforeA1.status,200,'A1 valid bearer before revoke');
      assert.equal(beforeA2.status,200,'A2 valid bearer before revoke');
      assert.equal(beforeB.status,200,'B valid bearer before revoke');

      const disconnectA1=authA.peer.waitClosed();
      const disconnectA2=authA2.peer.waitClosed();
      assert.equal((await admin('DELETE','/admin/agents',
        {agent_pubkey:a.agent})).status,204);
      await Promise.all([disconnectA1,disconnectA2]);
      record('revoke-all-active-websockets',{
        result:'PASS',agent:'A',active_connections_closed:2,unrelated_agent:'B'
      });
      for (const oldToken of [authA.token,authA2.token]) {
        assert.equal((await http(readPath,{headers:tokenHeader(oldToken)})).status,401,
          'old bearer must reject protected read');
        assert.equal((await getOp(publishPath,oldToken,a.op)).status,401,
          'old bearer must reject protected write');
      }
      assert.equal((await http(readPath,{headers:tokenHeader(authB.token)})).status,200);
      authB.peer.send({type:'ping'});
      assert.equal((await authB.peer.next(['pong','auth_error','error'])).type,'pong');
      record('revoked-http-bearers-and-unrelated-agent',{
        result:'PASS',old_bearers_denied:2,read_status:401,write_status:401,
        unrelated_http_status:200,unrelated_ws_heartbeat:'pong'
      });

      const rejectedA=await socket(a);
      try {
        rejectedA.send({type:'auth',agent_pubkey:a.agent});
        assert.equal((await rejectedA.next(['auth_challenge','auth_error'])).type,'auth_error');
      } finally { rejectedA.close(); }
      assert.equal((await admin('POST','/admin/agents',{
        agent_pubkey:a.agent,capabilities:['dht_read','dht_write','k2'],
        label:'synthetic-reauthorized-A'
      })).status,204);
      const authA3=await login(a);
      try {
        await register(authA3.peer,fixture.dna,a.agent,'registered');
        assert.equal((await http(readPath,{headers:tokenHeader(authA3.token)})).status,200);
        for (const oldToken of [authA.token,authA2.token]) {
          assert.equal((await http(readPath,{headers:tokenHeader(oldToken)})).status,401,
            'revoked bearers must NOT revive after reallowlisting');
        }
      } finally { authA3.peer.close(); }
      record('deny-until-reauthorized-and-fresh-signed-auth',{
        result:'PASS',revoked_authorization:'denied',
        fresh_signed_auth:'accepted',old_bearers_still_rejected:2
      });
    } finally { authA2.peer.close(); }
  } finally {
    authA.peer.close();
    authB.peer.close();
  }
}
try {
  await main();
  writeFileSync(process.env.H2HC_RESULT_FILE, JSON.stringify({result:'PASS',observations},null,2));
} catch(error) {
  record('FAILURE',{error:String(error?.message||error)});
  writeFileSync(process.env.H2HC_RESULT_FILE, JSON.stringify({result:'FAIL',observations},null,2));
  process.exitCode=1;
}
