// Unit tests use injected, project-local fixtures, never personal preferences.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { unreadSessionCount } from '@cockpit/protocol';
import { Prefs, type Inbox } from './prefs.ts';

const fixtureDirs = new Set<string>();

afterEach(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  fixtureDirs.clear();
});

function freshFile(): string {
  const dir = join('src', `.prefs-fixture-${randomUUID()}`);
  mkdirSync(dir);
  fixtureDirs.add(dir);
  return join(dir, 'prefs.json');
}

test('missing prefs file loads as empty without writing until a mutation', () => {
  const f = freshFile();
  // never written → load() hits ENOENT → empty
  const p = new Prefs(f);
  assert.deepEqual([...p.pinnedIds()], []);
  assert.equal(existsSync(f), false);
  // writing then re-reading creates the file
  p.setPinned('x', true);
  assert.ok(existsSync(f));
  assert.match(readFileSync(f, 'utf-8'), /pinnedSessions/);
  rmSync(f, { force: true });
});

// ── Trash (soft delete) ───────────────────────────────────────────────────────

test('trashSession marks; trashedIds + isTrashed reflect it', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.equal(p.isTrashed('s1'), false);
  p.trashSession('s1', 'cleanup');
  assert.equal(p.isTrashed('s1'), true);
  assert.deepEqual([...p.trashedIds()], ['s1']);
  const e = p.trashedEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].sessionId, 's1');
  assert.equal(e[0].reason, 'cleanup');
  assert.match(e[0].at, /^\d{4}-\d\d-\d\dT/); // ISO timestamp
  rmSync(f, { force: true });
});

test('restoreSession clears the mark', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.trashSession('s1');
  p.restoreSession('s1');
  assert.equal(p.isTrashed('s1'), false);
  assert.deepEqual([...p.trashedIds()], []);
  rmSync(f, { force: true });
});

test('trash persists across reload', () => {
  const f = freshFile();
  new Prefs(f).trashSession('s1', 'r');
  const b = new Prefs(f);
  assert.equal(b.isTrashed('s1'), true);
  assert.equal(b.trashedEntries()[0].reason, 'r');
  rmSync(f, { force: true });
});

test('forgetSession (purge) also clears the trash mark', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.trashSession('s1');
  p.setPinned('s1', true);
  p.forgetSession('s1');
  assert.equal(p.isTrashed('s1'), false);
  assert.equal(p.isPinned('s1'), false);
  rmSync(f, { force: true });
});

test('trash is independent per session', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.trashSession('s1');
  assert.equal(p.isTrashed('s1'), true);
  assert.equal(p.isTrashed('s2'), false);
  rmSync(f, { force: true });
});

// ── Pinned ─────────────────────────────────────────────────────────────────────

test('setPinned marks; isPinned + pinnedIds reflect it', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.equal(p.isPinned('s1'), false);
  p.setPinned('s1', true);
  assert.equal(p.isPinned('s1'), true);
  assert.deepEqual([...p.pinnedIds()], ['s1']);
  p.setPinned('s1', false);
  assert.equal(p.isPinned('s1'), false);
  assert.deepEqual([...p.pinnedIds()], []);
  rmSync(f, { force: true });
});

test('pinned persists across reload', () => {
  const f = freshFile();
  new Prefs(f).setPinned('s1', true);
  const p2 = new Prefs(f);
  assert.equal(p2.isPinned('s1'), true);
  rmSync(f, { force: true });
});

test('forgetSession (purge) also clears the pin', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setPinned('s1', true);
  p.forgetSession('s1');
  assert.equal(p.isPinned('s1'), false);
  rmSync(f, { force: true });
});

test('pin is independent per session + idempotent', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setPinned('s1', true);
  p.setPinned('s1', true); // idempotent — no duplicate
  assert.deepEqual([...p.pinnedIds()], ['s1']);
  assert.equal(p.isPinned('s2'), false);
  rmSync(f, { force: true });
});

// ── Opaque legacy/unknown preferences ────────────────────────────────────────

test('legacy native schedule counts are opaque and never rewritten by session housekeeping', () => {
  const f = freshFile();
  const legacy = [{ id: 1, flowId: 'retired-flow', cron: '* * * * *' }];
  writeFileSync(f, JSON.stringify({ flowSchedules: legacy, scheduledSessions: { existing: 2 } }));
  const p = new Prefs(f);
  assert.equal('scheduledSessionIds' in p, false);
  assert.equal('setScheduleCount' in p, false);
  p.setPinned('pinned-only', true);
  p.forgetSession('existing');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).scheduledSessions, { existing: 2 });
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).flowSchedules, legacy);
  assert.equal(p.isPinned('pinned-only'), true);
});

const legacyPrefs = {
  mcpDefaultOn: ['chrome'],
  mcpBySession: { s1: [], s2: ['chrome'] },
  skillsDisabledBySession: { s1: ['pdf'] },
  skillsAllowlistBySession: { s2: ['A'] },
  hooks: [{
    id: 'hook-1', ownerSession: 's1', event: 'session.first-turn-complete',
    promptTemplate: 'welcome {event.sessionId}', createdAt: 1, extension: { version: 2 },
  }],
  flowSchedules: [{ id: 'schedule-1', flowId: 'welcome-flow', cron: '* * * * *', enabled: true }],
  scheduledSessions: { s1: 2 },
  welcomedSessions: ['s1'],
  spawnedBySession: { s1: 'welcome-flow' },
  workerMetadata: { s1: { spawnedBy: 'welcome-flow', nested: [null, false, { future: 1 }] } },
  futurePreference: { schema: 'unknown', entries: [1, 'two', null] },
  futureNull: null,
  futureFlag: false,
  futureCount: 0,
  futureText: '',
  ...JSON.parse('{"__proto__":{"preserved":true}}'),
};

const foundationUpdates: Array<[string, (prefs: Prefs) => void]> = [
  ['trash', (p) => p.trashSession('s1', 'cleanup')],
  ['restore', (p) => p.restoreSession('s1')],
  ['pin', (p) => p.setPinned('s2', true)],
  ['unpin', (p) => p.setPinned('s1', false)],
  ['forget session', (p) => p.forgetSession('s1')],
  ['forget allowlisted session', (p) => p.forgetSession('s2')],
];

function seededFile(): string {
  const f = freshFile();
  writeFileSync(f, JSON.stringify({
    ...legacyPrefs,
    trashed: { s1: { at: '2026-01-01T00:00:00.000Z', reason: 'old' } },
    pinnedSessions: ['s1'],
  }));
  return f;
}

function assertLegacyPreserved(f: string): void {
  const saved = JSON.parse(readFileSync(f, 'utf-8'));
  for (const [key, value] of Object.entries(legacyPrefs)) {
    assert.deepEqual(saved[key], value, `${key} must survive unchanged`);
  }
}

test('fresh saves contain only foundation preferences and expose no governance APIs', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setPinned('s1', true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, 'utf-8'))).sort(), [
    'inbox', 'pinnedSessions', 'trashed',
  ]);
  const legacy = new Prefs(seededFile());
  for (const key of [
    'hooks', 'setHooks', 'welcomedSessions', 'isWelcomed', 'markWelcomed',
    'spawnedBySession', 'spawnedByOf', 'setSpawnedBy', 'flowSchedules', 'setFlowSchedules',
    'scheduledSessions', 'scheduledSessionIds', 'setScheduleCount',
    'mcpDefaultOn', 'setMcpDefault', 'enabledMcpFor', 'setSessionMcp', 'mcpBySession',
    'disabledSkillsFor', 'skillAllowlistFor', 'setSkillAllowlist', 'setSessionSkill',
    'skillsDisabledBySession', 'skillsAllowlistBySession',
  ]) {
    assert.equal(key in p, false, `${key} is not an active foundation API`);
    assert.equal(key in legacy, false, `${key} stays opaque after loading legacy data`);
  }
});

test('legacy hooks, schedules, worker metadata and unknown fields survive every foundation save and reload', () => {
  for (const [, update] of foundationUpdates) {
    const f = seededFile();
    update(new Prefs(f));
    assertLegacyPreserved(f);
    new Prefs(f).setPinned('after-reload', true);
    assertLegacyPreserved(f);
  }
});

test('governance fields are opaque even when they do not match their old schemas', () => {
  const f = freshFile();
  const unknown = {
    hooks: { future: [null, { enabled: 'not-a-boolean' }] },
    flowSchedules: 'external-scheduler',
    scheduledSessions: 'external-residency-policy',
    welcomedSessions: null,
    spawnedBySession: ['external-worker'],
    mcpDefaultOn: null,
    mcpBySession: 'native-owned',
    skillsDisabledBySession: false,
    skillsAllowlistBySession: [null],
  };
  writeFileSync(f, JSON.stringify({ ...unknown, pinnedSessions: ['old'] }));
  const p = new Prefs(f);
  assert.equal(p.isPinned('old'), true);
  p.forgetSession('old');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf-8')), {
    ...unknown, pinnedSessions: [], trashed: {},
    inbox: { revision: 0, counter: 0, sessions: {} },
  });
});

test('foundation collections remain defensive copies', () => {
  const f = seededFile();
  const p = new Prefs(f);
  p.pinnedIds().clear();
  p.trashedIds().clear();
  p.trashedEntries()[0].reason = 'unexpected';
  assert.equal(p.isPinned('s1'), true);
  assert.equal(p.isTrashed('s1'), true);
  assert.equal(p.trashedEntries()[0].reason, 'old');
});

// ── Durability ───────────────────────────────────────────────────────────────

function foundationSnapshot(p: Prefs): unknown {
  return {
    trashed: p.trashedEntries(),
    pinned: [...p.pinnedIds()],
    inbox: p.inbox,
  };
}

test('inbox survives restart with bounded seen IDs, event deduplication and explicit choice reconciliation', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.deepEqual(p.inbox, { revision: 0, counter: 0, sessions: {} });
  assert.equal(p.setAttention('missing', null), false);
  assert.equal(p.markSeen('missing'), false);
  assert.equal(existsSync(f), false);
  assert.equal(p.setAttention('ready', 'ready', 'turn-1'), true);
  assert.equal(p.setAttention('ready', 'ready', 'turn-2'), true);
  assert.equal(p.markSeen('ready', 1), true);
  assert.deepEqual(p.inbox.sessions.ready, { attention: 'ready', attnId: 2, seenId: 1, eventId: 'turn-2' });
  assert.equal(p.markSeen('ready'), true);
  assert.deepEqual(p.inbox.sessions.ready, { attention: null, attnId: 2, seenId: 2, eventId: 'turn-2' });
  assert.equal(p.setAttention('choice', 'choice', 'ask-1'), true);
  assert.equal(p.markSeen('choice', 999), true);
  assert.deepEqual(p.inbox.sessions.choice, { attention: 'choice', attnId: 3, seenId: 3, eventId: 'ask-1' });
  assert.equal(unreadSessionCount(Object.values(p.inbox.sessions)), 0);

  mkdirSync(`${f}.tmp`);
  assert.equal(p.setAttention('ready', 'ready', 'turn-2'), false, 'seen event cannot become unread again');
  assert.equal(p.setAttention('choice', 'choice', 'ask-1'), false);
  assert.equal(p.setAttention('choice', 'choice'), false);
  assert.equal(p.setAttention('ready', null, 'ignored'), false);
  for (const id of [1, 2, -1, NaN, Infinity, 1.5]) assert.equal(p.markSeen('ready', id), false);
  assert.equal(p.markSeen('choice'), false);
  rmSync(`${f}.tmp`, { recursive: true });

  assert.equal(p.setAttention('choice', 'choice', 'ask-2'), true);
  assert.equal(p.setAttention('__proto__', 'choice', 'ask-3'), true);
  assert.equal(p.setAttention('ready', 'ready', 'turn-3'), true);
  const before = p.inbox;
  assert.equal(before.counter, 6);
  assert.equal(before.revision, 9);
  const reloaded = new Prefs(f);
  assert.deepEqual(reloaded.inbox, before, 'Prefs construction does not reconcile Engine callbacks');
  const detached = reloaded.inbox;
  detached.counter = 0;
  detached.sessions.ready.attention = null;
  delete detached.sessions.choice;
  assert.deepEqual(reloaded.inbox, before);
  assert.equal(reloaded.markSeen('ready', 2), false, 'old acknowledgement leaves newer ready intact');
  assert.equal(reloaded.reconcileInboxChoices(), true);
  const reconciled: Inbox = {
    ...before,
    revision: before.revision + 1,
    sessions: {
      ...before.sessions,
      choice: { ...before.sessions.choice, attention: null },
      ['__proto__']: { ...before.sessions['__proto__'], attention: null },
    },
  };
  assert.deepEqual(reloaded.inbox, reconciled);
  assert.equal(unreadSessionCount(Object.values(reloaded.inbox.sessions)), 1);
  mkdirSync(`${f}.tmp`);
  assert.equal(reloaded.reconcileInboxChoices(), false);
  assert.equal(reloaded.setAttention('choice', 'choice', 'ask-2'), false);
  rmSync(`${f}.tmp`, { recursive: true });
  assert.equal(reloaded.setAttention('ready', null), true);
  assert.equal(reloaded.inbox.sessions.ready.eventId, 'turn-3');
  assert.equal(reloaded.setAttention('ready', 'ready', 'turn-3'), false);
  assert.equal(reloaded.setAttention('ready', 'ready'), true);
  assert.deepEqual(reloaded.inbox.sessions.ready, { attention: 'ready', attnId: 7, seenId: 2 });
  assert.deepEqual(new Prefs(f).inbox, reloaded.inbox);
  assert.deepEqual(readdirSync(dirname(f)), ['prefs.json']);
});

test('failed inbox saves never commit attention, seen IDs, reconciliation or session cleanup', () => {
  const f = seededFile();
  const logs: string[] = [];
  const p = new Prefs(f, (m) => logs.push(m));
  p.setAttention('s1', 'ready', 'turn-1');
  p.setAttention('s2', 'choice', 'ask-1');
  const before = foundationSnapshot(p);
  const bytes = readFileSync(f, 'utf8');
  const updates = [
    () => p.setAttention('s1', 'ready', 'turn-2'),
    () => p.setAttention('new', 'choice', 'ask-2'),
    () => p.setAttention('s1', null),
    () => p.markSeen('s1'),
    () => p.markSeen('s2'),
    () => p.reconcileInboxChoices(),
    () => p.trashSession('s2'),
    () => p.forgetSession('s1'),
  ];
  mkdirSync(`${f}.tmp`);
  for (const update of updates) {
    assert.throws(update, { code: 'EISDIR' });
    assert.deepEqual(foundationSnapshot(p), before);
    assert.equal(readFileSync(f, 'utf8'), bytes);
    assert.deepEqual(foundationSnapshot(new Prefs(f)), before);
    assert.equal(unreadSessionCount(Object.values(p.inbox.sessions)), 2);
  }
  assert.equal(logs.filter((m) => /save FAILED/.test(m)).length, updates.length);
  rmSync(`${f}.tmp`, { recursive: true });
  renameSync(f, `${f}.previous`);
  mkdirSync(f);
  assert.throws(() => p.setAttention('s1', 'ready', 'turn-2'));
  assert.deepEqual(foundationSnapshot(p), before);
  assert.equal(readFileSync(`${f}.previous`, 'utf8'), bytes);
  rmSync(f, { recursive: true });
  renameSync(`${f}.previous`, f);
  assert.equal(p.setAttention('s1', 'ready', 'turn-2'), true);
  assert.equal(p.inbox.counter, 3);
  assert.equal(p.inbox.revision, 3);
  assert.equal(p.markSeen('s1'), true);
  assert.equal(p.reconcileInboxChoices(), true);
  assert.equal(unreadSessionCount(Object.values(p.inbox.sessions)), 0);
  assert.deepEqual(new Prefs(f).inbox, p.inbox);
  assertLegacyPreserved(f);
});

test('inbox cleanup preserves monotonic IDs and opaque fields; invalid stored inboxes refuse reset', () => {
  const f = seededFile();
  const opaque = { future: { nested: [1, null, false] } };
  const entry = { attention: 'ready', attnId: 7, seenId: 1, eventId: 'old', ...opaque };
  writeFileSync(f, JSON.stringify({
    ...JSON.parse(readFileSync(f, 'utf8')),
    inbox: { revision: 10, counter: 7, sessions: { s1: entry }, ...opaque },
  }));
  const p = new Prefs(f);
  const detached = p.inbox as typeof p.inbox & typeof opaque;
  detached.future.nested.push(2);
  (detached.sessions.s1 as typeof entry).future.nested.push(2);
  p.markSeen('s1');
  p.setAttention('s1', 'choice', 'ask');
  p.reconcileInboxChoices();
  let stored = JSON.parse(readFileSync(f, 'utf8')).inbox;
  assert.deepEqual(stored.future, opaque.future);
  assert.deepEqual(stored.sessions.s1.future, opaque.future);
  assert.equal(p.inbox.revision, 13);
  p.setAttention('s2', 'ready', 'turn');
  p.trashSession('s1');
  assert.equal(p.isTrashed('s1'), true);
  assert.equal(p.inbox.sessions.s1, undefined);
  assert.equal(p.inbox.revision, 15);
  p.restoreSession('s1');
  assert.equal(p.inbox.sessions.s1, undefined);
  p.forgetSession('s2');
  assert.deepEqual(p.inbox.sessions, {});
  assert.equal(p.inbox.revision, 16);
  assert.equal(p.inbox.counter, 9);
  const reloaded = new Prefs(f);
  reloaded.trashSession('missing');
  reloaded.forgetSession('missing');
  assert.equal(reloaded.inbox.revision, 16);
  reloaded.setAttention('s1', 'ready', 'new');
  assert.equal(reloaded.inbox.sessions.s1.attnId, 10);
  assert.equal(reloaded.inbox.revision, 17);
  assertLegacyPreserved(f);
  stored = JSON.parse(readFileSync(f, 'utf8'));
  const valid = stored.inbox;
  for (const inbox of [
    null, {}, { ...valid, counter: -1 }, { ...valid, revision: 1 },
    { ...valid, counter: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, revision: 1.5 }, { ...valid, sessions: [] },
    ...[
      { ...entry, attnId: 11 }, { ...entry, seenId: 8 }, { ...entry, attnId: 0 },
      { ...entry, attention: 'unknown' }, { ...entry, eventId: 1 }, null,
    ].map((bad) => ({ ...valid, sessions: { s1: bad } })),
  ]) {
    const bytes = JSON.stringify({ ...stored, inbox });
    writeFileSync(f, bytes);
    assert.throws(() => new Prefs(f, () => {}), /Invalid inbox/);
    assert.equal(readFileSync(f, 'utf8'), bytes);
    assert.deepEqual(readdirSync(dirname(f)), ['prefs.json']);
  }
  for (const counter of [10, Number.MAX_SAFE_INTEGER]) {
    writeFileSync(f, JSON.stringify({ ...stored, inbox: { ...valid, revision: Number.MAX_SAFE_INTEGER, counter } }));
    const exhausted = new Prefs(f);
    const before = exhausted.inbox;
    const bytes = readFileSync(f, 'utf8');
    assert.throws(() => exhausted.setAttention('new', 'ready'), /exhausted/);
    assert.throws(() => exhausted.markSeen('s1'), /exhausted/);
    assert.throws(() => exhausted.forgetSession('s1'), /exhausted/);
    assert.deepEqual(exhausted.inbox, before);
    assert.equal(readFileSync(f, 'utf8'), bytes);
  }
});

for (const [name, update] of foundationUpdates) {
  test(`failed ${name} save throws and leaves memory and disk unchanged`, () => {
    const f = seededFile();
    const logs: string[] = [];
    const p = new Prefs(f, (m) => logs.push(m));
    const before = foundationSnapshot(p);
    const goodBytes = readFileSync(f, 'utf-8');
    mkdirSync(`${f}.tmp`);
    assert.throws(() => update(p), { code: 'EISDIR' });
    assert.ok(logs.some((m) => /save FAILED/.test(m)));
    assert.deepEqual(foundationSnapshot(p), before);
    assert.equal(readFileSync(f, 'utf-8'), goodBytes);
    assert.deepEqual(foundationSnapshot(new Prefs(f)), before);

    rmSync(`${f}.tmp`, { recursive: true });
    p.setPinned('after-failure', true);
    assert.deepEqual(foundationSnapshot(p), { ...before as object, pinned: ['s1', 'after-failure'] });
    assert.deepEqual(foundationSnapshot(new Prefs(f)), foundationSnapshot(p));
    assertLegacyPreserved(f);
    update(p);
    assert.deepEqual(foundationSnapshot(new Prefs(f)), foundationSnapshot(p));
    assertLegacyPreserved(f);
  });
}

test('a parent-directory creation failure throws without changing memory', () => {
  const f = freshFile();
  const nested = join(f, 'prefs.json');
  const p = new Prefs(nested, () => {});
  writeFileSync(f, 'not a directory');
  assert.throws(() => p.setPinned('s1', true));
  assert.equal(p.isPinned('s1'), false);
  assert.equal(readFileSync(f, 'utf-8'), 'not a directory');
});

test('a rename failure does not commit staged changes to memory', () => {
  const f = seededFile();
  const p = new Prefs(f, () => {});
  const before = foundationSnapshot(p);
  const goodBytes = readFileSync(f, 'utf-8');
  const previous = `${f}.previous`;
  renameSync(f, previous);
  mkdirSync(f);
  assert.throws(() => p.forgetSession('s1'));
  assert.deepEqual(foundationSnapshot(p), before);
  assert.equal(readFileSync(previous, 'utf-8'), goodBytes);
  assert.deepEqual(readdirSync(f), []);
  rmSync(f, { recursive: true });
  renameSync(previous, f);
  p.setPinned('s2', true);
  assert.deepEqual(foundationSnapshot(new Prefs(f)), foundationSnapshot(p));
  assert.equal(p.isTrashed('s1'), true, 'failed forget must not leak into the next save');
  assertLegacyPreserved(f);
});

test('interrupted staging leaves the prior file intact and a later save preserves legacy data', () => {
  const f = seededFile();
  const p = new Prefs(f);
  p.setPinned('extra', true);
  assert.equal(existsSync(`${f}.tmp`), false);
  const goodBytes = readFileSync(f, 'utf-8');
  writeFileSync(`${f}.tmp`, '{ "spawnedBySession": { "s1": "welc');
  assert.equal(readFileSync(f, 'utf-8'), goodBytes);
  const reloaded = new Prefs(f);
  assert.deepEqual(foundationSnapshot(reloaded), foundationSnapshot(p));
  reloaded.setPinned('s2', true);
  assert.equal(existsSync(`${f}.tmp`), false);
  assertLegacyPreserved(f);
});

test('corrupt prefs remain verbatim and cannot silently reset durable inbox IDs', () => {
  const f = freshFile();
  const corruptText =
    '{\n  "spawnedBySession": { "worker-A": "welcome-flow" },\n  "welcomedSessions": ["real-1"]\n';
  writeFileSync(f, corruptText);
  const logs: string[] = [];
  assert.throws(() => new Prefs(f, (m) => logs.push(m)));
  assert.ok(logs.some((m) => /corrupt/i.test(m)));
  assert.equal(readFileSync(f, 'utf-8'), corruptText);
  assert.throws(() => new Prefs(f, () => {}), 'repeated startup must not treat corruption as a fresh inbox');
  assert.deepEqual(readdirSync(dirname(f)), ['prefs.json']);
});

test('truncated inbox data refuses to load empty preferences', () => {
  const f = freshFile();
  const corruptText = '{"inbox":{"revision":800,"counter":500';
  writeFileSync(f, corruptText);
  const logs: string[] = [];
  assert.throws(() => new Prefs(f, (m) => logs.push(m)));
  assert.ok(logs.some((m) => /refusing to reset/.test(m)));
  assert.equal(readFileSync(f, 'utf-8'), corruptText);
});

test('unreadable preferences fail explicitly instead of loading empty', () => {
  const f = freshFile();
  mkdirSync(f);
  const logs: string[] = [];
  assert.throws(() => new Prefs(f, (m) => logs.push(m)), { code: 'EISDIR' });
  assert.ok(logs.some((m) => /load FAILED/.test(m)));
  assert.deepEqual(readdirSync(f), []);
});

for (const raw of ['null', '[]', '42', '"text"']) {
  test(`non-object preferences ${raw} are preserved without reset`, () => {
    const f = freshFile();
    writeFileSync(f, raw);
    assert.throws(() => new Prefs(f, () => {}), /must be a JSON object/);
    assert.equal(readFileSync(f, 'utf-8'), raw);
    assert.deepEqual(readdirSync(dirname(f)), ['prefs.json']);
  });
}
