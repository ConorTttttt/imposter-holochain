// A browser key store for the PeerKit identity, persisted in localStorage so a
// reload keeps the same movement identity for a lobby. Lifted from the
// blackjack `web/keystore.ts`.
import type { IAgentKeyStore } from "@peerkit/api";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export class LocalStorageAgentKeyStore implements IAgentKeyStore {
  constructor(private readonly key: string) {}

  async loadKey(): Promise<Uint8Array | undefined> {
    try {
      const hex = localStorage.getItem(this.key);
      if (!hex) return undefined;
      const bytes = hexToBytes(hex);
      return bytes.length === 32 ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  async storeKey(privateKey: Uint8Array): Promise<void> {
    try {
      localStorage.setItem(this.key, bytesToHex(privateKey));
    } catch {
      // storage disabled -> fresh identity each load; fine for one sitting.
    }
  }
}
