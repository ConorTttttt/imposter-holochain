import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomRegistry, normalizeRoomCode, ROOM_CONFLICT, ROOM_UNAVAILABLE, type Resolution, type PointerView } from "./registry.js";
import { encodeHashToBase64 } from "@holochain/client";

const key = new Uint8Array([132,32,36,...new Array(36).fill(7)]);
const host = encodeHashToBase64(key);
function pointer(seed = `g1.${host}.0123456789abcdef0123456789abcdef`, round = 1): PointerView {
  return { action: new Uint8Array([round]), pointer: { version:1, room_code_hash: new Array(32).fill(1), game_seed:seed, host:key, round, previous:null } };
}
function harness() {
  const calls: { base: boolean; fn: string; payload: any; seed?: string }[] = [];
  const values = new Map<string,string>();
  let result: Resolution = {status:"not_found"};
  let raw: any = {code:null,phase:"lobby",players:[],player_count:4,my_seat:null};
  let failPublish = false;
  const client = {
    async callBase<T>(fn: string,payload: any): Promise<T> {
      calls.push({base:true,fn,payload});
      if (fn === "resolve_room_pointer") return result as T;
      if (failPublish) { failPublish=false; throw new Error("lost response"); }
      const p=pointer(payload.game_seed,payload.round); result={status:"found",current:p}; return p as T;
    },
    async callOn<T>(seed: string,fn: string,payload?: any): Promise<T> {
      calls.push({base:false,seed,fn,payload});
      if (fn === "create_lobby") raw={...raw,code:seed,my_seat:0,players:[{}]};
      return raw as T;
    },
  };
  const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  return { calls, client, storage, registry:new RoomRegistry(client,storage,host), setResult:(r:Resolution)=>result=r, setRaw:(r:any)=>raw=r, fail:()=>failPublish=true };
}
test("room normalization rejects malformed identifiers",()=>{
  assert.equal(normalizeRoomCode("  room-a1 "),"ROOM-A1");
  assert.equal(normalizeRoomCode("\t\n\v\f\r room-a1 "),"ROOM-A1");
  for (const code of ["", "abc", "----", "abc#2", "A BCD", "éBCD", "ſBCD", "\u00a0ABCD\u00a0", "a".repeat(33)]) assert.throws(()=>normalizeRoomCode(code));
});
test("missing, unavailable and conflicting rooms open no clones",async()=>{
  for (const status of ["not_found","unavailable","conflict"] as const) {
    const h=harness(); h.setResult({status});
    await assert.rejects(h.registry.lookup("ROOM"));
    assert.equal(h.calls.filter(c=>!c.base).length,0);
  }
});
test("resolved room opens only selected game and joins",async()=>{
  const h=harness(); const p=pointer(); h.setResult({status:"found",current:p});
  h.setRaw({code:p.pointer.game_seed,phase:"lobby",players:[{}],player_count:4,my_seat:null});
  await h.registry.join("room","Joiner");
  assert.deepEqual(new Set(h.calls.filter(c=>!c.base).map(c=>c.seed)),new Set([p.pointer.game_seed]));
  assert.equal(h.calls.filter(c=>c.fn==="create_lobby").length,0);
  assert.equal(h.calls.filter(c=>c.fn==="join_lobby").length,1);
});
test("full and started games cannot be joined; missing lobby waits",async()=>{
  for (const raw of [{code:"seed",phase:"playing",players:[],player_count:4}, {code:"seed",phase:"lobby",players:[1,2,3,4],player_count:4}, {code:null}]) {
    const h=harness(); h.setResult({status:"found",current:pointer()}); h.setRaw(raw);
    await assert.rejects(h.registry.join("ROOM","B"));
    assert.equal(h.calls.filter(c=>c.fn==="join_lobby" || c.fn==="create_lobby").length,0);
  }
});
test("create publishes after lobby; response failure and reload reuse seed",async()=>{
  const h=harness(); h.fail(); const config={player_count:4,impostor_count:1,task_target:4,display_name:"Host"};
  await assert.rejects(h.registry.create("ROOM",host,config));
  const r=new RoomRegistry(h.client,h.storage,host); await r.create("ROOM",host,config);
  assert.equal(h.calls.filter(c=>c.fn==="create_lobby").length,1);
  assert.equal(new Set(h.calls.filter(c=>!c.base).map(c=>c.seed)).size,1);
  assert.ok(h.calls.findIndex(c=>c.fn==="create_lobby")<h.calls.findIndex(c=>c.fn==="publish_room_pointer"));
  h.setResult({status:"not_found"}); h.setRaw({code:null});
  await r.create("OTHER",host,config);
  assert.equal(new Set(h.calls.filter(c=>!c.base).map(c=>c.seed)).size,2);
});
test("delayed visibility retries lookup without creating duplicate lobby",async()=>{
  const h=harness(); await assert.rejects(h.registry.join("ROOM","B"));
  h.setResult({status:"found",current:pointer()}); await assert.rejects(h.registry.join("ROOM","B"),{message:ROOM_UNAVAILABLE});
  h.setRaw({code:"seed",phase:"lobby",players:[],player_count:4,my_seat:null}); await h.registry.join("ROOM","B");
  assert.equal(h.calls.filter(c=>c.fn==="create_lobby").length,0);
});
test("host pins and round high-water marks survive reload",async()=>{
  const h=harness(); h.setResult({status:"found",current:pointer()}); await h.registry.resolve("ROOM");
  const p=pointer("next",2); h.setResult({status:"found",current:p}); await h.registry.resolve("ROOM");
  const r=new RoomRegistry(h.client,h.storage,host);
  h.setResult({status:"found",current:pointer()}); await assert.rejects(r.resolve("ROOM"),{message:ROOM_UNAVAILABLE});
  p.pointer.host=new Uint8Array([9]); h.setResult({status:"found",current:p}); await assert.rejects(r.resolve("ROOM"),{message:ROOM_CONFLICT});
});

test("temporary absence cannot let creation replace a pinned room", async () => {
  const h = harness(); h.setResult({ status: "found", current: pointer() });
  await h.registry.resolve("ROOM"); h.setResult({ status: "not_found" });
  await assert.rejects(h.registry.create("ROOM", host, {player_count:4,impostor_count:1,task_target:4,display_name:"Host"}));
  assert.equal(h.calls.filter(c => !c.base).length, 0);
});
