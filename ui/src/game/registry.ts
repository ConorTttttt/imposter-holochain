import { newGameSeed } from "./rooms.js";

export type RoomPointer = {
  version: number; room_code_hash: number[]; game_seed: string; host: Uint8Array;
  round: number; previous: Uint8Array | null;
};
export type PointerView = { action: Uint8Array; pointer: RoomPointer };
export type Resolution = { status: "not_found" | "unavailable" | "conflict" } | { status: "found"; current: PointerView };
export interface RegistryClient {
  callBase<T>(fn: string, payload: unknown): Promise<T>;
  callOn<T>(seed: string, fn: string, payload?: unknown): Promise<T>;
}
export function normalizeRoomCode(code: string): string {
  const trimmed = code.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  const normalized = trimmed.toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(normalized) || !/[A-Z0-9]/.test(normalized) || /[^\x00-\x7f]/.test(trimmed)) {
    throw new Error("Invalid room code. Use 4–32 letters, numbers or hyphens.");
  }
  return normalized;
}
export const ROOM_NOT_FOUND = "Room not found yet. Check the code or wait a few seconds for the host's room to appear.";
export const ROOM_UNAVAILABLE = "Room temporarily unavailable. Please try again in a few seconds.";
export const ROOM_CONFLICT = "Conflicting room records. Ask the host to create a room with a different code.";
const keyOf = (key: Uint8Array) => Array.from(key).join(",");

/** Local pins survive reloads. A delayed, missing or competing record never
 * silently moves an established code to another host or an older round. */
export class RoomRegistry {
  constructor(private readonly hc: RegistryClient, private readonly storage: Pick<Storage, "getItem" | "setItem">, private readonly identity: string) {}
  private key(code: string, kind: string) { return `imposter-room-v1:${this.identity}:${kind}:${code}`; }
  async resolve(code: string): Promise<PointerView> {
    code = normalizeRoomCode(code);
    let result: Resolution;
    try { result = await this.hc.callBase<Resolution>("resolve_room_pointer", code); }
    catch { throw new Error(ROOM_UNAVAILABLE); }
    if (result.status === "not_found") throw new Error(ROOM_NOT_FOUND);
    if (result.status === "unavailable") throw new Error(ROOM_UNAVAILABLE);
    if (result.status === "conflict") throw new Error(ROOM_CONFLICT);
    if (result.status !== "found") throw new Error(ROOM_UNAVAILABLE);
    const current = result.current;
    this.remember(code, current);
    return current;
  }
  private remember(code: string, current: PointerView): void {
    const p = current.pointer;
    const host = keyOf(p.host);
    const pinKey = this.key(code, "pin");
    const old = JSON.parse(this.storage.getItem(pinKey) ?? "null");
    if (old && (old.host !== host || (p.round === old.round && p.game_seed !== old.seed))) throw new Error(ROOM_CONFLICT);
    if (old && p.round < old.round) throw new Error(ROOM_UNAVAILABLE);
    this.storage.setItem(pinKey, JSON.stringify({ host, round: p.round, seed: p.game_seed }));
  }
  /** No clone is opened before successful resolution. Only the selected seed
   * is opened; an absent lobby means retry, never create on the join path. */
  async lookup(code: string): Promise<{ current: PointerView; raw: any }> {
    const current = await this.resolve(code);
    let raw: any;
    try { raw = await this.hc.callOn(current.pointer.game_seed, "get_game_state", null); }
    catch { throw new Error(ROOM_UNAVAILABLE); }
    if (raw.code == null) throw new Error(ROOM_UNAVAILABLE);
    return { current, raw };
  }
  async join(code: string, name: string): Promise<{ current: PointerView; raw: any }> {
    const found = await this.lookup(code);
    const raw = found.raw;
    // Rejoining an existing seat is idempotent, even once the game started.
    if (raw.my_seat == null) {
      if (raw.phase !== "lobby") throw new Error("This game has already started.");
      if (raw.players.length >= raw.player_count) throw new Error("This game is full.");
      try { await this.hc.callOn(found.current.pointer.game_seed, "join_lobby", { display_name: name }); }
      catch (e) {
        const message = String((e as Error)?.message ?? e);
        if (/game full/i.test(message)) throw new Error("This game is full.");
        if (/already started/i.test(message)) throw new Error("This game has already started.");
        throw new Error(ROOM_UNAVAILABLE);
      }
    }
    return found;
  }
  async create(code: string, hostB64: string, config: { player_count: number; impostor_count: number; task_target: number; display_name: string; settings?: unknown }): Promise<PointerView> {
    code = normalizeRoomCode(code);
    const pendingKey = this.key(code, "pending");
    let pending = JSON.parse(this.storage.getItem(pendingKey) ?? "null");
    if (!pending) {
      if (this.storage.getItem(this.key(code, "pin"))) {
        throw new Error("This room code was already used. Choose a different code.");
      }
      // This check improves UX; it cannot reserve a code or prevent DHT races.
      let result: Resolution;
      try { result = await this.hc.callBase<Resolution>("resolve_room_pointer", code); }
      catch { throw new Error(ROOM_UNAVAILABLE); }
      if (result.status === "conflict" || result.status === "found") throw new Error("This room code is already in use. Choose a different code.");
      if (result.status === "unavailable") throw new Error(ROOM_UNAVAILABLE);
      pending = { seed: newGameSeed(hostB64), config };
      // Persist before opening the clone; retries and reloads keep one game.
      this.storage.setItem(pendingKey, JSON.stringify(pending));
    }
    const seed = pending.seed as string;
    const c = pending.config;
    try {
      const raw: any = await this.hc.callOn(seed, "get_game_state", null);
      if (raw.code == null) await this.hc.callOn(seed, "create_lobby", {
        code: seed, player_count: c.player_count, impostor_count: c.impostor_count,
        task_target: c.task_target, display_name: c.display_name,
      });
      else if (raw.my_seat == null) await this.hc.callOn(seed, "join_lobby", { display_name: c.display_name });
      if (c.settings) await this.hc.callOn(seed, "set_settings", c.settings);
      // Publish only after the lobby and host seat are ready. Keep pending as a
      // recovery receipt: even a lost response retries this exact seed.
      const published = await this.hc.callBase<PointerView>("publish_room_pointer", { room_code: code, game_seed: seed, round: 1, previous: null });
      this.remember(code, published);
      return published;
    } catch (e) {
      if ((e as Error)?.message === ROOM_CONFLICT) throw e;
      throw new Error(ROOM_UNAVAILABLE);
    }
  }
}
