/** Synthetic-only confidentiality and wire-payload regression tests. */
import { describe, expect, it } from 'vitest';
import type { Record as ClientRecord } from '@holochain/client';
import type { CreateAction, StoredEntry } from '../storage/types';
import { buildRecord, storedEntryToClientEntry } from './record-converter';
import { produceOpsFromRecord } from './produce-ops';
import { ChainOpType } from './dht-op-types';
import { serializeOpForLinker } from './op-serialization';

const syntheticBytes = new TextEncoder().encode('synthetic-private-roles-DO-NOT-PUBLISH');
const key = new Uint8Array(39).fill(7);
const signature = new Uint8Array(64).fill(8);

function action(visibility: 'Private' | 'Public'): CreateAction {
  return {
    actionHash: key, actionSeq: 4, author: key,
    timestamp: 1000000n, prevActionHash: key, actionType: 'Create',
    signature, entryHash: key, entryType: { zome_id: 0, entry_index: 12, visibility },
  };
}
function entry(visibility: 'Private' | 'Public'): StoredEntry {
  return { entryHash: key, entryContent: syntheticBytes,
    entryType: { zome_id: 0, entry_index: 12, visibility } };
}
function contains(haystack: Uint8Array, needle: Uint8Array) {
  return haystack.some((_, i) => needle.every((b, j) => haystack[i+j] === b));
}

describe('HWC private entry publication', () => {
  it('retains signed Private visibility and keeps the entry local', () => {
    const stored = action('Private');
    const localEntry = storedEntryToClientEntry(entry('Private'));
    expect(localEntry.entry).toEqual(syntheticBytes);
    const published = buildRecord(stored, entry('Private'));
    const wireType = (published.signed_action.hashed.content as any).data.entry_type;
    expect(wireType.App.visibility).toBe('Private');
    expect(published.entry).toBe('Hidden');
  });
  it('never produces public entry-authority ops or transmits private content', () => {
    const published = buildRecord(action('Private'), entry('Private'));
    const ops = produceOpsFromRecord(published);
    expect(ops.some(op => op.type === ChainOpType.CreateEntry)).toBe(false);
    for (const op of ops) expect(contains(serializeOpForLinker(op), syntheticBytes)).toBe(false);
  });
  it('republishing with an absent entry still encodes the private record as Hidden', () => {
    const published = buildRecord(action('Private'), undefined);
    expect(published.entry).toBe('Hidden');
    for (const op of produceOpsFromRecord(published)) {
      expect(contains(serializeOpForLinker(op), syntheticBytes)).toBe(false);
    }
  });
  it('sanitizes unsafely constructed Present private records at the DHT producer boundary', () => {
    const a = action('Private');
    const clean = buildRecord(a, entry('Private'));
    const dirty = { ...clean, entry: { Present: { entry_type: 'App', entry: syntheticBytes } } } as unknown as ClientRecord;
    const ops = produceOpsFromRecord(dirty);
    expect(ops.some(op => op.type === ChainOpType.CreateEntry)).toBe(false);
    for (const op of ops) expect(contains(serializeOpForLinker(op), syntheticBytes)).toBe(false);
  });
  it('keeps public entries and their CreateEntry DHT operations working', () => {
    const published = buildRecord(action('Public'), entry('Public'));
    expect(typeof published.entry).toBe('object');
    const ops = produceOpsFromRecord(published);
    expect(ops.some(op => op.type === ChainOpType.CreateEntry)).toBe(true);
    expect(ops.some(op => contains(serializeOpForLinker(op), syntheticBytes))).toBe(true);
  });
  it('fails closed when pre-upgrade action metadata lacks entry visibility', () => {
    const legacy = action('Public');
    legacy.entryType = { zome_id: 0, entry_index: 12 };
    expect(() => buildRecord(legacy, entry('Public'))).toThrow(/visibility missing/);
  });
});
