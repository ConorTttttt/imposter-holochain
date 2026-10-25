import { test } from "node:test";
import assert from "node:assert/strict";
import { Hc } from "../holochain.js";
import { RoomRegistry, type Resolution } from "./registry.js";

test("base room lookup creates zero clones; joining creates only the selected clone", async () => {
  let clones = 0;
  const roles: string[] = [];
  const selected = "g1.selected";
  let result: Resolution = { status: "not_found" };
  const cells: any[] = [];
  const client = {
    async appInfo() { return { cell_info: { game: cells } }; },
    async createCloneCell(input: any) {
      clones++;
      assert.equal(input.modifiers.network_seed, selected);
      const cell = { clone_id: "game.0", dna_modifiers: { network_seed: selected }, enabled: true };
      cells.push({ cloned: cell }); return cell;
    },
    async callZome(input: any) {
      roles.push(input.role_name);
      if (input.fn_name === "resolve_room_pointer") return result;
      if (input.fn_name === "get_game_state") return {code:selected,phase:"lobby",players:[],player_count:4,my_seat:null};
      return null;
    },
  };
  // Test the production wrapper with an injected client, without a websocket.
  const hc = Reflect.construct(Hc, [client, new Uint8Array(39), new Set()]) as Hc;
  const values = new Map<string,string>();
  const registry = new RoomRegistry(hc, {getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);}}, "test");
  await assert.rejects(registry.lookup("ROOM"));
  assert.equal(clones,0); assert.deepEqual(roles,["game"]);
  result = {status:"found",current:{action:new Uint8Array(39),pointer:{version:1,room_code_hash:new Array(32).fill(1),game_seed:selected,host:new Uint8Array(39),round:1,previous:null}}};
  await registry.lookup("ROOM"); await registry.join("ROOM","B");
  assert.equal(clones,1);
  assert.ok(roles.includes("game.0"));
});
