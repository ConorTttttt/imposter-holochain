/** Unit-level dna_info_v2 regression; does not replace real WASM execution. */
import { describe, it, expect, vi } from 'vitest';
import { decode } from '@msgpack/msgpack';
import { dnaInfoV2 } from './dna_info';

vi.mock('../serialization', () => ({
  serializeResult: (_instance: unknown, result: unknown) => result,
}));

describe('dna_info_v2 role-level network seed', () => {
  it('returns the effective host-bound seed and properties supplied in the runtime manifest', () => {
    const seed = 'g1.uhCAkSyntheticThisIsNotAnActualUserKey.0123456789abcdef0123456789abcdef';
    const result = (dnaInfoV2 as any)({
      instance: {},
      callContext: {
        cellId: [new Uint8Array(39).fill(13), new Uint8Array(39).fill(14)],
        dnaManifest: { name: 'imposter', network_seed: seed, properties: { test: 7 },
          integrity_zomes: [{ name: 'game_integrity' }], coordinator_zomes: [{ name: 'game' }] },
      },
    }, 0, 0);
    expect(result.modifiers.network_seed).toBe(seed);
    expect(decode(result.modifiers.properties)).toEqual({ test: 7 });
    expect(result.zome_names).toEqual(['game_integrity', 'game']);
  });
});
