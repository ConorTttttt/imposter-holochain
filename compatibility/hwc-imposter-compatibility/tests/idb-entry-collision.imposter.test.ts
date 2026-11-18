import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SourceChainStorage } from './source-chain-storage';
import type { CreateAction } from './types';
import { encodeHashToBase64 } from '../types/holochain-types';

const NAME = 'hwc_source_chain';
const dna = new Uint8Array(39).fill(0x51);
const alice = new Uint8Array(39).fill(0x52);
const bob = new Uint8Array(39).fill(0x53);
const sharedHash = new Uint8Array(39).fill(0x54);
const grantBytes = new TextEncoder().encode('P0-test-only-private-CapGrant-must-never-publish');
const cell = (agent: Uint8Array) =>
  encodeHashToBase64(dna) + ':' + encodeHashToBase64(agent);
const makeAction = (agent: Uint8Array, marker: number): CreateAction => ({
  actionHash: new Uint8Array(39).fill(marker), author: agent, actionSeq: 4,
  timestamp: 4000n, prevActionHash: new Uint8Array(39).fill(0x21),
  actionType: 'Create', signature: new Uint8Array(64).fill(marker),
  entryHash: sharedHash, entryType: 'CapGrant',
});
function open(version: number, upgrade?: (db: IDBDatabase, tx: IDBTransaction) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NAME, version);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction!);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
function remove() {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB database remains open'));
  });
}
async function seedLegacy(owner: Uint8Array, conflicting = false) {
  const db = await open(1, raw => {
    raw.createObjectStore('actions', { keyPath: 'actionHash' })
      .createIndex('cellId', 'cellId', { unique: false });
    raw.createObjectStore('entries', { keyPath: 'entryHash' })
      .createIndex('cellId', 'cellId', { unique: false });
    raw.createObjectStore('links', { keyPath: 'createLinkHash' });
    raw.createObjectStore('chainHeads', { keyPath: 'cellId' });
  });
  const tx = db.transaction(['entries', 'actions'], 'readwrite');
  tx.objectStore('entries').put({
    cellId: cell(owner), entryHash: Array.from(sharedHash), entryContent: Array.from(grantBytes),
    entryType: 'CapGrant',
  });
  if (conflicting) {
    tx.objectStore('actions').put({
      actionHash: Array.from(new Uint8Array(39).fill(0x71)),
      cellId: cell(bob), actionType: 'Create', entryHash: Array.from(sharedHash),
    });
  }
  await complete(tx);
  db.close();
}

describe.sequential('P0 IndexedDB v1 migration, CapGrant identical hash and restart', () => {
  it('preserves legacy owner, stores identical second private grant under same DNA, reloads without leak', async () => {
    const db = SourceChainStorage.getInstance();
    db.closeForTests();
    await remove();
    await seedLegacy(alice);
    await db.init();  // Migrates existing v1 to composite cell+entryHash.
    await db.putAction(makeAction(alice, 0x61), dna, alice);
    await db.putAction(makeAction(bob, 0x62), dna, bob);
    await db.putEntry({entryHash: sharedHash, entryContent: grantBytes, entryType: 'CapGrant'}, dna, bob);
    await db.preloadChainForCell(dna, alice);
    expect(db.getEntry(sharedHash)?.entryContent).toEqual(grantBytes);
    expect((await (db as any).getEntryFromDB(sharedHash))?.entryContent).toEqual(grantBytes);
    expect(db.getAction(makeAction(bob, 0x62).actionHash)).toBeNull();
    await db.preloadChainForCell(dna, bob);
    expect(db.getEntry(sharedHash)?.entryContent).toEqual(grantBytes);
    expect(db.getAction(makeAction(alice, 0x61).actionHash)).toBeNull();

    db.closeForTests();
    await db.init();
    await db.preloadChainForCell(dna, alice);
    expect(db.getEntry(sharedHash)?.entryContent).toEqual(grantBytes);
    await db.preloadChainForCell(dna, bob);
    expect(db.getEntry(sharedHash)?.entryContent).toEqual(grantBytes);
    await db.preloadChainForCell(dna, new Uint8Array(39).fill(0x55));
    expect(db.getEntry(sharedHash)).toBeNull();
    expect(await (db as any).getEntryFromDB(sharedHash)).toBeNull();

    const raw = await open(2);
    const tx = raw.transaction('entries', 'readonly');
    const all = await new Promise<any[]>((resolve, reject) => {
      const r = tx.objectStore('entries').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e: any) => e.cellId))).toEqual(new Set([cell(alice), cell(bob)]));
    expect(all.every((e: any) => JSON.stringify(e.entryContent) === JSON.stringify([...grantBytes]))).toBe(true);
    raw.close();
    db.closeForTests();
    console.log('IDB_LEGACY_AND_IDENTICAL_CAPGRANT_RESTART_PASS', { cells: 2, rows: 2 });
  });

  it('aborts legacy migration rather than inventing a previously overwritten owner', async () => {
    const db = SourceChainStorage.getInstance();
    db.closeForTests();
    await remove();
    await seedLegacy(alice, true);
    await expect(db.init()).rejects.toBeTruthy();
    db.closeForTests();
    const raw = await open(1); // A failed upgrade must leave v1 untouched.
    expect(raw.version).toBe(1);
    expect(raw.transaction('entries').objectStore('entries').keyPath).toBe('entryHash');
    raw.close();
  });
});
