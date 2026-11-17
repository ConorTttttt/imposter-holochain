/**
 * P0 persistent-entry schema migration, shared by production OPFS worker
 * and SQLite fixture tests. No entry bodies or hashes are logged.
 *
 * v2 changes entries from a global entry_hash primary key to a composite
 * (cell_id, entry_hash) primary key. Migration DDL and data copy execute
 * within one SQLite transaction; a failed upgrade rolls back atomically.
 */
export const ENTRY_SCHEMA_VERSION = 2;

type SQLiteStatement = {
  bind(values: unknown[]): void;
  step(): boolean;
  get(target: Record<string, unknown>): Record<string, any>;
  finalize(): void;
};
export type EntryMigrationDB = {
  exec(sql: string): unknown;
  prepare(sql: string): SQLiteStatement;
};

function readRows(db: EntryMigrationDB, sql: string): Array<Record<string, any>> {
  const statement = db.prepare(sql);
  const rows: Array<Record<string, any>> = [];
  try {
    while (statement.step()) rows.push(statement.get({}));
  } finally {
    statement.finalize();
  }
  return rows;
}
function count(db: EntryMigrationDB, sql: string): number {
  return Number(readRows(db, sql)[0]?.n ?? 0);
}

/**
 * Called immediately after SCHEMA_SQL on every worker DB open.
 * failAfterCopy is a test-only fault injector, never set by the worker.
 */
export function migrateEntrySchema(
  db: EntryMigrationDB,
  failAfterCopy?: () => void,
): { status: 'created' | 'migrated' | 'current'; entries: number } {
  const version = Number(readRows(db, 'PRAGMA user_version')[0]?.user_version ?? 0);
  if (version > ENTRY_SCHEMA_VERSION) {
    throw new Error('Unsupported future SQLite entry schema version: ' + version);
  }
  const columns = readRows(db, 'PRAGMA table_info(entries)');
  if (columns.length === 0) throw new Error('SQLite entry schema missing');
  const pk = columns.filter(row => Number(row.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(row => String(row.name));
  const composite = pk.length === 2 && pk[0] === 'cell_id' && pk[1] === 'entry_hash';
  const legacy = pk.length === 1 && pk[0] === 'entry_hash';
  if (!composite && !legacy) {
    throw new Error('Unrecognized SQLite entry primary key; manual recovery required');
  }
  const before = count(db, 'SELECT COUNT(*) AS n FROM entries');
  if (composite && version === ENTRY_SCHEMA_VERSION) {
    return { status: 'current', entries: before };
  }
  // Old globally-keyed entries can no longer reveal a previous owner if
  // INSERT OR REPLACE already overwrote them. Action references let us detect
  // contradictory ownership evidence; never fabricate lost private bytes.
  if (legacy) {
    const inconsistent = count(db, `SELECT COUNT(*) AS n
      FROM actions AS a JOIN entries AS e ON a.entry_hash = e.entry_hash
      WHERE a.action_type IN ('Create', 'Update') AND a.cell_id <> e.cell_id`);
    if (inconsistent > 0) {
      throw new Error('LEGACY_ENTRY_OWNERSHIP_CONFLICT: ' + inconsistent +
        ' action references belong to a different cell; manual recovery required');
    }
    const invalid = count(db, `SELECT COUNT(*) AS n FROM entries
      WHERE cell_id IS NULL OR length(cell_id) = 0 OR entry_hash IS NULL`);
    if (invalid > 0) {
      throw new Error('LEGACY_ENTRY_OWNER_MISSING: ' + invalid +
        ' entries cannot be assigned safely');
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (legacy) {
      db.exec(`CREATE TABLE entries_v2_migration (
        cell_id TEXT NOT NULL,
        entry_hash BLOB NOT NULL,
        entry_content BLOB NOT NULL,
        entry_type TEXT NOT NULL,
        PRIMARY KEY (cell_id, entry_hash)
      )`);
      db.exec(`INSERT INTO entries_v2_migration (cell_id, entry_hash, entry_content, entry_type)
        SELECT cell_id, entry_hash, entry_content, entry_type FROM entries`);
      const copied = count(db, 'SELECT COUNT(*) AS n FROM entries_v2_migration');
      if (copied !== before) throw new Error('SQLite migration row count mismatch');
      failAfterCopy?.();
      // DROP is permitted only inside the same transaction as verified copy.
      // On crash/rollback, the original entries table and its index survive.
      db.exec('DROP TABLE entries');
      db.exec('ALTER TABLE entries_v2_migration RENAME TO entries');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_entries_cell ON entries(cell_id)');
    db.exec('PRAGMA user_version = 2');
    const after = count(db, 'SELECT COUNT(*) AS n FROM entries');
    if (before !== after) throw new Error('SQLite migration final count mismatch');
    const integrity = readRows(db, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      throw new Error('SQLite integrity_check failed');
    }
    db.exec('COMMIT');
    return { status: legacy ? 'migrated' : 'created', entries: after };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
