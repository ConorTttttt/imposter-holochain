/** Capability entry hash is computed over the entire internally-tagged Entry enum. */
import { describe, it, expect } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { blake2b256, computeAppEntryHash, computeSystemEntryHash, hashFrom32AndType, HoloHashType } from './index';
import { storedEntryToClientEntry } from '../dht/record-converter';
import type { StoredEntry } from '../storage/types';

const grant = { tag: 'synthetic-grant', access: { type: 'unrestricted' },
  functions: { type: 'listed', value: [['game', 'recv_remote_signal']] } };

describe('Capability system entry hashing', () => {
  it('hashes CapGrant as a system variant rather than App', () => {
    const h = computeSystemEntryHash('CapGrant', grant);
    const expected = hashFrom32AndType(
      blake2b256(new Uint8Array(encode({ entry_type: 'CapGrant', entry: grant }))),
      HoloHashType.Entry,
    );
    expect(h).toEqual(expected);
    expect(h).not.toEqual(computeAppEntryHash(new Uint8Array(encode(grant))));
  });
  it('round-trips private capability payloads in LOCAL source-chain storage', () => {
    const stored: StoredEntry = { entryHash: new Uint8Array(39),
      entryType: 'CapGrant', entryContent: new Uint8Array(encode(grant)) };
    const local = storedEntryToClientEntry(stored) as any;
    expect(local.entry_type).toBe('CapGrant');
    expect(local.entry).toEqual(decode(stored.entryContent));
  });
});
