import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { SCHEMA_SQL } from './sqlite-schema';
import { migrateEntrySchema, type EntryMigrationDB } from './sqlite-entry-migration';

// Same SQLite binary semantics as the browser's SQLite WASM, but Node fixtures.
// Browser/OPFS restart and real Lair are intentionally a separate acceptance.
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => { SQL = await initSqlJs(); });

function wrap(db: Database): EntryMigrationDB {
  return {
    exec(sql) { db.run(sql); },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(values) { stmt.bind(values as any[]); },
        step() { return stmt.step(); },
        get(_result) { return stmt.getAsObject(); },
        finalize() { stmt.free(); },
      };
    },
  };
}
function legacy(db: Database): void {
  db.run(`CREATE TABLE actions (
    action_hash BLOB PRIMARY KEY, cell_id TEXT NOT NULL,
    action_type TEXT NOT NULL, entry_hash BLOB)`);
  db.run(`CREATE TABLE entries (
    entry_hash BLOB PRIMARY KEY, cell_id TEXT NOT NULL,
    entry_content BLOB NOT NULL, entry_type TEXT NOT NULL)`);
  db.run('CREATE INDEX idx_entries_cell ON entries(cell_id)');
}
const hash = new Uint8Array([1, 2, 3, 4, 5]);
const grant = new Uint8Array([0x81, 0x42, 0x50, 0x01]);
function insert(db: Database, cell: string, body: Uint8Array = grant): void {
  db.run('INSERT INTO entries(entry_hash,cell_id,entry_content,entry_type) VALUES (?,?,?,?)',
    [hash, cell, body, 'CapGrant']);
}
function lookup(db: Database, cell: string): number[] {
  const stmt = db.prepare('SELECT entry_content FROM entries WHERE cell_id=? AND entry_hash=?');
  try {
    stmt.bind([cell, hash]);
    return stmt.step() ? Array.from(stmt.getAsObject().entry_content as Uint8Array) : [];
  } finally { stmt.free(); }
}

describe('P0 SQLite legacy migration and same-hash CapGrant durability', () => {
  it('migrates a populated v1 table without losing entry bodies, then preserves two owners and restart', () => {
    const db = new SQL.Database();
    legacy(db);
    insert(db, 'dna:alice');
    db.run('PRAGMA user_version=1');
    expect(migrateEntrySchema(wrap(db))).toEqual({ status: 'migrated', entries: 1 });
    const pk = db.exec('PRAGMA table_info(entries)')[0].values.filter(r => Number(r[5]) > 0)
      .sort((a, b) => Number(a[5]) - Number(b[5])).map(r => r[1]);
    expect(pk).toEqual(['cell_id', 'entry_hash']);
    // Byte-identical private CapGrant, same DNA but distinct agent.
    insert(db, 'dna:bob');
    expect(lookup(db, 'dna:alice')).toEqual([...grant]);
    expect(lookup(db, 'dna:bob')).toEqual([...grant]);
    expect(lookup(db, 'dna:charlie')).toEqual([]);
    const snapshot = db.export();
    db.close();
    const restored = new SQL.Database(snapshot);
    expect(migrateEntrySchema(wrap(restored))).toEqual({ status: 'current', entries: 2 });
    expect(lookup(restored, 'dna:alice')).toEqual([...grant]);
    expect(lookup(restored, 'dna:bob')).toEqual([...grant]);
    expect(restored.exec('PRAGMA integrity_check')[0].values[0][0]).toBe('ok');
    restored.close();
  });

  it('a simulated crash after verified copy rolls back to intact original v1 bytes and index', () => {
    const db = new SQL.Database();
    legacy(db);
    insert(db, 'dna:alice');
    expect(() => migrateEntrySchema(wrap(db), () => {
      throw new Error('INJECTED_CRASH_AFTER_COPY');
    })).toThrow('INJECTED_CRASH_AFTER_COPY');
    expect(lookup(db, 'dna:alice')).toEqual([...grant]);
    expect(db.exec('PRAGMA user_version')[0].values[0][0]).toBe(0);
    expect(db.exec("SELECT name FROM sqlite_master WHERE name='idx_entries_cell'")[0].values).toHaveLength(1);
    expect(migrateEntrySchema(wrap(db))).toEqual({ status: 'migrated', entries: 1 });
    db.close();
  });

  it('refuses contradictory historical ownership without inventing lost private data', () => {
    const db = new SQL.Database();
    legacy(db);
    insert(db, 'dna:bob'); // v1 has already displaced Alice.
    db.run("INSERT INTO actions VALUES(?,?,?,?)", [new Uint8Array([11]), 'dna:alice', 'Create', hash]);
    expect(() => migrateEntrySchema(wrap(db))).toThrow(/LEGACY_ENTRY_OWNERSHIP_CONFLICT/);
    expect(lookup(db, 'dna:bob')).toEqual([...grant]);
    expect(db.exec('PRAGMA table_info(entries)')[0].values.filter(r => Number(r[5]) > 0)
      .map(r => r[1])).toEqual(['entry_hash']);
    db.close();
  });

  it('rejects missing legacy owners, and never silently accepts a newer schema', () => {
    const db = new SQL.Database();
    legacy(db);
    insert(db, '');
    expect(() => migrateEntrySchema(wrap(db))).toThrow(/LEGACY_ENTRY_OWNER_MISSING/);
    db.run('PRAGMA user_version=999');
    expect(() => migrateEntrySchema(wrap(db))).toThrow(/future SQLite entry schema/);
    db.close();
  });

  it('new schema has durable composite key and two identical entries without legacy migration', () => {
    const db = new SQL.Database();
    db.run(SCHEMA_SQL);
    expect(migrateEntrySchema(wrap(db))).toEqual({ status: 'created', entries: 0 });
    insert(db, 'dna:alice');
    insert(db, 'dna:bob');
    expect(db.exec('SELECT count(*) FROM entries')[0].values[0][0]).toBe(2);
    expect(lookup(db, 'dna:alice')).toEqual([...grant]);
    expect(lookup(db, 'dna:bob')).toEqual([...grant]);
    db.close();
  });
});
