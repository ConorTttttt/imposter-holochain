#!/usr/bin/env python3
"""Reproducible patch for HWC 0c391226e78769d44ccb4661881ed8998b15f903.

Usage: python3 apply.py /path/to/holo-web-conductor [--check|--write|--patch FILE]
Default is --check: validates anchors and computes the patch without mutating.
"""
import argparse
import difflib
from pathlib import Path
import sys
import subprocess

PINNED_SHA = '0c391226e78769d44ccb4661881ed8998b15f903'
BRANCH = 'fix/imposter-hwc-compatibility'

ROOTS = {}
RANGES = {}

def range_change(path: str, start: str, end: str, replacement: str):
    RANGES.setdefault(path, []).append((start, end, replacement))

def change(path: str, before: str, after: str, occurrences: int = 1):
    ROOTS.setdefault(path, []).append((before, after, occurrences))

def apply_edits(path: str, original: str):
    result = original
    for before, after, occurrences in ROOTS.get(path, []):
        n = result.count(before)
        if n != occurrences:
            raise ValueError(f'{path}: expected exactly {occurrences} anchor(s); got {n}\nANCHOR: {before[:160]!r}')
        result = result.replace(before, after, occurrences)
    for start, end, replacement in RANGES.get(path, []):
        if result.count(start) != 1 or result.count(end) != 1:
            raise ValueError(f'{path}: range anchors not unique: {start[:65]!r}, {end[:65]!r}')
        left = result.index(start)
        right = result.index(end)
        if right <= left:
            raise ValueError(f'{path}: invalid range order')
        result = result[:left] + replacement + result[right:]
    return result

# B-02: hash-time and runtime DNA modifier resolution MUST be identical.
P='packages/extension/src/lib/happ-context-manager.ts'
change(P,'''    const networkSeed = roleModifiers?.network_seed ||
      dnaBundle.manifest.integrity.network_seed ||
      "";
    const properties = roleModifiers?.properties ||
      dnaBundle.manifest.integrity.properties;''','''    const networkSeed = roleModifiers?.network_seed ??
      dnaBundle.manifest.integrity.network_seed ??
      "";
    const properties = roleModifiers?.properties ??
      dnaBundle.manifest.integrity.properties;''')
change(P,'''        const runtimeManifest: DnaManifestRuntime = createRuntimeManifest(
          dnaBundle.manifest,
          dnaBundle.resources
        );''','''        const runtimeManifest: DnaManifestRuntime = createRuntimeManifest(
          dnaBundle.manifest,
          dnaBundle.resources
        );
        // Apply hApp role-level overrides to the runtime manifest, not only
        // the DNA hash. dna_info_v2 reads this manifest during validation.
        const effectiveNetworkSeed = role.dna.modifiers?.network_seed ??
          dnaBundle.manifest.integrity.network_seed ?? "";
        const effectiveProperties = role.dna.modifiers?.properties ??
          dnaBundle.manifest.integrity.properties;
        runtimeManifest.network_seed = effectiveNetworkSeed;
        runtimeManifest.properties = effectiveProperties;''')
change(P,'''        // Create DnaContext with manifest
        const effectiveNetworkSeed = role.dna.modifiers?.network_seed ||
          dnaBundle.manifest.integrity.network_seed || undefined;

        const dnaContext: DnaContext = {''','''        // Create DnaContext with the same effective modifiers used for hashing.
        const dnaContext: DnaContext = {''')
change(P,'''          properties:
            role.dna.modifiers?.properties ||
            dnaBundle.manifest.integrity.properties,
          networkSeed: effectiveNetworkSeed,''','''          properties: effectiveProperties,
          networkSeed: effectiveNetworkSeed,''')

# B-03: Holochain CreateInput allows special CapGrant/CapClaim locations.
P='packages/core/src/ribosome/wasm-io-types.ts'
change(P,'''/** Entry definition location for App entries */
export interface EntryDefLocation {
  App: {
    zome_index: number;
    entry_def_index: number;
  };
}''','''/** Holochain 0.7 EntryDefLocation: App or a private capability entry. */
export type EntryDefLocation =
  | { App: { zome_index: number; entry_def_index: number } }
  | 'CapClaim'
  | 'CapGrant';

/** On the HDK wire, App carries bytes; capability entries carry a struct. */
export type WasmEntry =
  | { entry_type: 'App'; entry: Uint8Array }
  | { entry_type: 'CapClaim' | 'CapGrant'; entry: Record<string, unknown> };''')
change(P,'''  /** Entry wrapper with type and content */
  entry: {
    entry_type: 'App' | 'Agent' | 'CapClaim' | 'CapGrant';
    entry: Uint8Array;  // MessagePack-serialized entry content
  };''','''  /** Entry wrapper with type and content */
  entry: WasmEntry;''', occurrences=2)
change(P,'''  // Check entry_location
  if (!i.entry_location || typeof i.entry_location !== 'object') return false;
  const loc = i.entry_location as Record<string, unknown>;
  if (!loc.App || typeof loc.App !== 'object') return false;
  const app = loc.App as Record<string, unknown>;
  if (typeof app.zome_index !== 'number' || typeof app.entry_def_index !== 'number') return false;

  // Check entry_visibility
  if (i.entry_visibility !== 'Public' && i.entry_visibility !== 'Private') return false;

  // Check entry
  if (!i.entry || typeof i.entry !== 'object') return false;
  const entry = i.entry as Record<string, unknown>;
  if (!['App', 'Agent', 'CapClaim', 'CapGrant'].includes(entry.entry_type as string)) return false;
  if (!(entry.entry instanceof Uint8Array)) return false;''','''  // Verify entry type and location correspond. A capability grant or claim
  // is ALWAYS private; accepting mismatched variants would corrupt the chain.
  const loc = i.entry_location;
  const special = loc === 'CapGrant' || loc === 'CapClaim';
  if (!special) {
    if (!loc || typeof loc !== 'object' || Array.isArray(loc)) return false;
    const app = (loc as Record<string, unknown>).App;
    if (!app || typeof app !== 'object') return false;
    const a = app as Record<string, unknown>;
    if (!Number.isInteger(a.zome_index) || !Number.isInteger(a.entry_def_index) ||
        (a.zome_index as number) < 0 || (a.entry_def_index as number) < 0) return false;
  }
  if (i.entry_visibility !== 'Public' && i.entry_visibility !== 'Private') return false;
  if (!i.entry || typeof i.entry !== 'object') return false;
  const entry = i.entry as Record<string, unknown>;
  if (special) {
    if (entry.entry_type !== loc || i.entry_visibility !== 'Private') return false;
    if (!entry.entry || typeof entry.entry !== 'object' ||
        Array.isArray(entry.entry) || entry.entry instanceof Uint8Array) return false;
  } else if (entry.entry_type !== 'App' || !(entry.entry instanceof Uint8Array)) {
    return false;
  }''')
# UpdateInput union is necessary to avoid falsely rejecting special system entries.

change(P,'''  if (!['App', 'Agent', 'CapClaim', 'CapGrant'].includes(entry.entry_type as string)) return false;
  if (!(entry.entry instanceof Uint8Array)) return false;''','''  if (entry.entry_type === 'App') {
    if (!(entry.entry instanceof Uint8Array)) return false;
  } else if (entry.entry_type === 'CapGrant' || entry.entry_type === 'CapClaim') {
    if (!entry.entry || typeof entry.entry !== 'object' || Array.isArray(entry.entry) ||
        entry.entry instanceof Uint8Array) return false;
  } else {
    return false;
  }''')

# Entry type metadata persists through SQLite JSON and IndexedDB object stores.
P='packages/core/src/storage/types.ts'
change(P,'''  entryType: AppEntryType | null;   // null for agent entry''','''  entryType: AppEntryType | 'CapGrant' | 'CapClaim' | null; // null for agent''')
change(P,'''export interface AppEntryType {
  zome_id: number;      // Zome index
  entry_index: number;  // Entry def index within zome
}''','''export interface AppEntryType {
  zome_id: number;      // Zome index
  entry_index: number;  // Entry def index within zome
  /** Holochain action visibility. Optional ONLY for legacy HWC chain data. */
  visibility?: 'Public' | 'Private';
}''')
change(P,'''  entryType?: AppEntryType | null;''','''  entryType?: AppEntryType | 'CapGrant' | 'CapClaim' | null;''')

P='packages/core/src/hash/index.ts'
change(P,'''/**
 * Compute EntryHash for an Agent entry''','''/**
 * Hash a Holochain CapClaim / CapGrant system entry, preserving the structured
 * serde representation (not the already-encoded app-entry byte variant).
 */
export function computeSystemEntryHash(
  type: 'CapClaim' | 'CapGrant',
  value: Record<string, unknown>,
): EntryHash {
  const serialized = new Uint8Array(encode({ entry_type: type, entry: value }));
  return hashFrom32AndType(blake2b256(serialized), HoloHashType.Entry) as EntryHash;
}

/**
 * Compute EntryHash for an Agent entry''')

P='packages/core/src/ribosome/host-fn/create.ts'
change(P,'''import { validateWasmCreateInput, type WasmCreateInput } from "../wasm-io-types";''','''import { validateWasmCreateInput } from "../wasm-io-types";''')
change(P,'''import { computeAppEntryHash, computeActionHashV2, serializeAction } from "../../hash";''','''import { computeAppEntryHash, computeSystemEntryHash, computeActionHashV2, serializeAction } from "../../hash";
import { encode } from "@msgpack/msgpack";''')
change(P,'''  // Extract entry content from the validated structure
  const entryContent = input.entry.entry;

  // Pre-commit sys validation: entry size limit (checked, not constructed)
  checkEntrySize(entryContent);

  // Hash the entry - App entries hash the serialized Entry enum { entry_type: "App", entry: content }
  const entryHash = computeAppEntryHash(entryContent);''','''  const systemEntry = input.entry.entry_type !== 'App';
  const entryContent = systemEntry
    ? new Uint8Array(encode(input.entry.entry))
    : input.entry.entry as Uint8Array;
  checkEntrySize(entryContent);
  const entryHash = systemEntry
    ? computeSystemEntryHash(input.entry.entry_type as 'CapClaim' | 'CapGrant',
        input.entry.entry as Record<string, unknown>)
    : computeAppEntryHash(entryContent);''')
change(P,'''  // Extract entry type from entry_location for storage format
  const entryType: AppEntryType = {
    zome_id: input.entry_location.App.zome_index,
    entry_index: input.entry_location.App.entry_def_index,
  };

  // Build serializable entry type for action
  const serializableEntryType = buildAppEntryType({
    entry_index: entryType.entry_index,
    zome_index: entryType.zome_id,
    visibility: "Public",
  });''','''  // The serialized entry type must match the HDK input, including visibility.
  const entryType: AppEntryType | 'CapClaim' | 'CapGrant' = systemEntry
    ? input.entry.entry_type as 'CapClaim' | 'CapGrant'
    : {
        zome_id: (input.entry_location as { App: { zome_index: number } }).App.zome_index,
        entry_index: (input.entry_location as { App: { entry_def_index: number } }).App.entry_def_index,
        visibility: input.entry_visibility,
      };
  const serializableEntryType = typeof entryType === 'string'
    ? entryType
    : buildAppEntryType({
        entry_index: entryType.entry_index,
        zome_index: entryType.zome_id,
        visibility: entryType.visibility,
      });''')

P='packages/core/src/ribosome/host-fn/update.ts'
change(P,'''import { computeAppEntryHash, computeActionHashV2, serializeAction } from "../../hash";''','''import { computeAppEntryHash, computeSystemEntryHash, computeActionHashV2, serializeAction } from "../../hash";
import { encode } from "@msgpack/msgpack";''')
change(P,'''  // Extract entry content from validated input
  const entryContent = input.entry.entry;

  // Pre-commit sys validation: entry size limit (checked, not constructed)
  checkEntrySize(entryContent);

  // Hash the new entry - App entries hash the serialized Entry enum { entry_type: "App", entry: content }
  const entryHash = computeAppEntryHash(entryContent);''','''  const systemEntry = input.entry.entry_type !== 'App';
  const entryContent = systemEntry
    ? new Uint8Array(encode(input.entry.entry))
    : input.entry.entry as Uint8Array;
  checkEntrySize(entryContent);
  const entryHash = systemEntry
    ? computeSystemEntryHash(input.entry.entry_type as 'CapClaim' | 'CapGrant',
        input.entry.entry as Record<string, unknown>)
    : computeAppEntryHash(entryContent);''')
change(P,'''  if (!originalAction.entryType) {
    throw new Error("Original action has no app entry type; cannot update it");
  }
  const originalEntryHash = originalAction.entryHash;
  const zomeIndex = originalAction.entryType.zome_id;
  const entryDefIndex = originalAction.entryType.entry_index;''','''  if (!originalAction.entryType) {
    throw new Error("Original action has no updateable entry type");
  }
  const entryType = originalAction.entryType;
  const isOriginalSystem = typeof entryType === 'string';
  if (systemEntry !== isOriginalSystem ||
      (isOriginalSystem && entryType !== input.entry.entry_type)) {
    throw new Error('UpdateTypeMismatch: entry type differs from original');
  }
  if (!isOriginalSystem && (entryType.visibility !== 'Public' && entryType.visibility !== 'Private')) {
    throw new Error('Unsafe legacy entry: visibility missing; migration required');
  }
  const originalEntryHash = originalAction.entryHash;''')
change(P,'''  // Build serializable entry type for action
  const serializableEntryType = buildAppEntryType({
    entry_index: entryDefIndex,
    zome_index: zomeIndex,
    visibility: "Public",
  });''','''  const serializableEntryType = typeof entryType === 'string'
    ? entryType
    : buildAppEntryType({
        entry_index: entryType.entry_index,
        zome_index: entryType.zome_id,
        visibility: entryType.visibility,
      });''')
change(P,'''    entryType: {
      zome_id: zomeIndex,
      entry_index: entryDefIndex,
    },''','''    entryType,''', occurrences=2)


# Local chain query and record conversion must preserve special entry types.
P='packages/core/src/ribosome/host-fn/entry-utils.ts'
change(P,'''import { toUint8Array } from "../../utils/bytes";''','''import { toUint8Array } from "../../utils/bytes";
import { decode } from "@msgpack/msgpack";''')
change(P,'''    return { entry_type: "CapClaim", entry: entryContent };''','''    return { entry_type: "CapClaim", entry: decode(entryContent) } as unknown as Entry;''')
change(P,'''    return { entry_type: "CapGrant", entry: entryContent };''','''    return { entry_type: "CapGrant", entry: decode(entryContent) } as unknown as Entry;''')
change(P,'''  const normalizedData =
    Array.isArray(entryData) ||''','''  // Capability entries carry structured data, not raw app-entry bytes.
  if (entryType === 'CapClaim' || entryType === 'CapGrant') return entry;
  const normalizedData =
    Array.isArray(entryData) ||''')

P='packages/core/src/ribosome/host-fn/action-serialization.ts'
change(P,'''function toWireEntryType(entryType: AppEntryType | null): EntryType {
  return entryType
    ? buildAppEntryType({
        entry_index: entryType.entry_index,
        zome_index: entryType.zome_id,
        visibility: 'Public',
      })
    : 'AgentPubKey';
}''','''function toWireEntryType(entryType: AppEntryType | 'CapClaim' | 'CapGrant' | null): EntryType {
  if (!entryType) return 'AgentPubKey';
  if (typeof entryType === 'string') return entryType;
  if (entryType.visibility !== 'Private' && entryType.visibility !== 'Public') {
    throw new Error('Unsafe legacy entry: visibility missing; migration required');
  }
  return buildAppEntryType({
    entry_index: entryType.entry_index,
    zome_index: entryType.zome_id,
    visibility: entryType.visibility,
  });
}''')

P='packages/core/src/dht/record-converter.ts'
change(P,'''import type {
  StoredAction,''','''import { decode } from "@msgpack/msgpack";

import type {
  StoredAction,''')
change(P,'''/**
 * Convert storage's `AppEntryType | null` (no `visibility` field - the
 * storage layer doesn't currently track entry visibility) to the wire
 * `EntryType`. Always `"Public"`, matching the previous (0.6-era)
 * behavior; the storage layer would need a visibility field before this
 * could report `"Private"`.
 */
function entryTypeFromStored(entryType: AppEntryType | null): EntryType {
  if (!entryType) return "AgentPubKey";
  return buildAppEntryType({
    entry_index: entryType.entry_index,
    zome_index: entryType.zome_id,
  });
}''','''/** Preserve the exact signed entry type. Unknown legacy visibility is unsafe. */
function entryTypeFromStored(entryType: AppEntryType | 'CapClaim' | 'CapGrant' | null): EntryType {
  if (!entryType) return 'AgentPubKey';
  if (typeof entryType === 'string') return entryType;
  if (entryType.visibility !== 'Public' && entryType.visibility !== 'Private') {
    throw new Error('Unsafe legacy entry: visibility missing; migration required');
  }
  return buildAppEntryType({
    entry_index: entryType.entry_index,
    zome_index: entryType.zome_id,
    visibility: entryType.visibility,
  });
}''')
change(P,'''  // App entries
  return { entry_type: "App", entry: stored.entryContent } as Entry;''','''  if (stored.entryType === 'CapClaim' || stored.entryType === 'CapGrant') {
    return { entry_type: stored.entryType, entry: decode(stored.entryContent) } as unknown as Entry;
  }
  // App entries
  return { entry_type: "App", entry: stored.entryContent } as Entry;''')
change(P,'''  const recordEntry = storedEntryToRecordEntry(storedEntry);

  return {''','''  // Publishing never discloses private entry bodies, including system grants.
  // Hidden is required even when retry/recovery supplies no local entry body.
  const privateEntry = storedAction.actionType === 'Create' || storedAction.actionType === 'Update'
    ? storedAction.entryType === 'CapGrant' || storedAction.entryType === 'CapClaim' ||
      (typeof storedAction.entryType === 'object' && storedAction.entryType !== null &&
        storedAction.entryType.visibility === 'Private')
    : false;
  const recordEntry = privateEntry ? 'Hidden' as unknown as RecordEntry
    : storedEntryToRecordEntry(storedEntry);

  return {''')

# Defense in depth: publication cannot serialize private payloads even if a caller
# passes an unsanitized Record to the tracker.
P='packages/core/src/dht/produce-ops.ts'
change(P,'''  const signature = getSignatureFromRecord(record);
  const entry = extractEntryFromRecord(record);
  const signedAction: SignedAction = { data: action, signature };
  const opEntry = opEntryFromRecordEntry(record.entry);''','''  const signature = getSignatureFromRecord(record);
  const data = action.data as unknown as {
    type: string;
    entry_type?: 'CapClaim' | 'CapGrant' | 'AgentPubKey' |
      { App: { visibility?: 'Public' | 'Private' } };
  };
  const isEntry = data.type === 'Create' || data.type === 'Update';
  const entryType = isEntry ? data.entry_type : undefined;
  const privateEntry = entryType === 'CapClaim' || entryType === 'CapGrant' ||
    (typeof entryType === 'object' && entryType?.App?.visibility === 'Private');
  if (isEntry && typeof entryType === 'object' && entryType?.App?.visibility !== 'Public' &&
      entryType?.App?.visibility !== 'Private') {
    throw new Error('Unrecognized entry visibility: refusing DHT publication');
  }
  const entry = privateEntry ? undefined : extractEntryFromRecord(record);
  const signedAction: SignedAction = { data: action, signature };
  const opEntry = privateEntry ? opEntryHidden() : opEntryFromRecordEntry(record.entry);''')

# Do not move private entry bytes from offscreen SQLite into the extension's
# publication retry path. The author can still query their SQLite storage.
P='packages/extension/src/offscreen/ribosome-worker.ts'
change(P,'''          if (record.entry) {
            entryForTransport = {
              entryHash: Array.from(record.entry.entryHash),
              entryContent: Array.from(record.entry.entryContent),
              entryType: record.entry.entryType,
            };
          }''','''          const type = isEntryAction(record.action) ? record.action.entryType : undefined;
          const publicEntry = type === null ||
            (typeof type === 'object' && type !== null && type.visibility === 'Public');
          if (record.entry && publicEntry) {
            entryForTransport = {
              entryHash: Array.from(record.entry.entryHash),
              entryContent: Array.from(record.entry.entryContent),
              entryType: record.entry.entryType,
            };
          }''')

# Private records may exist in the shared OPFS database. Never return a
# private/system entry to a different cell, even if it knows an entry hash.
P='packages/extension/src/offscreen/ribosome-worker.ts'
change(P,'''    const stmt = db.prepare('SELECT entry_hash, entry_content, entry_type FROM entries WHERE entry_hash = ?');''','''    const stmt = db.prepare('SELECT entry_hash, entry_content, entry_type, cell_id FROM entries WHERE entry_hash = ?');''')
change(P,'''        if (entryType && entryType.startsWith('{')) {
          try {
            entryType = JSON.parse(entryType);
          } catch {
            // Keep as string if not valid JSON
          }
        }
        return {
          entryHash: new Uint8Array(row.entry_hash),''','''        if (entryType && entryType.startsWith('{')) {
          try {
            entryType = JSON.parse(entryType);
          } catch {
            // Keep as string if not valid JSON
          }
        }
        const confidential = entryType === 'CapGrant' || entryType === 'CapClaim' ||
          (entryType && typeof entryType === 'object' && entryType.visibility !== 'Public');
        if (confidential && row.cell_id !== this.currentCellId) return null;
        return {
          entryHash: new Uint8Array(row.entry_hash),''')

# DirectSQLiteStorage is the production worker source-chain provider.
# It already scopes queryActions/getDetails by cell, but its hash-only
# action readers allow another active cell to fetch a private action / CapGrant.
# The local chain's action lookups must be restricted to the worker cell.
P='packages/extension/src/offscreen/ribosome-worker.ts'
change(P,'''    const stmt = db.prepare('SELECT * FROM actions WHERE action_hash = ?');
    try {
      stmt.bind([toBytes(actionHash)]);''','''    const stmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND action_hash = ?');
    try {
      stmt.bind([this.currentCellId, toBytes(actionHash)]);''')
change(P,'''    const stmt = db.prepare('SELECT * FROM actions WHERE entry_hash = ? ORDER BY action_seq ASC LIMIT 1');
    try {
      stmt.bind([toBytes(entryHash)]);''','''    const stmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND entry_hash = ? ORDER BY action_seq ASC LIMIT 1');
    try {
      stmt.bind([this.currentCellId, toBytes(entryHash)]);''')

# The IndexedDB fallback reuses a shared synchronous cache across cells.
# It must not retain other cells' entries during the preload transition.
P='packages/core/src/storage/source-chain-storage.ts'
change(P,'''  async preloadChainForCell(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);''','''  async preloadChainForCell(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);
    // Isolate entry/action lookups by cell: a previous author's private data
    // must not remain retrievable when a different cell becomes active.
    this.sessionCache.actions.clear();
    this.sessionCache.entries.clear();
    this.sessionCache.links.clear();''')

# Test-only IndexedDB StorageProvider is a singleton. Its synchronous
# action/entry/link cache is a local source-chain context, NOT a union of all
# cells. Even direct genesis writes (which do not preload) must switch context.
P='packages/core/src/storage/source-chain-storage.ts'
change(P,'''  private static instance: SourceChainStorage | null = null;''','''  private static instance: SourceChainStorage | null = null;
  // Only the active cell is permitted in the synchronous session cache.
  private activeCellId: string | null = null;''')
change(P,'''  private getCellId(dnaHash: Uint8Array, agentPubKey: Uint8Array): string {''','''  private activateCell(dnaHash: Uint8Array, agentPubKey: Uint8Array): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    if (this.activeCellId === cellId) return;
    if (this.pendingTransaction) {
      throw new Error('Cross-cell source-chain operation inside active transaction');
    }
    // Do not expose another cell's private entries or CapGrants by hash.
    this.sessionCache.actions.clear();
    this.sessionCache.entries.clear();
    this.sessionCache.links.clear();
    this.activeCellId = cellId;
  }

  private getCellId(dnaHash: Uint8Array, agentPubKey: Uint8Array): string {''')
change(P,'''    this.sessionCache.links.clear();

    // Load all actions for this cell''','''    this.sessionCache.links.clear();
    this.activeCellId = cellId;

    // Load all actions for this cell''')
change(P,'''  async putAction(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    if (this.pendingTransaction) {''','''  async putAction(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    this.activateCell(dnaHash, agentPubKey);
    if (this.pendingTransaction) {''')
change(P,'''  async putEntry(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    if (this.pendingTransaction) {''','''  async putEntry(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    this.activateCell(dnaHash, agentPubKey);
    if (this.pendingTransaction) {''')
change(P,'''  putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): void | Promise<void> {
    if (this.pendingTransaction) {''','''  putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): void | Promise<void> {
    this.activateCell(dnaHash, agentPubKey);
    if (this.pendingTransaction) {''')
change(P,'''  async updateChainHead(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    actionSeq: number,
    actionHash: Uint8Array,
    timestamp: bigint
  ): Promise<void> {
    const cellId = this.getCellId(dnaHash, agentPubKey);''','''  async updateChainHead(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    actionSeq: number,
    actionHash: Uint8Array,
    timestamp: bigint
  ): Promise<void> {
    this.activateCell(dnaHash, agentPubKey);
    const cellId = this.getCellId(dnaHash, agentPubKey);''')
change(P,'''    // Get all actions from session cache
    let actions: Action[] = Array.from(this.sessionCache.actions.values());''','''    // Never return a different cell's local actions or capability grants.
    if (this.activeCellId !== this.getCellId(dnaHash, agentPubKey)) return [];
    let actions: Action[] = Array.from(this.sessionCache.actions.values());''')
change(P,'''    // Get all actions from cache
    const actions = Array.from(this.sessionCache.actions.values());''','''    // Entry histories belong to the local cell, not the global cache.
    if (this.activeCellId !== this.getCellId(dnaHash, agentPubKey)) return null;
    const actions = Array.from(this.sessionCache.actions.values());''')
change(P,'''    // Get from session cache (synchronous)
    const baseKey = this.hashToKey(baseAddress);''','''    if (this.activeCellId !== this.getCellId(dnaHash, agentPubKey)) return [];
    // Get from session cache (synchronous)
    const baseKey = this.hashToKey(baseAddress);''')
change(P,'''    // Clear session cache
    this.sessionCache.actions.clear();''','''    // Clear session cache
    this.activeCellId = null;
    this.sessionCache.actions.clear();''')

# Old pending publishes may already contain unsafe entry bodies produced before
# the fix. A versioned storage upgrade MUST discard them, not resend them.
P='packages/core/src/dht/publish-tracker.ts'
change(P,'''const DB_VERSION = 2; // v2: Changed dnaHash from number[] to dnaHashStr string for proper indexing''','''const DB_VERSION = 3; // v3: purge pre-fix pending publishes that may contain private bodies''')
change(P,'''        log.info("Database upgraded to version", DB_VERSION);''','''        if (oldVersion > 0 && oldVersion < 3) {
          // Pre-v3 publication queues have no trustworthy privacy classification.
          // Reconstruct safe ops from the local chain rather than retransmitting
          // previously serialized payloads (which may contain private entries).
          const tx = (event.target as IDBOpenDBRequest).transaction!;
          tx.objectStore(STORES.PENDING_PUBLISHES).clear();
          log.warn('Discarded pre-v3 publication queue to protect private entries');
        }
        log.info("Database upgraded to version", DB_VERSION);''')

# B-03 lifecycle: coordinator init writes CapGrant before InitZomesComplete.
P='packages/core/src/storage/genesis.ts'
change(P,'''  membraneProof?: Uint8Array
): Promise<GenesisResult> {''','''  membraneProof?: Uint8Array,
  deferInitZomesComplete = false,
): Promise<GenesisResult> {''')
change(P,'''  pendingRecords.push({ action: agentCreateAction as StoredAction, entry: agentEntry });

  // === 4. InitZomesComplete Action (seq: 3) ===''','''  pendingRecords.push({ action: agentCreateAction as StoredAction, entry: agentEntry });

  if (deferInitZomesComplete) {
    // Real Holochain invokes coordinator init BEFORE InitZomesComplete.
    // The coordinator's private capability grants must follow the Agent entry.
    await storage.updateChainHead(dnaHash, agentPubKey, 2, agentCreateActionHash, timestampBigInt);
    return { initialized: true, pendingRecords };
  }

  // === 4. InitZomesComplete Action (seq: 3) ===''')
change(P,'''  return { initialized: true, pendingRecords };
}''','''  return { initialized: true, pendingRecords };
}

/** Append InitZomesComplete after coordinator callbacks have successfully run. */
export async function completeGenesisAfterInit(
  storage: SourceChainStorage,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
): Promise<PendingRecord> {
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);
  if (!chainHead || chainHead.actionSeq < 2) {
    throw new Error('Cannot finalize genesis without Agent entry');
  }
  const last = await storage.getAction(chainHead.actionHash);
  if (last?.actionType === 'InitZomesComplete') {
    throw new Error('Genesis already completed');
  }
  const timestampMicros = Math.max(Date.now() * 1000, Number(chainHead.timestamp) + 1);
  const timestampBigInt = BigInt(timestampMicros);
  const serializable = buildInitZomesCompleteAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: chainHead.actionSeq + 1,
    prev_action: chainHead.actionHash,
  });
  const action: InitZomesCompleteAction = {
    actionHash: computeActionHashV2(serializable),
    actionSeq: chainHead.actionSeq + 1,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash: chainHead.actionHash,
    actionType: 'InitZomesComplete',
    signature: signAction(agentPubKey, serializeAction(serializable)),
  };
  await storage.putAction(action, dnaHash, agentPubKey);
  await storage.updateChainHead(dnaHash, agentPubKey, action.actionSeq, action.actionHash, timestampBigInt);
  return { action };
}''')

# On normal first use, run each exported coordinator init() with chain-author
# provenance. Fail closed on missing/invalid callback results or interrupted init.
P='packages/core/src/ribosome/index.ts'
change(P,'''  let genesisRecords: { action: any; entry?: any }[] = [];
  await timeAsync('genesisCheck', async () => {
    const { initializeGenesis } = await import('../storage/genesis');
    const genesisResult = await initializeGenesis(storage as any, dnaHash, agentPubKey);
    if (genesisResult.initialized) {
      genesisRecords = genesisResult.pendingRecords;
      log.debug(` Genesis initialized with ${genesisRecords.length} records to publish`);
    }
  });''','''  let genesisRecords: { action: any; entry?: any }[] = [];
  let initPublishRecords: HolochainRecord[] = [];
  await timeAsync('genesisCheck', async () => {
    const { initializeGenesis, completeGenesisAfterInit } = await import('../storage/genesis');
    const genesisResult = await initializeGenesis(
      storage as any, dnaHash, agentPubKey, undefined, true,
    );
    if (genesisResult.initialized && isInitCallback) {
      throw new Error('Init callback cannot run on an uninitialized cell');
    }
    if (genesisResult.initialized) {
      genesisRecords = genesisResult.pendingRecords;
      if (!dnaManifest) throw new Error('Cannot initialize DNA without the runtime manifest');
      for (const coordinator of dnaManifest.coordinator_zomes || []) {
        if (!coordinator.wasm?.length) {
          throw new Error(`Coordinator WASM missing during init: ${coordinator.name}`);
        }
        // Init is optional for individual zomes. Check the export before calling.
        const module = await WebAssembly.compile(new Uint8Array(coordinator.wasm));
        if (!WebAssembly.Module.exports(module).some(e => e.kind === 'function' && e.name === 'init')) {
          continue;
        }
        const callback = await callZome({
          ...request, zome: coordinator.name, fn: 'init', payload: new Uint8Array([0xc0]), // ExternIO wrapping () as msgpack nil
          provenance: agentPubKey, isInitCallback: true,
        });
        if (callback.result !== 'Pass') {
          throw new Error(`Coordinator init did not return Pass: ${coordinator.name}`);
        }
        initPublishRecords.push(...(callback.pendingRecords || []));
      }
      genesisRecords.push(await completeGenesisAfterInit(storage as any, dnaHash, agentPubKey));
    }
  });''')
change(P,'''      pendingRecords,
      remoteSignals: context.remoteSignals,''','''      pendingRecords: [...(pendingRecords || []), ...initPublishRecords],
      remoteSignals: context.remoteSignals,''')

# The deferred-membrane-proof genesis path also must execute init before enabling
# the cell. Use the same callback engine and stop on failure.
P='packages/extension/src/offscreen/ribosome-worker.ts'
change(P,'''        const manifestWithWasm = genesisManifest ? {
          ...genesisManifest,
          integrity_zomes: (genesisManifest.integrity_zomes || []).map((z: any) => ({
            ...z,
            wasm: genesisWasm,
          })),
        } : genesisManifest;''','''        const manifestWithWasm = genesisManifest ? {
          ...genesisManifest,
          integrity_zomes: (genesisManifest.integrity_zomes || []).map((z: any) => ({
            ...z,
            wasm: z.wasm ? toUint8Array(z.wasm) : genesisWasm,
          })),
          coordinator_zomes: (genesisManifest.coordinator_zomes || []).map((z: any) => ({
            ...z,
            wasm: z.wasm ? toUint8Array(z.wasm) : undefined,
          })),
        } : genesisManifest;''')
change(P,'''        const { initializeGenesis } = await import('@hwc/core/storage/genesis');
        const genesisResult = await initializeGenesis(storage as any, genesisDnaHash, genesisAgentKey, memproofBytes);

        // Convert pending records''','''        const { initializeGenesis, completeGenesisAfterInit } = await import('@hwc/core/storage/genesis');
        const genesisResult = await initializeGenesis(storage as any, genesisDnaHash, genesisAgentKey, memproofBytes, true);
        if (!genesisResult.initialized) throw new Error('Genesis already attempted');
        if (!manifestWithWasm) throw new Error('Missing DNA manifest for init');
        const initPublishRecords: any[] = [];
        for (const zome of manifestWithWasm.coordinator_zomes || []) {
          if (!zome.wasm?.length) throw new Error(`Missing coordinator WASM: ${zome.name}`);
          const module = await WebAssembly.compile(zome.wasm);
          if (!WebAssembly.Module.exports(module).some(e => e.kind === 'function' && e.name === 'init')) continue;
          const callback = await callZome({
            dnaWasm: genesisWasm,
            cellId: cellIdBytes,
            zome: zome.name,
            fn: 'init',
            payload: new Uint8Array([0xc0]), // ExternIO wrapping () as msgpack nil
            provenance: genesisAgentKey,
            dnaManifest: manifestWithWasm,
            isInitCallback: true,
          });
          if (callback.result !== 'Pass') throw new Error(`Coordinator init failed: ${zome.name}`);
          initPublishRecords.push(...(callback.pendingRecords || []));
        }
        genesisResult.pendingRecords.push(
          await completeGenesisAfterInit(storage as any, genesisDnaHash, genesisAgentKey),
        );

        // Convert pending records''')
change(P,'''        const clientRecords = buildRecords(genesisResult.pendingRecords || []);''','''        const clientRecords = [
          ...buildRecords(genesisResult.pendingRecords || []),
          ...initPublishRecords,
        ];''')

# The previous code trusted caller-declared provenance, accepted malformed
# fallbacks, and ran WASM without cryptographic envelope verification. Completely
# remove that code rather than leaving a bypass that can be re-enabled.
# Agent 3 must supply and review the authenticated envelope before delivery is
# re-enabled. This is safe for P0 lobby but deliberately blocks P1 signals.
P='packages/extension/src/background/index.ts'
range_change(P,
    'async function handleRemoteSignal(signalData: {',
    '/**\n * Handle sign request from offscreen document',
    """async function handleRemoteSignal(_signalData: {
  dna_hash: string;
  to_agent: string;
  from_agent: string;
  zome_name: string;
  signal: number[];
}): Promise<void> {
  // No verified signer, recipient, DNA, freshness window, or replay guard is
  // provided by the current linker message schema. Refuse every message.
  logSignal.warn('Remote signal rejected: authenticated H2HC envelope unavailable');
}

""",
)

P='packages/core/src/storage/genesis.test.ts'
change(P,'''    getChainHead: vi.fn(() => chainHead),
    putAction: vi.fn((action: any) => {''','''    getChainHead: vi.fn(() => chainHead),
    getAction: vi.fn(() => actions[actions.length - 1]),
    putAction: vi.fn((action: any) => {''')
P='packages/core/src/storage/genesis.test.ts'
change(P,'''import { initializeGenesis, type GenesisResult } from "./genesis";''','''import { initializeGenesis, completeGenesisAfterInit, type GenesisResult } from "./genesis";''')
change(P,'''    it("should return pendingRecords when chain is empty", async () => {''','''    it('defers InitZomesComplete until after init can write capability grants', async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey, undefined, true);
      expect(result.pendingRecords.map(x => x.action.actionType)).toEqual([
        'Dna', 'AgentValidationPkg', 'Create',
      ]);
      expect(storage.getChainHead().actionSeq).toBe(2);
      // Simulate init() writing a private CapGrant at seq=3.
      storage.putAction({ actionType: 'Create', actionSeq: 3 });
      storage.updateChainHead(testDnaHash, testAgentPubKey, 3, testDnaHash, BigInt(Date.now() * 1000));
      const completed = await completeGenesisAfterInit(storage as any, testDnaHash, testAgentPubKey);
      expect(completed.action.actionType).toBe('InitZomesComplete');
      expect(completed.action.actionSeq).toBe(4);
      expect(storage.getChainHead().actionSeq).toBe(4);
    });

    it("should return pendingRecords when chain is empty", async () => {''')

# HWC does not yet have Agent 3's authenticated remote-call protocol. Prevent
# spoofed non-author calls from reaching WASM as ChainAuthor capability grants.
P='packages/core/src/ribosome/index.ts'
change(P,'''  // Initialize genesis actions if this is a new cell
  const [dnaHash, agentPubKey] = cellId;''','''  // Until peer-authenticated capability evaluation exists at this boundary,
  // a remote caller may NOT be treated as the local ChainAuthor. This also
  // prevents call_info() from incorrectly reporting ChainAuthor for a spoof.
  const [dnaHash, agentPubKey] = cellId;
  if (provenance.length !== agentPubKey.length ||
      !provenance.every((b, i) => b === agentPubKey[i])) {
    throw new Error('Unauthenticated remote provenance: capability verification unavailable');
  }

  // Initialize genesis actions if this is a new cell''')

# Tests are created as new files and appended to the existing extension tests.
# P0: tag each cached action and private entry with its owning DNA/agent.
P='packages/core/src/storage/source-chain-storage.ts'
change(P,'''  private activeCellId: string | null = null;''','''  private activeCellId: string | null = null;
  private actionCellIds = new Map<string, string>();
  private entryCellIds = new Map<string, string>();''')
change(P,'''      this.sessionCache.actions.set(key, action);''','''      this.sessionCache.actions.set(key, action);
      this.actionCellIds.set(key, this.getCellId(dnaHash, agentPubKey));''', occurrences=2)
change(P,'''    // CRITICAL: Also update session cache so subsequent reads are synchronous
    const key = this.hashToKey(action.actionHash);
    this.sessionCache.actions.set(key, action);''','''    // CRITICAL: Also update session cache so subsequent reads are synchronous
    const key = this.hashToKey(action.actionHash);
    this.sessionCache.actions.set(key, action);
    this.actionCellIds.set(key, this.getCellId(dnaHash, agentPubKey));''')
change(P,'''      this.sessionCache.entries.set(key, entry);''','''      this.sessionCache.entries.set(key, entry);
      this.entryCellIds.set(key, this.getCellId(dnaHash, agentPubKey));''', occurrences=2)
change(P,'''    // CRITICAL: Also update session cache so subsequent reads are synchronous
    const key = this.hashToKey(entry.entryHash);
    this.sessionCache.entries.set(key, entry);''','''    // CRITICAL: Also update session cache so subsequent reads are synchronous
    const key = this.hashToKey(entry.entryHash);
    this.sessionCache.entries.set(key, entry);
    this.entryCellIds.set(key, this.getCellId(dnaHash, agentPubKey));''')
change(P,'''    let actions: Action[] = Array.from(this.sessionCache.actions.values());''','''    let actions: Action[] = Array.from(this.sessionCache.actions.values())
      .filter(action => this.actionCellIds.get(this.hashToKey(action.actionHash)) ===
        this.getCellId(dnaHash, agentPubKey));''')
change(P,'''    const actions = Array.from(this.sessionCache.actions.values());''','''    const actions = this.queryActions(dnaHash, agentPubKey);''')
change(P,'''    if (this.sessionCache.actions.has(cacheKey)) {
      return this.sessionCache.actions.get(cacheKey)!;
    }''','''    if (this.activeCellId && this.actionCellIds.get(cacheKey) === this.activeCellId &&
        this.sessionCache.actions.has(cacheKey)) {
      return this.sessionCache.actions.get(cacheKey)!;
    }''')
change(P,'''    if (this.sessionCache.entries.has(cacheKey)) {
      return this.sessionCache.entries.get(cacheKey)!;
    }''','''    if (this.activeCellId && this.entryCellIds.get(cacheKey) === this.activeCellId &&
        this.sessionCache.entries.has(cacheKey)) {
      return this.sessionCache.entries.get(cacheKey)!;
    }''')
change(P,'''    for (const action of this.sessionCache.actions.values()) {
      if ('entryHash' in action) {''','''    for (const action of this.sessionCache.actions.values()) {
      if (this.actionCellIds.get(this.hashToKey(action.actionHash)) !== this.activeCellId) continue;
      if ('entryHash' in action) {''')
change(P,'''    const entry = this.sessionCache.entries.get(entryCacheKey);''','''    const entry = this.entryCellIds.get(entryCacheKey) === this.getCellId(dnaHash, agentPubKey)
      ? this.sessionCache.entries.get(entryCacheKey) : undefined;''')
change(P,'''    this.sessionCache.chainHeads.clear();
  }''','''    this.sessionCache.chainHeads.clear();
    this.actionCellIds.clear();
    this.entryCellIds.clear();
    this.activeCellId = null;
  }''')
change(P,'''        resolve(storable ? this.storableToAction(storable) : null);''','''        resolve(storable && storable.cellId === this.activeCellId
          ? this.storableToAction(storable) : null);''')
change(P,'''        if (!storable) {
          resolve(null);
          return;
        }

        resolve({
          entryHash: new Uint8Array(storable.entryHash),''','''        if (!storable || storable.cellId !== this.activeCellId) {
          resolve(null);
          return;
        }

        resolve({
          entryHash: new Uint8Array(storable.entryHash),''')

TESTS = {
  'packages/core/src/ribosome/wasm-io-types.imposter.test.ts': 'tests/wasm-io-types.imposter.test.ts',
  'packages/core/src/dht/private-entry.imposter.test.ts': 'tests/private-entry.imposter.test.ts',
  'packages/core/src/hash/system-entry.imposter.test.ts': 'tests/system-entry.imposter.test.ts',
  'packages/core/src/storage/private-entry-persistence.imposter.test.ts': 'tests/private-entry-persistence.imposter.test.ts',
  'packages/core/src/storage/multi-cell-isolation.imposter.test.ts': 'tests/multi-cell-isolation.imposter.test.ts',
  'packages/core/src/storage/cell-isolation.imposter.test.ts': 'tests/cell-isolation.imposter.test.ts',
  'packages/core/src/ribosome/host-fn/dna-info-imposter.test.ts': 'tests/dna-info-imposter.test.ts',
  'packages/core/src/dht/publish-upgrade.imposter.test.ts': 'tests/publish-upgrade.imposter.test.ts',
}
P='packages/extension/src/lib/happ-context-manager.test.ts'
change(P,'''  describe("Get cell IDs", () => {''','''  describe("Imposter host-bound DNA modifiers", () => {
    it("uses role-level network seed and properties in the hash and WASM manifest", async () => {
      const { hashFrom32AndType, HoloHashType, encodeHashToBase64 } =
        await import('@holochain/client');
      const host = hashFrom32AndType(new Uint8Array(32).fill(6), HoloHashType.Agent);
      const seed = `g1.${encodeHashToBase64(host)}.0123456789abcdef0123456789abcdef`;
      vi.mocked(bundle.unpackHappBundle).mockReturnValueOnce({
        manifest: {
          name: "test-app",
          roles: [{
            name: "game", provisioning: { Create: { deferred: false } },
            dna: { path: "test.dna", modifiers: { network_seed: seed, properties: { test: 7 } } },
          }],
        },
        resources: new Map([["test.dna", new Uint8Array([1, 2, 3, 4])]]),
      } as any);
      const domain = "https://imposter-seed.test";
      await permissions.grantPermission(domain);
      const installed = await manager.installHapp(domain, { happBundle: createMockHappBundle() });
      const dna = installed.dnas[0];
      expect(dna.networkSeed).toBe(seed);
      expect(dna.manifest?.network_seed).toBe(seed);
      expect(dna.properties).toEqual({ test: 7 });
      expect(dna.manifest?.properties).toEqual({ test: 7 });
      // A different effective seed MUST produce a different DNA hash.
      const fallbackDomain = "https://imposter-seed-default.test";
      await permissions.grantPermission(fallbackDomain);
      const fallback = await manager.installHapp(fallbackDomain, {
        happBundle: createMockHappBundle(),
      });
      expect(fallback.dnas[0].manifest?.network_seed).toBe('test-seed');
      expect(Array.from(dna.hash)).not.toEqual(Array.from(fallback.dnas[0].hash));
      const persisted = await manager.getContext(installed.id);
      expect(persisted?.dnas[0].manifest?.network_seed).toBe(seed);
    });
  });

  describe("Get cell IDs", () => {''')


# Genesis completion must be checked AFTER IndexedDB session cache preload.
# Rollback clears the cache; checking earlier falsely rejects restored cells.
P='packages/core/src/ribosome/index.ts'
change(P,'''  if (storage.preloadChainForCell) {
    await storage.preloadChainForCell(dnaHash, agentPubKey);
    log.debug(' Chain pre-loaded into session cache');
  }

  // Begin transaction for atomic chain updates''','''  if (storage.preloadChainForCell) {
    await storage.preloadChainForCell(dnaHash, agentPubKey);
    log.debug(' Chain pre-loaded into session cache');
  }
  if (!isInitCallback) {
    // Persisted InitZomesComplete is authoritative; an interrupted init
    // must fail closed even after restart or an earlier transaction rollback.
    const completed = storage.queryActions(dnaHash, agentPubKey, {
      actionType: 'InitZomesComplete',
    });
    if (!completed?.length) {
      throw new Error('Incomplete DNA initialization; reinstall cell before continuing');
    }
  }

  // Begin transaction for atomic chain updates''')

# Existing public-entry fixtures predate visibility tracking. Mark test data
# explicitly Public; do not weaken production fail-closed legacy handling.
for P, occurrences in [
    ('packages/core/src/dht/validation-op.test.ts', 4),
    ('packages/core/src/ribosome/validate.test.ts', 2),
    ('packages/core/src/ribosome/host-fn/get_details.test.ts', 8),
    ('packages/core/src/ribosome/host-fn/must_get.test.ts', 18),
]:
    change(P, "entryType: { zome_id: 0, entry_index: 0 }",
           "entryType: { zome_id: 0, entry_index: 0, visibility: 'Public' }",
           occurrences=occurrences)

# Test helper synthesizes a manifest for isolated integrity-only WASM tests.
# Production calls still reject missing runtime manifests during genesis.
P='packages/core/src/ribosome/test-helpers.ts'
change(P,'''  // STEP 2: Call ribosome with wrapped payload
  const zomeCallResult: ZomeCallResult = await callZome({
    ...request,
    payload: payloadBytes,
  });''','''  // STEP 2: Supply test-only metadata if this isolated test omitted it.
  const testManifest = request.dnaManifest ?? {
    name: 'integration-fixture',
    network_seed: '',
    properties: {},
    integrity_zomes: [{
      name: request.zome, index: 0,
      wasm: request.dnaWasm, dependencies: [],
    }],
    coordinator_zomes: [],
  };
  const zomeCallResult: ZomeCallResult = await callZome({
    ...request,
    dnaManifest: testManifest,
    payload: payloadBytes,
  });''')

def main():
    p = argparse.ArgumentParser()
    p.add_argument('checkout', type=Path)
    group=p.add_mutually_exclusive_group()
    group.add_argument('--write', action='store_true', help='modify checkout in place')
    group.add_argument('--patch', type=Path, help='create unified diff without modifying checkout')
    group.add_argument('--check', action='store_true', help='verify exact anchors only (default)')
    a=p.parse_args()
    checkout=a.checkout.resolve()
    if a.write:
        def git(*args):
            return subprocess.check_output(['git', '-C', str(checkout), *args], text=True).strip()
        branch=git('branch','--show-current')
        head=git('rev-parse','HEAD')
        if branch != BRANCH:
            raise RuntimeError(f'Refusing to write on {branch!r}; use branch {BRANCH!r}')
        if head != PINNED_SHA:
            raise RuntimeError(f'Refusing to write against {head}; expected pinned {PINNED_SHA}')
        if git('status','--porcelain'):
            raise RuntimeError('Refusing to overwrite a dirty worktree')
    pieces=[]
    outputs=[]
    for path in dict.fromkeys([*ROOTS, *RANGES]):
        target=checkout/path
        if not target.is_file():
            raise FileNotFoundError(f'Pinned checkout missing file: {target}')
        old=target.read_text(encoding='utf-8')
        new=apply_edits(path, old)
        pieces.extend(difflib.unified_diff(old.splitlines(keepends=True),new.splitlines(keepends=True),
                fromfile='a/'+path, tofile='b/'+path))
        outputs.append((target,new))
    for target_src,rel in TESTS.items():
        dst=checkout/target_src
        if dst.exists():
            raise FileExistsError(f'Test target already exists: {dst}')
        content=(Path(__file__).parent/rel).read_text(encoding='utf-8')
        pieces.extend(difflib.unified_diff([],content.splitlines(keepends=True),
                fromfile='a/'+target_src,tofile='b/'+target_src))
        outputs.append((dst,content))
    patch=''.join(pieces)
    if a.patch:
        a.patch.write_text(patch, encoding='utf-8')
        print(f'Wrote {a.patch} ({len(patch)} bytes)')
    if a.write:
        for target,content in outputs:
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(content,encoding='utf-8')
            print('MODIFIED',target)
    else:
        print(f'PASS: verified {sum(map(len, ROOTS.values()))} exact source anchors and '
              f'{sum(map(len, RANGES.values()))} replace-by-range edits; '
              f'{len(TESTS)} new regression test files; no checkout changes')

if __name__=='__main__':
    try: main()
    except Exception as e:
        print('FAIL:',e,file=sys.stderr);sys.exit(1)
