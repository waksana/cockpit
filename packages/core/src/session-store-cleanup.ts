// session-store-cleanup.ts — cockpit-side cascade purge of one session's rows from
// the SDK-owned global session-store.db.
//
// WHY THIS EXISTS. The SDK's `LocalSessionManager.deleteSession` only removes the
// session's on-disk directory (events.jsonl / session.db); it NEVER touches the
// global `session-store.db`. That store's `SessionStore` class has insert methods
// but NO delete — so every row a session wrote there (its `sessions` master row,
// `turns`, and `search_index` FTS5 entries) survives a "purge" forever. The harvest
// scanner's catch-up then keeps rediscovering the orphaned `sessions` row as a
// "ghost" session, re-emitting it and bloating scan-cursor.json. cockpit therefore
// performs its own cascade cleanup of the store after the SDK delete
// (see Engine.purgeSession).
//
// This is the ONE place cockpit writes to the SDK-owned session-store.db. It is
// safe because it runs only AFTER the SDK has released the session
// (deleteSession resolved): the rows are pure orphans the SDK no longer references,
// so deleting them on disk is invisible to the SDK's in-memory state.

import { DatabaseSync } from 'node:sqlite';

// Every session-store.db table keyed by a single session, with the column holding
// the session id, in CHILD-FIRST order so the parent `sessions` row is removed
// LAST. The child tables declare `session_id ... REFERENCES sessions(id)`; deleting
// the parent first would trip a foreign-key check if FK enforcement is ever enabled
// on the connection (it is off by default, but child-first is correct either way).
//
// `search_index` is an FTS5 virtual table — deleting its rows automatically updates
// the internal search_index_* shadow tables; never delete those by hand.
//
// `dynamic_context_items` is deliberately ABSENT: it is keyed by
// (repository, branch, src, name) and shared across sessions — it has no session-id
// column, so it is not per-session state and must not be touched by a per-session
// purge.
const PER_SESSION_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'turns', column: 'session_id' },
  { table: 'checkpoints', column: 'session_id' },
  { table: 'session_files', column: 'session_id' },
  { table: 'session_refs', column: 'session_id' },
  { table: 'forge_trajectory_events', column: 'session_id' },
  { table: 'search_index', column: 'session_id' },
  { table: 'sessions', column: 'id' },
];

export interface PurgeRowsResult {
  // table name -> rows deleted; only tables with a non-zero deletion appear.
  deleted: Record<string, number>;
  // sum of all deleted rows across tables.
  total: number;
}

// True iff `table` exists and has a column named `column`. Makes the cleanup
// defensive against an SDK schema that renames/adds/drops a table between versions
// — a missing table or column is simply skipped instead of throwing. PRAGMA
// table_info works on FTS5 virtual tables too (returns their user columns).
function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  let rows: Array<{ name: string }>;
  try {
    rows = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>;
  } catch {
    return false; // table absent
  }
  return rows.some((c) => c.name === column);
}

// Delete every row belonging to `sessionId` from the session-store.db at `dbPath`,
// across all per-session tables, atomically. Returns a per-table count of rows
// removed. Pure and synchronous: opens its own connection, does the work in one
// transaction, and closes — it touches nothing but `sessionId`'s rows, so other
// sessions' rows are never affected. Throws only on an unexpected SQL error (the
// transaction is rolled back first).
export function purgeSessionRows(dbPath: string, sessionId: string): PurgeRowsResult {
  const db = new DatabaseSync(dbPath);
  try {
    // Wait (don't fail) if another connection holds the write lock briefly. WAL lets
    // readers/writers coexist; busy_timeout only matters for the short exclusive
    // window of a checkpoint or a concurrent write.
    db.exec('PRAGMA busy_timeout = 5000');
    const deleted: Record<string, number> = {};
    let total = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { table, column } of PER_SESSION_TABLES) {
        if (!tableHasColumn(db, table, column)) continue;
        const info = db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(sessionId);
        const n = Number(info.changes ?? 0);
        if (n > 0) {
          deleted[table] = n;
          total += n;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw err;
    }
    return { deleted, total };
  } finally {
    db.close();
  }
}
