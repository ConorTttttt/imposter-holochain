import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode } from "@msgpack/msgpack";
import {
  connectNativeClient, createNativeClient, nativeBridge,
  type NativeBridge,
} from "./native-client.js";

function fakeBridge() {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const bridge: NativeBridge = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      const result: Record<string, unknown> = {
        mobile_status: { phase: "ready", reason: "" },
        mobile_app_info: {
          agent_pub_key: [1, 2, 3],
          clones: [{ clone_id: "game.0", network_seed: "room1.ABCD", enabled: true }],
        },
        mobile_create_clone: {
          clone_id: "game.1", network_seed: args?.networkSeed, enabled: true,
        },
        mobile_disable_clone: undefined,
        mobile_call_zome: Array.from(encode({
          agent: new Uint8Array([4, 5]), ok: true,
        })),
      };
      if (!(command in result)) throw new Error("unexpected native command");
      return result[command] as T;
    },
    async listen(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
  return { bridge, calls, listeners };
}

test("native app info preserves agent key bytes and clone seeds", async () => {
  const { bridge } = fakeBridge();
  const client = await connectNativeClient(bridge);
  const info = await client.appInfo();
  assert.deepEqual(Array.from(info!.agent_pub_key), [1, 2, 3]);
  const game = info!.cell_info.game[0] as any;
  assert.equal(game.cloned.clone_id, "game.0");
  assert.equal(game.cloned.dna_modifiers.network_seed, "room1.ABCD");
});

test("mobile calls use MessagePack (including binary hashes) and typed IPC", async () => {
  const { bridge, calls } = fakeBridge();
  const client = createNativeClient(bridge);
  const result = await client.callZome({
    role_name: "game.0",
    zome_name: "game",
    fn_name: "get_game_state",
    payload: { hash: new Uint8Array([7, 8]) },
  });
  assert.deepEqual(result, { agent: new Uint8Array([4, 5]), ok: true });
  const sent = calls.find(c => c.command === "mobile_call_zome")!;
  assert.equal(sent.args?.roleName, "game.0");
  assert.equal(sent.args?.fnName, "get_game_state");
  assert.deepEqual(decode(new Uint8Array(sent.args?.payloadBytes as number[])), {
    hash: new Uint8Array([7, 8]),
  });
});

test("native clone creation and disable never use raw network access", async () => {
  const { bridge, calls } = fakeBridge();
  const client = createNativeClient(bridge);
  const clone = await client.createCloneCell({
    role_name: "game", modifiers: { network_seed: "room1.ABCD" },
    name: "Lobby ABCD",
  });
  assert.equal(clone.clone_id, "game.1");
  await client.disableCloneCell({ clone_cell_id: { type: "clone_id", value: "game.1" } });
  assert.deepEqual(calls.map(c => c.command), ["mobile_create_clone", "mobile_disable_clone"]);
});

test("native signal event is forwarded to the usual Holochain listener", async () => {
  const { bridge, listeners } = fakeBridge();
  const client = createNativeClient(bridge);
  let received: unknown;
  client.on("signal", s => { received = s; });
  // Promise for setting up native event listener settles in the next microtask.
  await Promise.resolve();
  listeners.get("imposter://signal")?.({
    payload: { type: "app", value: { payload: { kind: "your_role", role: 1 } } },
  });
  assert.deepEqual(received, {
    type: "app", value: { payload: { kind: "your_role", role: 1 } },
  });
});

test("an unavailable conductor is an error, not a desktop fallback", async () => {
  const bridge: NativeBridge = {
    invoke: async () => ({ phase: "unavailable", reason: "needs H2HC runtime" }) as never,
    listen: async () => () => {},
  };
  await assert.rejects(connectNativeClient(bridge), /needs H2HC runtime/);
  assert.equal(nativeBridge(), null); // Node has no native window
});
