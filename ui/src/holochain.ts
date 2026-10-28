import { connectNativeClient, isTauriShell, nativeBridge } from "./mobile/native-client.js";
// Thin wrapper over `@holochain/client`: connect (hc-spin injects the app
// port + token), get-or-create the clone cell for each game, close the clones
// of games left behind, call the `game` zome, and subscribe to signals.

import {
  AppWebsocket,
  type AppClient,
  type ClonedCell,
  encodeHashToBase64,
  type AgentPubKey,
} from "@holochain/client";

const ROLE = "game";
const ZOME = "game";

export type Signal =
  | { kind: "your_role"; seat: number; role: number }
  | { kind: "you_died"; killer: AgentPubKey }
  | { kind: string; [k: string]: unknown };

export class Hc {
  private readonly clones = new Map<string, Promise<string>>(); // network seed -> clone role name
  private current: string | null = null;

  private constructor(
    readonly client: AppClient,
    readonly myPubKey: AgentPubKey,
    private readonly closed: Set<string>, // network seeds of disabled clones: games left behind
  ) {}

  /** Connect once; pick the game with `useLobby` (it can change before joining).
   *  hc-spin injects its own connection (no args needed) with a fresh random
   *  agent key every launch. `npm run linked-conductor` gives this window a
   *  shared identity with a sibling app (see game/heads.ts) instead — when
   *  its connection file is being served, use that connection so `myPubKey`
   *  is the shared one, not a fresh hc-spin key. */
  static async connect(onSignal: (s: Signal) => void): Promise<Hc> {
    let client: AppClient;
    if (isTauriShell()) {
      // Never silently connect to hc-spin or a different desktop identity.
      const bridge = nativeBridge();
      if (!bridge) throw new Error("Android native Holochain bridge is unavailable");
      client = await connectNativeClient(bridge);
    } else {
      const shared = await fetch("/shared-conductor.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      // A stale shared-conductor file is not a fatal desktop error, but the
      // mobile path above never attempts this fallback.
      const viaShared = shared
        ? await AppWebsocket.connect({
            url: new URL(`ws://127.0.0.1:${shared.appPort}`),
            token: shared.imposterToken,
            wsClientOptions: { origin: "imposter-ui" },
          }).catch(() => null)
        : null;
      client = (viaShared ?? (await AppWebsocket.connect())) as unknown as AppClient;
    }
    const info = await client.appInfo();

    client.on("signal", (sig: any) => {
      // client 0.21: `{ type: "app", value: { cell_id, zome_name, payload } }`
      const payload =
        sig?.type === "app" ? sig.value?.payload : (sig?.App?.payload ?? sig?.payload ?? sig);
      if (payload && typeof payload === "object") onSignal(payload as Signal);
    });

    // A reload keeps the conductor, and with it any clones closed before it.
    const closed = new Set(
      clonesOf(info)
        .filter((c) => !c.enabled)
        .map((c) => c.dna_modifiers.network_seed),
    );
    return new Hc(client, info!.agent_pub_key, closed);
  }

  /** Point `call` at the clone whose network seed is `seed`, creating it on first use. */
  async useLobby(seed: string): Promise<void> {
    this.current = await this.cloneFor(seed);
  }

  call<T = unknown>(fn_name: string, payload: unknown = null): Promise<T> {
    if (!this.current) return Promise.reject(new Error("no lobby selected"));
    return this.callRole<T>(this.current, fn_name, payload);
  }

  /** Registry calls always use the existing provisioned cell, never a clone. */
  callBase<T = unknown>(fn_name: string, payload: unknown = null): Promise<T> {
    return this.callRole<T>(ROLE, fn_name, payload);
  }

  /** Call into a specific game without switching to it (e.g. to watch the next one). */
  async callOn<T = unknown>(seed: string, fn_name: string, payload: unknown = null): Promise<T> {
    return this.callRole<T>(await this.cloneFor(seed), fn_name, payload);
  }

  /** A game this window left behind: its clone is disabled and can't be called. */
  isClosed(seed: string): boolean {
    return this.closed.has(seed);
  }

  /** Disable a game's clone, so a finished game stops syncing and holding
   *  memory. Nothing to do for a game never opened here. */
  async closeLobby(seed: string): Promise<void> {
    if (this.closed.has(seed)) return;
    const clone = clonesOf(await this.client.appInfo()).find((c) => c.dna_modifiers.network_seed === seed);
    if (!clone) return;
    this.clones.delete(seed);
    this.closed.add(seed);
    await this.client.disableCloneCell({ clone_cell_id: { type: "clone_id", value: clone.clone_id } });
  }

  keyB64(k: AgentPubKey): string {
    return encodeHashToBase64(k);
  }

  private callRole<T>(role_name: string, fn_name: string, payload: unknown): Promise<T> {
    return this.client.callZome({ role_name, zome_name: ZOME, fn_name, payload }) as Promise<T>;
  }

  /** Shared per seed, so concurrent callers never race to create the same clone. */
  private cloneFor(seed: string): Promise<string> {
    let role = this.clones.get(seed);
    if (!role) {
      role = this.findOrCreateClone(seed);
      role.catch(() => this.clones.delete(seed));
      this.clones.set(seed, role);
    }
    return role;
  }

  private async findOrCreateClone(seed: string): Promise<string> {
    const found = findClone(await this.client.appInfo(), seed);
    if (found) return found;
    try {
      const cell: ClonedCell = await this.client.createCloneCell({
        role_name: ROLE,
        modifiers: { network_seed: seed },
        name: `lobby ${seed}`,
      });
      return cell.clone_id;
    } catch (e) {
      // Raced with an earlier create (e.g. before a reload) — re-read. Never fall
      // back to some other clone: calls would silently land in the wrong game.
      const again = findClone(await this.client.appInfo(), seed);
      if (again) return again;
      throw e;
    }
  }
}

/** The app's cloned `game` cells, in either `cell_info` shape the client has used. */
function clonesOf(info: any): ClonedCell[] {
  const cells: any[] = info?.cell_info?.[ROLE] ?? [];
  return cells
    .map((c) => c?.cloned ?? (c?.type === "cloned" ? c.value ?? c : undefined))
    .filter((c): c is ClonedCell => !!c);
}

function findClone(info: any, seed: string): string | undefined {
  const clone = clonesOf(info).find((c) => c.dna_modifiers?.network_seed === seed);
  return clone ? (clone.clone_id ?? `${ROLE}.0`) : undefined;
}
