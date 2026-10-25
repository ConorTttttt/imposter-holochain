import { sha256 } from "@noble/hashes/sha2.js";

// Must match `imposter_core::vote::commitment` byte-for-byte:
//   "imposter:vote:v1" ‖ (0x00 | 0x01 ‖ key) ‖ salt
const TAG = new TextEncoder().encode("imposter:vote:v1");

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `choice` is the raw AgentPubKey bytes (39), or `null` for Skip. */
export function voteCommitment(choice: Uint8Array | null, salt: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [TAG];
  parts.push(choice === null ? Uint8Array.of(0) : Uint8Array.of(1));
  if (choice !== null) parts.push(choice);
  parts.push(salt);
  return sha256(concat(parts));
}

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
