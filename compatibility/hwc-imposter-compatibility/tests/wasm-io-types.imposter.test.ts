/** Holochain 0.7 CreateInput capability variants: regression for Imposter init(). */
import { describe, it, expect } from 'vitest';
import { validateWasmCreateInput, validateWasmUpdateInput } from './wasm-io-types';

const grant = {
  tag: 'synthetic-grant',
  access: { type: 'unrestricted' },
  functions: { type: 'listed', value: [['game', 'recv_remote_signal']] },
};

describe('WasmCreateInput capability locations', () => {
  it('accepts a private, structured CapGrant system entry', () => {
    expect(validateWasmCreateInput({
      entry_location: 'CapGrant', entry_visibility: 'Private',
      entry: { entry_type: 'CapGrant', entry: grant }, chain_top_ordering: 'Strict',
    })).toBe(true);
  });
  it('accepts a private, structured CapClaim system entry', () => {
    expect(validateWasmCreateInput({
      entry_location: 'CapClaim', entry_visibility: 'Private',
      entry: { entry_type: 'CapClaim', entry: { tag: 'synthetic', grantor: new Uint8Array(39) } },
      chain_top_ordering: 'Strict',
    })).toBe(true);
  });
  it('rejects public, mismatched and malformed capability locations', () => {
    for (const entry_location of ['CapGrant', 'CapClaim'] as const) {
      const base = { entry_location, entry_visibility: 'Private',
        entry: { entry_type: entry_location, entry: grant }, chain_top_ordering: 'Strict' };
      expect(validateWasmCreateInput({ ...base, entry_visibility: 'Public' })).toBe(false);
      expect(validateWasmCreateInput({ ...base, entry: { entry_type: 'App', entry: new Uint8Array([1]) } })).toBe(false);
      expect(validateWasmCreateInput({ ...base, entry: { entry_type: entry_location, entry: new Uint8Array([1]) } })).toBe(false);
    }
  });
  it('preserves App bytes and user-requested app visibility', () => {
    const app = { entry_location: { App: { zome_index: 0, entry_def_index: 1 } },
      entry_visibility: 'Private', entry: { entry_type: 'App', entry: new Uint8Array([17,18]) },
      chain_top_ordering: 'Strict' };
    expect(validateWasmCreateInput(app)).toBe(true);
    expect(validateWasmCreateInput({ ...app, entry: { entry_type: 'CapGrant', entry: grant } })).toBe(false);
  });
  it('allows structured system update payloads for type-matched source-chain updates', () => {
    expect(validateWasmUpdateInput({ original_action_address: new Uint8Array(39),
      entry: { entry_type: 'CapGrant', entry: grant }, chain_top_ordering: 'Strict' })).toBe(true);
  });
});
