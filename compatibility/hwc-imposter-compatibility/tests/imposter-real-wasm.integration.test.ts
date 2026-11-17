/**
 * Real Imposter WASM compatibility probe. Consumes Agent 4's immutable,
 * checksummed, synthetic-host artifact. No Rust/gameplay rule changes.
 *
 * IMPORTANT: Node fake-indexeddb + mocked signatures are a controlled guest
 * execution test. They are NOT a production browser worker / HWC Lair test.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@msgpack/msgpack';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeHashFromBase64, HoloHashType } from '@holochain/client';
import { SourceChainStorage, setStorageProvider } from '../storage';
import { hashFrom32AndType } from '../hash';
import { buildRecord } from '../dht/record-converter';
import { setLairClient } from '../signing';
import { callZomeAsExtension } from './test-helpers';
import { initializeGenesis } from '../storage/genesis';
import type { DnaManifestRuntime } from '../types/bundle-types';
import type { LairClient } from '@holo-host/lair';
import 'fake-indexeddb/auto';

interface Fixture {
  metadata: {
    host_identity_source: string;
    deployment_ready: boolean;
    signature_status: string;
    runtime_validation: string;
    network_seed: string;
    host_agent_pub_key: string;
    dna_hash: string;
    wasm_sha256: { game: string; game_integrity: string };
  };
  dna: Uint8Array;
  agent: Uint8Array;
  coordinator: Uint8Array;
  integrity: Uint8Array;
  manifest: DnaManifestRuntime;
}
let fixture: Fixture;
let storage: SourceChainStorage;

function readFixture(): Fixture {
  const dir = process.env.HWC_IMPOSTER_FIXTURE;
  if (!dir) throw Error('HWC_IMPOSTER_FIXTURE was not provided by the verified artifact download step');
  const m = JSON.parse(readFileSync(join(dir, 'deployment.json'), 'utf8')) as Fixture['metadata'];
  const game = new Uint8Array(readFileSync(join(dir, 'dna/game.wasm')));
  const integrity = new Uint8Array(readFileSync(join(dir, 'dna/game_integrity.wasm')));
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  expect(m.host_identity_source).toBe('SYNTHETIC_CI_FIXTURE');
  expect(m.deployment_ready).toBe(false);
  expect(m.runtime_validation).toBe('NOT_RUN');
  expect(m.signature_status).toBe('UNSIGNED');
  expect(sha(game)).toBe(m.wasm_sha256.game);
  expect(sha(integrity)).toBe(m.wasm_sha256.game_integrity);
  expect(m.network_seed.split('.')[1]).toBe(m.host_agent_pub_key);
  const yaml = readFileSync(join(dir, 'dna/dna.yaml'), 'utf8');
  const happ = readFileSync(join(dir, 'app/happ.yaml'), 'utf8');
  expect(yaml).toContain('network_seed: ' + m.network_seed);
  expect(happ).toContain('network_seed: ' + m.network_seed);
  expect(happ).toContain('installed_hash: ' + m.dna_hash);
  const dna = decodeHashFromBase64(m.dna_hash);
  const agent = decodeHashFromBase64(m.host_agent_pub_key);
  const manifest: DnaManifestRuntime = {
    name: 'game',
    network_seed: m.network_seed,
    properties: {},
    integrity_zomes: [{ name: 'game_integrity', index: 0, wasm: integrity, dependencies: [] }],
    coordinator_zomes: [{ name: 'game', index: 1, wasm: game, dependencies: ['game_integrity'] }],
  };
  return { metadata: m, dna, agent, coordinator: game, integrity, manifest };
}

function syntheticTestSigner(): LairClient {
  // Synthetic artifact's host public key HAS NO PRIVATE KEY. Only use mock
  // signatures to probe HWC guest ABI and source chain; never trust as auth.
  return {
    signSync(_pubKey: Uint8Array, data: Uint8Array) {
      const sig = new Uint8Array(64);
      for (let i = 0; i < sig.length; i++) sig[i] = (data[i % (data.length || 1)] || 0) ^ i;
      return sig;
    },
    async signByPubKey(pubKey: Uint8Array, data: Uint8Array) {
      return this.signSync(pubKey, data);
    },
    async preloadKeyForSync() {},
    hasPreloadedKey() { return true; },
    async generateSigningKeypair() { return new Uint8Array(32); },
    async listEntries() { return []; },
    async importSeed() { return new Uint8Array(32); },
    async exportSeed() { return new Uint8Array(32); },
    async close() {},
  } as unknown as LairClient;
}

function call(fn: string, payload: unknown, agent = fixture.agent) {
  return callZomeAsExtension({
    dnaWasm: fixture.coordinator,
    cellId: [fixture.dna, agent],
    zome: 'game',
    fn,
    payload,
    provenance: agent,
    dnaManifest: fixture.manifest,
  });
}

function actionSnapshot(agent = fixture.agent) {
  return storage.queryActions(fixture.dna, agent).map(a => ({
    type: a.actionType, seq: a.actionSeq, hash: Buffer.from(a.actionHash).toString('hex'),
    prev: a.prevActionHash ? Buffer.from(a.prevActionHash).toString('hex') : null,
    entryType: 'entryType' in a ? (a as any).entryType : null,
  }));
}

describe.sequential('Agent 2 — actual Imposter 0.7 WASMs in patched HWC', () => {
  beforeAll(async () => {
    fixture = readFixture();
    // Native WASM compilation validation precedes all mocked-signature calls.
    const gameModule = await WebAssembly.compile(new Uint8Array(fixture.coordinator));
    const integrityModule = await WebAssembly.compile(new Uint8Array(fixture.integrity));
    const fnExports = WebAssembly.Module.exports(gameModule).filter(e => e.kind === 'function').map(e => e.name);
    expect(fnExports).toContain('init');
    expect(fnExports).toContain('create_lobby');
    expect(fnExports).toContain('ping');
    expect(WebAssembly.Module.exports(integrityModule).map(e => e.name)).toContain('validate');
    console.log('REAL_WASM_COMPILED', JSON.stringify({
      gameBytes: fixture.coordinator.length,
      integrityBytes: fixture.integrity.length,
      gameExports: fnExports.length,
      gameImports: WebAssembly.Module.imports(gameModule).length,
      integrityImports: WebAssembly.Module.imports(integrityModule).length,
    }));
    setLairClient(syntheticTestSigner());
    storage = SourceChainStorage.getInstance();
    await storage.init();
    setStorageProvider(storage as any);
    await storage.clear();
  });

  it('executes real game::init via HWC genesis, persists exactly one private capability grant, and completes genesis', async () => {
    try {
      const result = await call('ping', null);
      console.log('FIRST_REAL_GUEST_RETURN', JSON.stringify(result.result));
    } catch (error) {
      console.error('FIRST_REAL_WASM_HWC_FAILURE', error instanceof Error ? error.stack : String(error));
      console.error('FIRST_REAL_WASM_PARTIAL_CHAIN', JSON.stringify(actionSnapshot()));
      throw error;
    }
    const acts = storage.queryActions(fixture.dna, fixture.agent);
    console.log('REAL_WASM_GENESIS_ACTIONS', JSON.stringify(actionSnapshot()));
    expect(acts.slice(0, 3).map(a => a.actionType)).toEqual(['Dna', 'AgentValidationPkg', 'Create']);
    const grants = acts.filter(a => a.actionType === 'Create' && 'entryType' in a && a.entryType === 'CapGrant');
    expect(grants).toHaveLength(1);
    const grant = grants[0] as any;
    const stored = storage.getEntry(grant.entryHash);
    console.log('REAL_WASM_CAP_GRANT', JSON.stringify({
      entryType: grant.entryType,
      visibility: (stored?.entryType as any)?.visibility ?? (grant as any).visibility ?? null,
      bytes: stored?.entryContent?.length ?? null,
      grantSeq: grant.actionSeq,
      grantHash: Buffer.from(grant.entryHash).toString('hex'),
    }));
    expect(stored).toBeDefined();
    // Holochain stores system CapGrant entries privately, never as App/Public.
    expect(grant.entryType).toBe('CapGrant');
    // Holochain CapGrant is a private system-entry variant (no App.visibility
    // field). The actual network-facing record must hide its body.
    expect(buildRecord(grant, stored ?? undefined).entry).toBe('Hidden');
    const grantFields = decode(stored!.entryContent as Uint8Array);
    console.log('REAL_WASM_CAP_GRANT_DECODED', JSON.stringify(grantFields));
    expect(JSON.stringify(grantFields)).toContain('remote-signals');
    expect(JSON.stringify(grantFields)).toContain('recv_remote_signal');
    expect(acts.filter(a => a.actionType === 'InitZomesComplete')).toHaveLength(1);
    expect(acts.at(-1)?.actionType).toBe('InitZomesComplete');
    expect(grant.actionSeq).toBeLessThan(acts.at(-1)!.actionSeq);
    for (let i = 1; i < acts.length; i++) {
      expect(acts[i].actionSeq).toBe(acts[i-1].actionSeq + 1);
      expect(Buffer.from(acts[i].prevActionHash || [])).toEqual(Buffer.from(acts[i-1].actionHash));
    }
  }, 90000);

  it('does not rerun init or duplicate grants on subsequent guest calls', async () => {
    const before = actionSnapshot();
    await call('ping', null);
    const after = actionSnapshot();
    expect(after).toEqual(before);
    console.log('REAL_WASM_INIT_IDEMPOTENCE_PASS', before.length);
  }, 90000);

  it('has real guest branch observing a nonempty DNA network seed', async () => {
    // Actual game::resolve_room_pointer calls registry_only(), which uses
    // dna_info()?.modifiers.network_seed. It MUST reject seeded game cells.
    // This proves the guest observes a nonempty seed, not the complete string:
    // exact equality is separately asserted against the bundle + host manifest.
    await expect(call('resolve_room_pointer', 'ABCD')).rejects.toThrow(/room registry requires the base game cell/);
    console.log('REAL_WASM_GUEST_SEED_BRANCH_PASS', JSON.stringify({
      manifestSeed: fixture.manifest.network_seed,
      packagedHash: fixture.metadata.dna_hash,
      runtimeCellDnaHash: Buffer.from(fixture.dna).toString('hex'),
      scope: 'guest proves nonempty; exact hash/seed equality checked in fixture, not direct guest return',
    }));
  }, 90000);

  it('records native validator blocker: Agent 4 synthetic host hash is not canonical', async () => {
    // Unlike a real HoloHash, Agent 4's synthetic key has random 4-byte DHT
    // location bytes rather than a checksum-derived location. Reject the
    // *artifact*, never relax the original Rust validator.
    const canonical = hashFrom32AndType(fixture.agent.subarray(3, 35), HoloHashType.Agent);
    expect(Buffer.from(canonical).equals(Buffer.from(fixture.agent))).toBe(false);
    const before = actionSnapshot().length;
    const input = {
      code: 'DEMO-AGENT2', player_count: 3,
      impostor_count: 1, task_target: 5, display_name: 'SyntheticHost',
    };
    await expect(call('create_lobby', input))
      .rejects.toThrow(/invalid game seed: the host isn't an agent key/);
    expect(actionSnapshot()).toHaveLength(before);
    console.log('REAL_WASM_HOST_AUTHORIZATION_BLOCKED_INVALID_SYNTHETIC_HASH', JSON.stringify({
      packedDnaHash: fixture.metadata.dna_hash,
      hostKeyCanonical: false,
      integrityValidatorUnchanged: true,
      implication: 'Host authorization cannot pass until a correctly encoded synthetic AgentPubKey is repackaged with hc',
    }));
  }, 90000);

  it('also rejects non-host lobby attempts; does NOT claim owner check passed', async () => {
    const other = hashFrom32AndType(new Uint8Array(32).fill(0x35), HoloHashType.Agent);
    const input = {
      code: 'UNAUTH-AGENT2', player_count: 3, impostor_count: 1,
      task_target: 5, display_name: 'NonHost',
    };
    await expect(call('create_lobby', input, other))
      .rejects.toThrow(/invalid game seed: the host isn't an agent key/);
    const unauthorized = storage.queryActions(fixture.dna, other)
      .filter(a => a.actionType === 'Create' && 'entryType' in a && (a as any).entryType?.entry_index === 0);
    expect(unauthorized).toHaveLength(0);
    console.log('REAL_WASM_NONHOST_AUTHORIZATION_UNVERIFIED',
      JSON.stringify({ reason: 'Invalid fixture host key, NOT an author-mismatch verdict' }));
  }, 90000);

  it('rejects an interrupted genesis missing InitZomesComplete', async () => {
    const interrupted = hashFrom32AndType(new Uint8Array(32).fill(0x61), HoloHashType.Agent);
    const g = await initializeGenesis(storage as any, fixture.dna, interrupted, undefined, true);
    expect(g.initialized).toBe(true);
    const partial = storage.queryActions(fixture.dna, interrupted);
    console.log('REAL_WASM_INTERRUPTED_GENESIS_BEFORE', JSON.stringify(partial.map(a => a.actionType)));
    expect(partial.map(a => a.actionType)).not.toContain('InitZomesComplete');
    await expect(call('ping', null, interrupted)).rejects.toThrow(/Incomplete DNA initialization/);
    expect(storage.queryActions(fixture.dna, interrupted).some(a => a.actionType === 'InitZomesComplete')).toBe(false);
    console.log('REAL_WASM_INTERRUPTED_GENESIS_FAIL_CLOSED');
  }, 90000);
});
