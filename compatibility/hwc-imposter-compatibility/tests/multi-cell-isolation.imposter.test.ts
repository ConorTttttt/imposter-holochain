import { describe, expect, it } from 'vitest';
import { SourceChainStorage } from './source-chain-storage';
import type { CreateAction, StoredEntry } from './types';
import 'fake-indexeddb/auto';

/** Two agents on the same DNA, each authoring a private system CapGrant. */
describe.sequential('P0 multi-cell source-chain isolation', () => {
  it('blocks cross-agent private CapGrant, action and record reads', async () => {
    const db = SourceChainStorage.getInstance();
    await db.init();
    await db.clear();
    const dna = new Uint8Array(39).fill(1);
    const a = new Uint8Array(39).fill(2);
    const b = new Uint8Array(39).fill(3);
    const ah = new Uint8Array(39).fill(4);
    const bh = new Uint8Array(39).fill(5);
    const ae = new Uint8Array(39).fill(6);
    const be = new Uint8Array(39).fill(7);
    const action = (author: Uint8Array, actionHash: Uint8Array, entryHash: Uint8Array): CreateAction => ({
      actionHash, actionSeq: 3, author, timestamp: 1000n, prevActionHash: null,
      actionType: 'Create', signature: new Uint8Array(64).fill(1),
      entryHash, entryType: 'CapGrant',
    });
    const entry = (entryHash: Uint8Array, marker: number): StoredEntry => ({
      entryHash, entryContent: new Uint8Array([0x81, marker]), entryType: 'CapGrant',
    });
    await db.putAction(action(a, ah, ae), dna, a);
    await db.putEntry(entry(ae, 11), dna, a);
    await db.putAction(action(b, bh, be), dna, b);
    await db.putEntry(entry(be, 22), dna, b);

    await db.preloadChainForCell(dna, a);
    expect(db.queryActions(dna, a).map(x => [...x.author])).toEqual([[...a]]);
    expect(db.queryActions(dna, b)).toEqual([]);
    expect(db.getAction(ah)?.actionType).toBe('Create');
    expect(db.getAction(bh)).toBeNull();
    expect(db.getEntry(ae)?.entryType).toBe('CapGrant');
    expect(db.getEntry(be)).toBeNull();
    expect(db.getActionByEntryHash(be)).toBeNull();
    expect(db.getDetails(be, dna, a)).toBeNull();
    expect(await db.queryActionsFromDb(dna, a)).toHaveLength(1);
    expect(await db.queryActionsFromDb(dna, b)).toHaveLength(1);

    await db.preloadChainForCell(dna, b);
    expect(db.queryActions(dna, b).map(x => [...x.author])).toEqual([[...b]]);
    expect(db.queryActions(dna, a)).toEqual([]);
    expect(db.getAction(bh)?.actionType).toBe('Create');
    expect(db.getAction(ah)).toBeNull();
    expect(db.getEntry(be)?.entryType).toBe('CapGrant');
    expect(db.getEntry(ae)).toBeNull();
    expect(db.getActionByEntryHash(ae)).toBeNull();
    expect(db.getDetails(ae, dna, b)).toBeNull();
    console.log('MULTI_CELL_PRIVATE_CAPGRANT_ISOLATION_PASS', {dna: 'same', agents: 2});
  });

  it('binds first transaction write and rejects changing the author before commit', async () => {
    const db = SourceChainStorage.getInstance();
    await db.init();
    await db.clear();
    const dna = new Uint8Array(39).fill(1);
    const a = new Uint8Array(39).fill(2);
    const b = new Uint8Array(39).fill(3);
    const makeAction = (author: Uint8Array, hashByte: number): CreateAction => ({
      actionHash: new Uint8Array(39).fill(hashByte),
      actionSeq: 0,
      author,
      timestamp: 1000n,
      prevActionHash: null,
      actionType: 'Create',
      signature: new Uint8Array(64).fill(1),
      entryHash: new Uint8Array(39).fill(hashByte + 2),
      entryType: 'CapGrant',
    });
    const aliceAction = makeAction(a, 0x41);
    const bobAction = makeAction(b, 0x42);
    db.beginTransaction();
    await expect(db.putAction(aliceAction, dna, a)).resolves.toBeUndefined();
    await expect(db.putAction(bobAction, dna, b)).rejects.toThrow(
      'Cross-cell source-chain operation inside active transaction',
    );
    expect(db.queryActions(dna, a)).toHaveLength(1);
    expect(db.queryActions(dna, b)).toHaveLength(0);
    db.rollbackTransaction();
    expect(db.getAction(aliceAction.actionHash)).toBeNull();
  });
});
