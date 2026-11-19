import { MAP_H, MAP_W, PLAYER_R } from "../game/world.js";

export const MOVEMENT_PATH = "/gameplay-movement";
export const POSITION_INTERVAL_MS = 100;
export const POSITION_TIMEOUT_MS = 3500;

export type Point = { x: number; y: number };

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
