// Unit tests for purgeSessionRows — the cockpit-side cascade delete of one
// session's rows from the SDK-owned session-store.db. Each test builds a temp DB
// with the REAL session-store schema (the `sessions` master table, its child
// tables, and the FTS5 `search_index`), so the FTS5 shadow-table cascade is
// exercised for real. The real ~/.copilot/session-store.db is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { purgeSessionRows } from './session-store-cleanup.ts';

// The real session-store.db schema (verified against ~/.copilot/session-store.db).
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
  branch TEXT, summary TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT,
  timestamp TEXT DEFAULT (datetime('now')), UNIQUE(session_id, turn_index));
CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  checkpoint_number INTEGER NOT NULL, title TEXT, overview TEXT, history TEXT,
  work_done TEXT, technical_details TEXT, important_files TEXT, next_steps TEXT,
  created_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, checkpoint_number));
CREATE TABLE session_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_path TEXT NOT NULL, tool_name TEXT, turn_index INTEGER,
  first_seen_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, file_path));
CREATE TABLE session_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ref_type TEXT NOT NULL, ref_value TEXT NOT NULL, turn_index INTEGER,
  created_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, ref_type, ref_value));
CREATE TABLE forge_trajectory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_call_id TEXT, turn_index INTEGER, event_type TEXT NOT NULL, command TEXT,
  output TEXT, exit_code INTEGER, event_key TEXT, event_value TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE VIRTUAL TABLE search_index USING fts5(
  content, session_id UNINDEXED, source_type UNINDEXED, source_id UNINDEXED);
`;

// Populate one session with a row in every per-session table. `tag` differentiates
// the FTS content so a full-text MATCH can prove the right rows survived.
function seedSession(db: DatabaseSync, id: string, tag: string): void {
  db.prepare(`INSERT INTO sessions (id, cwd, summary) VALUES (?, ?, ?)`).run(id, `/cwd/${id}`, `summary ${tag}`);
  db.prepare(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response) VALUES (?, 0, ?, ?)`)
    .run(id, `ask ${tag}`, `reply ${tag}`);
  db.prepare(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response) VALUES (?, 1, ?, ?)`)
    .run(id, `ask2 ${tag}`, `reply2 ${tag}`);
  db.prepare(`INSERT INTO checkpoints (session_id, checkpoint_number, title) VALUES (?, 1, ?)`).run(id, `cp ${tag}`);
  db.prepare(`INSERT INTO session_files (session_id, file_path, tool_name) VALUES (?, ?, 'edit')`).run(id, `/f/${tag}.ts`);
  db.prepare(`INSERT INTO session_refs (session_id, ref_type, ref_value) VALUES (?, 'pr', ?)`).run(id, `pr-${tag}`);
  db.prepare(`INSERT INTO forge_trajectory_events (session_id, event_type, command) VALUES (?, 'bash', ?)`)
    .run(id, `cmd ${tag}`);
  db.prepare(`INSERT INTO search_index (content, session_id, source_type, source_id) VALUES (?, ?, 'turn', '0')`)
    .run(`searchable ${tag} content`, id);
}

const ALL_TABLES = ['sessions', 'turns', 'checkpoints', 'session_files', 'session_refs', 'forge_trajectory_events', 'search_index'];

function countFor(db: DatabaseSync, id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ALL_TABLES) {
    const col = t === 'sessions' ? 'id' : 'session_id';
    out[t] = (db.prepare(`SELECT COUNT(*) AS c FROM "${t}" WHERE "${col}" = ?`).get(id) as { c: number }).c;
  }
  return out;
}

// Build a fresh temp DB seeded with `target` + `bystander`. Returns the path and a
// dispose fn. The DB is created and closed so purgeSessionRows opens it fresh
// (matching production, where it opens its own connection).
function freshDb(target: string, bystander: string): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-store-'));
  const path = join(dir, 'session-store.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  seedSession(db, target, 'TARGET');
  seedSession(db, bystander, 'BYSTANDER');
  db.close();
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('purges every per-session row for the target across all tables', () => {
  const target = 'aaaaaaaa-0000-0000-0000-000000000001';
  const bystander = 'bbbbbbbb-0000-0000-0000-000000000002';
  const { path, dispose } = freshDb(target, bystander);

  const res = purgeSessionRows(path, target);

  // Reported counts match what was seeded (2 turns, 1 each of the rest).
  assert.deepEqual(res.deleted, {
    turns: 2, checkpoints: 1, session_files: 1, session_refs: 1,
    forge_trajectory_events: 1, search_index: 1, sessions: 1,
  });
  assert.equal(res.total, 8);

  // The DB now has zero target rows everywhere.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const [t, n] of Object.entries(countFor(db, target))) {
      assert.equal(n, 0, `${t} must have 0 target rows after purge`);
    }
  } finally {
    db.close();
  }
  dispose();
});

test('leaves a bystander session completely untouched', () => {
  const target = 'aaaaaaaa-0000-0000-0000-000000000001';
  const bystander = 'bbbbbbbb-0000-0000-0000-000000000002';
  const { path, dispose } = freshDb(target, bystander);

  purgeSessionRows(path, target);

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Every bystander row is intact, table by table.
    assert.deepEqual(countFor(db, bystander), {
      sessions: 1, turns: 2, checkpoints: 1, session_files: 1,
      session_refs: 1, forge_trajectory_events: 1, search_index: 1,
    });
  } finally {
    db.close();
  }
  dispose();
});

test('FTS5 search_index: target rows gone, index intact + queryable for the survivor', () => {
  const target = 'aaaaaaaa-0000-0000-0000-000000000001';
  const bystander = 'bbbbbbbb-0000-0000-0000-000000000002';
  const { path, dispose } = freshDb(target, bystander);

  purgeSessionRows(path, target);

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // The target's FTS content no longer matches.
    const tHits = db.prepare(`SELECT session_id FROM search_index WHERE search_index MATCH 'TARGET'`).all();
    assert.equal(tHits.length, 0, 'target FTS content must be removed from the index');
    // The bystander's FTS content still matches — the shadow tables cascaded cleanly
    // and the index is not corrupted by the delete.
    const bHits = db.prepare(`SELECT session_id FROM search_index WHERE search_index MATCH 'BYSTANDER'`).all() as Array<{ session_id: string }>;
    assert.equal(bHits.length, 1);
    assert.equal(bHits[0].session_id, bystander);
  } finally {
    db.close();
  }
  dispose();
});

test('is idempotent: re-purging an already-clean session deletes nothing', () => {
  const target = 'aaaaaaaa-0000-0000-0000-000000000001';
  const bystander = 'bbbbbbbb-0000-0000-0000-000000000002';
  const { path, dispose } = freshDb(target, bystander);

  const first = purgeSessionRows(path, target);
  assert.equal(first.total, 8);
  const second = purgeSessionRows(path, target);
  assert.deepEqual(second.deleted, {});
  assert.equal(second.total, 0);
  dispose();
});

test('purging an unknown session id is a no-op', () => {
  const target = 'aaaaaaaa-0000-0000-0000-000000000001';
  const bystander = 'bbbbbbbb-0000-0000-0000-000000000002';
  const { path, dispose } = freshDb(target, bystander);

  const res = purgeSessionRows(path, 'cccccccc-0000-0000-0000-000000000003');
  assert.deepEqual(res.deleted, {});
  assert.equal(res.total, 0);

  // Both seeded sessions are still fully present.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c, 2);
  } finally {
    db.close();
  }
  dispose();
});

test('tolerates a store missing some optional tables (deletes what exists)', () => {
  // A minimal store with only `sessions` + `turns` (no checkpoints/refs/FTS/etc).
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-store-min-'));
  const path = join(dir, 'session-store.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT);`);
  db.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER);`);
  const target = 'aaaaaaaa-0000-0000-0000-000000000001';
  db.prepare(`INSERT INTO sessions (id, summary) VALUES (?, 'x')`).run(target);
  db.prepare(`INSERT INTO turns (session_id, turn_index) VALUES (?, 0)`).run(target);
  db.close();

  const res = purgeSessionRows(path, target);
  assert.deepEqual(res.deleted, { turns: 1, sessions: 1 });
  assert.equal(res.total, 2);

  rmSync(dir, { recursive: true, force: true });
});
