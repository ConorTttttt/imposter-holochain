import { MAP_H, MAP_W, PLAYER_R } from "../game/world.js";
import { CHAT_MAX_LEN, type ChatMsg } from "../game/chat.js";

export const MOVEMENT_PATH = "/gameplay-movement";
export const POSITION_INTERVAL_MS = 100;
export const POSITION_TIMEOUT_MS = 3500;

export type Point = { x: number; y: number };
export type OutgoingChat = Pick<ChatMsg, "k" | "id" | "meeting" | "text">;

export function validChat(value: unknown): value is OutgoingChat {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 4) return false;
  const { k, id, meeting, text } = value as OutgoingChat;
  return k === "chat" && typeof id === "string" && /^[a-f0-9]{16}$/.test(id) &&
    typeof text === "string" && text.length <= CHAT_MAX_LEN && !!text.trim() && !/[\u0000-\u001f\u007f]/.test(text) &&
    typeof meeting === "string" && /^(?:uhCkk[A-Za-z0-9_-]{48}|lobby:g1\.uhCAk[A-Za-z0-9_-]{48}\.[a-f0-9]{32})$/.test(meeting);
}

export function validPosition(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [x, y] = value;
  return Number.isFinite(x) && x >= PLAYER_R && x <= MAP_W - PLAYER_R &&
    Number.isFinite(y) && y >= PLAYER_R && y <= MAP_H - PLAYER_R;
}

// Sign a locally constructed, domain-separated transcript. The relay provides
// only a fresh challenge, never arbitrary bytes for the extension to sign.
export function movementChallenge(origin: string, dna: string, agent: string, nonce: string) {
  return new TextEncoder().encode("imposter/movement/v1\0" + JSON.stringify([origin, dna, agent, nonce]));
}

export async function movementDigest(transcript: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", transcript));
  const prefix = new TextEncoder().encode("imposter/movement/v1\0");
  const message = new Uint8Array(prefix.length + digest.length);
  message.set(prefix);
  message.set(digest, prefix.length);
  return message;
}
