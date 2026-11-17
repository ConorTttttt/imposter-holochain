/** Persistence and cell isolation: synthetic data, never actual Imposter roles. */
import "fake-indexeddb/auto";
import { describe, expect, it } from 'vitest';
import { SourceChainStorage } from './source-chain-storage';
import type { CreateAction, StoredEntry } from './types';

const dna = new Uint8Array(32).fill(71);
const author = new Uint8Array(32).fill(72);
const stranger = new Uint8Array(32).fill(73);
const privateHash = new Uint8Array(39).fill(74);
const privateActionHash = new Uint8Array(39).fill(75);
const synthetic = new TextEncoder().encode('synthetic-only-private-fixture');

function reopen(): SourceChainStorage {
  // Deliberately create a fresh IDB handle to simulate a new browser worker.
  const Constructor = SourceChainStorage as unknown as new () => SourceChainStorage;
  return new Constructor();
}

describe('private source-chain persistence and isolation', () => {
  it('recovers private data for author but not a different agent after reopening', async () => {
    const storage = SourceChainStorage.getInstance();
    await storage.init();
    await storage.clear();
    const action: CreateAction = {
      actionHash: privateActionHash, actionSeq: 4, author, timestamp: 4000n,
      prevActionHash: new Uint8Array(39).fill(76), actionType: 'Create',
      signature: new Uint8Array(64).fill(77), entryHash: privateHash,
      entryType: { zome_id: 0, entry_index: 11, visibility: 'Private' },
    };
    const entry: StoredEntry = {
      entryHash: privateHash, entryContent: synthetic,
      entryType: { zome_id: 0, entry_index: 11, visibility: 'Private' },
    };
    await storage.putAction(action, dna, author);
    await storage.putEntry(entry, dna, author);

    const restarted = reopen();
    await restarted.init();
    await restarted.preloadChainForCell(dna, author);
    const local = restarted.getEntry(privateHash);
    expect(local?.entryContent).toEqual(synthetic);
    expect((restarted.getAction(privateActionHash) as CreateAction)?.entryType).toEqual(action.entryType);

    // Same runtime, different cell: do not reuse the previous agent's cache.
    await restarted.preloadChainForCell(dna, stranger);
    expect(restarted.getEntry(privateHash)).toBeNull();
    expect(restarted.getAction(privateActionHash)).toBeNull();
  });
});
