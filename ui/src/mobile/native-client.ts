// Tauri 2's restricted IPC adapter. The WebView receives neither an app
// websocket token nor a keystore secret. Native holds the conductor and signs
// zome calls. Deliberately no browser/localhost fallback in a Tauri window.
import { decode, encode } from "@msgpack/msgpack";
import type { AppClient } from "@holochain/client";

export type NativeStatus = { phase: "unavailable" | "starting" | "ready"; reason: string };
export type NativeAppInfo = {
  agent_pub_key: number[];
  clones: { clone_id: string; network_seed: string; enabled: boolean }[];
};
export type NativeBridge = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
};

type NativeGlobal = typeof globalThis & {
  __TAURI__?: {
    core?: { invoke: NativeBridge["invoke"] };
    event?: { listen: NativeBridge["listen"] };
  };
};

export function nativeBridge(): NativeBridge | null {
  const api = (globalThis as NativeGlobal).__TAURI__;
  if (!api?.core?.invoke || !api.event?.listen) return null;
  return { invoke: api.core.invoke, listen: api.event.listen };
}

export function isTauriShell(): boolean {
  // The global is injected by Tauri only into an actual Tauri WebView.
  return Boolean((globalThis as NativeGlobal).__TAURI__);
}

export async function connectNativeClient(bridge: NativeBridge): Promise<AppClient> {
  const status = await bridge.invoke<NativeStatus>("mobile_status");
  if (status.phase !== "ready") {
    throw new Error("Android Holochain is not ready: " + status.reason);
  }
  return createNativeClient(bridge);
}

/** Compatible with the small AppClient subset used by ui/src/holochain.ts. */
export function createNativeClient(bridge: NativeBridge): AppClient {
  const client = {
    async appInfo() {
      const raw = await bridge.invoke<NativeAppInfo>("mobile_app_info");
      return {
        agent_pub_key: new Uint8Array(raw.agent_pub_key),
        cell_info: {
          game: raw.clones.map(c => ({
            cloned: {
              clone_id: c.clone_id,
              enabled: c.enabled,
              dna_modifiers: { network_seed: c.network_seed },
            },
          })),
        },
      };
    },
    async createCloneCell(args: { role_name: string; modifiers: { network_seed: string } }) {
      if (args.role_name !== "game") throw new Error("Unexpected role name");
      const result = await bridge.invoke<{ clone_id: string; network_seed: string; enabled: boolean }>(
        "mobile_create_clone", { networkSeed: args.modifiers.network_seed },
      );
      return {
        clone_id: result.clone_id,
        enabled: result.enabled,
        dna_modifiers: { network_seed: result.network_seed },
      };
    },
    async disableCloneCell(args: { clone_cell_id: { type: string; value: string } }) {
      if (args.clone_cell_id.type !== "clone_id") throw new Error("Expected clone ID");
      await bridge.invoke<void>("mobile_disable_clone", { cloneId: args.clone_cell_id.value });
    },
    async callZome(args: { role_name: string; zome_name: string; fn_name: string; payload: unknown }) {
      if (args.zome_name !== "game") throw new Error("Unexpected zome name");
      const payloadBytes = Array.from(encode(args.payload === undefined ? null : args.payload));
      const response = await bridge.invoke<number[]>("mobile_call_zome", {
        roleName: args.role_name,
        zomeName: args.zome_name,
        fnName: args.fn_name,
        payloadBytes,
      });
      return decode(new Uint8Array(response));
    },
    on(event: string, callback: (signal: unknown) => void) {
      if (event !== "signal") throw new Error("Unsupported native event");
      // The conductor will emit { type: "app", value: { payload: ... } }.
      // Leave errors visible; failure to subscribe must not invent liveness.
      void bridge.listen("imposter://signal", ({ payload }) => callback(payload))
        .catch((err) => console.error("Holochain native signal subscription failed:", err));
    },
  };
  return client as unknown as AppClient;
}
