/**
 * Test-only IndexedDB source-chain isolation regression.
 * Every access below is to LOCAL private source-chain state, not DHT data.
 * Two agents share one DNA. A separate seed/DNA is also tested.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SourceChainStorage } from './source-chain-storage';
import type { CreateAction, StoredEntry, Link } from './types';

const dna = new Uint8Array(39).fill(0x31);
const otherDna = new Uint8Array(39).fill(0x32);
const alice = new Uint8Array(39).fill(0x41);
const bob = new Uint8Array(39).fill(0x42);
const hash = (n: number) => new Uint8Array(39).fill(n);
const secret = (n: number) => new Uint8Array([n, 3, 7, 11, 13]);

function privateAction(who: Uint8Array, actionId: number, entryId: number, capGrant = false): CreateAction {
  return {
    actionHash: hash(actionId), actionSeq: capGrant ? 4 : 3,
    author: who, timestamp: BigInt(actionId * 1000), prevActionHash: hash(actionId - 1),
    actionType: 'Create', signature: new Uint8Array(64).fill(actionId),
    entryHash: hash(entryId),
    entryType: capGrant ? 'CapGrant' : { zome_id: 0, entry_index: 7, visibility: 'Private' },
  };
}
function privateEntry(entryId: number, capGrant = false): StoredEntry {
  return {
    entryHash: hash(entryId), entryContent: secret(entryId),
    entryType: capGrant ? 'CapGrant' : { zome_id: 0, entry_index: 7, visibility: 'Private' },
  };
}
async function writePrivatePair(storage: SourceChainStorage, who: Uint8Array, id: number, cellDna = dna) {
  await storage.putAction(privateAction(who, id, id + 1), cellDna, who);
  await storage.putEntry(privateEntry(id + 1), cellDna, who);
  await storage.putAction(privateAction(who, id + 2, id + 3, true), cellDna, who);
  await storage.putEntry(privateEntry(id + 3, true), cellDna, who);
  await storage.updateChainHead(cellDna, who, 4, hash(id + 2), 4000n);
}
async function assertPrivateCell(storage: SourceChainStorage, who: Uint8Array, ownId: number, excludedId: number, cellDna = dna) {
  await storage.preloadChainForCell(cellDna, who);
  expect(storage.queryActions(cellDna, who).map(a => a.actionSeq)).toEqual([3, 4]);
  expect(storage.queryActions(cellDna, who, { actionType: 'Create' })).toHaveLength(2);
  expect(storage.queryActions(cellDna, who).some(a => a.actionType === 'Create' && a.entryType === 'CapGrant')).toBe(true);
  expect(storage.getEntry(hash(ownId + 1))?.entryContent).toEqual(secret(ownId + 1));
  expect(storage.getEntry(hash(ownId + 3))?.entryType).toBe('CapGrant');
  expect(storage.getDetails(hash(ownId + 1), cellDna, who)).not.toBeNull();
  expect(storage.getRecord(hash(ownId))).toBeTruthy();
  // Both the CapGrant and ordinary private entry must be inaccessible.
  expect(storage.getEntry(hash(excludedId + 1))).toBeNull();
  expect(storage.getEntry(hash(excludedId + 3))).toBeNull();
  expect(storage.getAction(hash(excludedId))).toBeNull();
  expect(storage.getAction(hash(excludedId + 2))).toBeNull();
  expect(storage.getActionByEntryHash(hash(excludedId + 3))).toBeNull();
  expect(storage.getDetails(hash(excludedId + 1), cellDna, who)).toBeNull();
  expect(storage.getRecord(hash(excludedId + 2))).toBeNull();
}
describe.sequential('SourceChainStorage — cross-cell private entry and CapGrant isolation', () => {
  let storage: SourceChainStorage;
  beforeEach(async () => {
    storage = SourceChainStorage.getInstance();
    if (storage.isTransactionActive()) storage.rollbackTransaction();
    await storage.init();
    await storage.clear();
  });

  it('does not union different authors in the synchronous action cache, including direct genesis-style writes', async () => {
    await writePrivatePair(storage, alice, 70);
    expect(storage.queryActions(dna, alice)).toHaveLength(2);
    await writePrivatePair(storage, bob, 80);
    // Without preload, only the most recent cell can inhabit the cache.
    expect(storage.queryActions(dna, alice)).toEqual([]);
    expect(storage.getDetails(hash(71), dna, alice)).toBeNull();
    expect(storage.queryActions(dna, bob)).toHaveLength(2);
    expect(storage.queryActions(otherDna, bob)).toEqual([]);
    expect((await storage.getChainHead(dna, alice))?.actionSeq).toBe(4);
    expect((await storage.getChainHead(dna, bob))?.actionSeq).toBe(4);
    expect(await storage.queryActionsFromDb(dna, alice)).toHaveLength(2);
    expect(await storage.queryActionsFromDb(dna, bob)).toHaveLength(2);
    console.log('CELL_ISOLATION_DIRECT_WRITE_PASS', 'same DNA, two agents, separate chain heads');
  });

  it('keeps other agents private entries and CapGrants inaccessible after alternating preloads and restart', async () => {
    await writePrivatePair(storage, alice, 70);
    await writePrivatePair(storage, bob, 80);
    const restarted = new (SourceChainStorage as unknown as new () => SourceChainStorage)();
    await restarted.init();
    await assertPrivateCell(restarted, alice, 70, 80);
    expect(restarted.queryActions(dna, bob)).toEqual([]);
    expect(restarted.getDetails(hash(81), dna, bob)).toBeNull();
    await assertPrivateCell(restarted, bob, 80, 70);
    expect(restarted.queryActions(dna, alice)).toEqual([]);
    await assertPrivateCell(restarted, alice, 70, 80);
    console.log('CELL_ISOLATION_PRIVATE_CAPGRANT_PASS', 'A→B→A / same DNA / persisted');
  });

  it('isolates local links and another DNA even when agent and base hash match', async () => {
    const base = hash(110);
    const makeLink = (who: Uint8Array, id: number): Link => ({
      createLinkHash: hash(id), baseAddress: base, targetAddress: hash(id + 1),
      timestamp: 777n, zomeIndex: 0, linkType: 0, tag: new Uint8Array([1]),
      author: who, deleted: false,
    });
    await storage.putLink(makeLink(alice, 111), dna, alice);
    await storage.putLink(makeLink(bob, 121), dna, bob);
    await storage.putLink(makeLink(alice, 131), otherDna, alice);
    await storage.preloadChainForCell(dna, alice);
    expect(storage.getLinks(base, dna, alice).map(l => Array.from(l.targetAddress))).toEqual([Array.from(hash(112))]);
    expect(storage.getLinks(base, dna, bob)).toEqual([]);
    expect(storage.getLinks(base, otherDna, alice)).toEqual([]);
    await storage.preloadChainForCell(dna, bob);
    expect(storage.getLinks(base, dna, bob).map(l => Array.from(l.targetAddress))).toEqual([Array.from(hash(122))]);
    await storage.preloadChainForCell(otherDna, alice);
    expect(storage.getLinks(base, otherDna, alice).map(l => Array.from(l.targetAddress))).toEqual([Array.from(hash(132))]);
    console.log('CELL_ISOLATION_LINKS_DNA_PASS');
  });
});
