import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionMeta } from '@cockpit/protocol';
import {
  currentInboxRevision, isUnreadAttention, mergeAttentionPatch, patchedUnreadCount,
} from './inboxProjection';

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: 'session', title: 'Session', cwd: '/project', lastActivity: 1,
    status: 'idle', loaded: true, error: null, queue: [], ask: null,
    ...patch,
  };
}

test('mergeAttentionPatch keeps seenId monotone without mutating its inputs', () => {
  const current = session({ attention: 'choice', attnId: 9, seenId: 7 });
  for (const patch of [{}, { seenId: 3 }, { seenId: 7 }, { seenId: 10 }]) {
    const originalPatch = { ...patch };
    const next = mergeAttentionPatch(current, patch);
    assert.deepEqual(next, { ...current, seenId: Math.max(7, patch.seenId ?? 0) });
    assert.notEqual(next, current);
    assert.equal(current.seenId, 7);
    assert.deepEqual(patch, originalPatch);
  }
  assert.equal(mergeAttentionPatch(session(), {}).seenId, 0);
  assert.equal(mergeAttentionPatch(session(), { seenId: 2 }).seenId, 2);
});

test('a lower attnId preserves current attention while applying other metadata', () => {
  const current = session({ attention: 'choice', attnId: 9, seenId: 5 });
  for (const attention of ['ready', null] as const) {
    const next = mergeAttentionPatch(current, {
      attention, attnId: 8, seenId: 6, title: 'Renamed', pinned: true, lastActivity: 2,
    });
    assert.deepEqual(next, {
      ...current, seenId: 6, title: 'Renamed', pinned: true, lastActivity: 2,
    });
  }
});

test('a delayed null/seenId ACK cannot clear newer ready or choice attention', () => {
  for (const attention of ['ready', 'choice'] as const) {
    const current = session({ attention, attnId: 9, seenId: 5 });
    const next = mergeAttentionPatch(current, { attention: null, seenId: 8 });
    assert.deepEqual(next, { ...current, seenId: 8 });
    assert.equal(isUnreadAttention(next), true);
  }
});

test('current seen ACKs and explicit current-attnId patches can clear attention', () => {
  const current = session({ attention: 'ready', attnId: 9, seenId: 5 });
  const seen = mergeAttentionPatch(current, { attention: null, seenId: 9 });
  assert.deepEqual(seen, { ...current, attention: null, seenId: 9 });
  assert.equal(isUnreadAttention(seen), false);

  const cleared = mergeAttentionPatch(current, { attention: null, attnId: 9 });
  assert.deepEqual(cleared, { ...current, attention: null });
  assert.equal(isUnreadAttention(cleared), false);
});

test('patchedUnreadCount preserves authoritative excess, counts unread choices, and clamps at zero', () => {
  const ready = session({ sessionId: 'ready', attention: 'ready', attnId: 3, seenId: 2 });
  const choice = session({ sessionId: 'choice', attention: 'choice', attnId: 4, seenId: 3 });
  const seenChoice = { ...choice, seenId: 4 };
  const quiet = session({ sessionId: 'quiet', attention: null, attnId: 8, seenId: 0 });
  const legacyChoice = session({ sessionId: 'legacy', attention: 'choice' });
  const before = [ready, choice, quiet, legacyChoice];
  const after = [ready, seenChoice, quiet, legacyChoice];

  assert.equal(patchedUnreadCount(0, [], before), 2);
  assert.equal(patchedUnreadCount(0, [], [seenChoice, quiet, legacyChoice]), 0);
  assert.equal(patchedUnreadCount(9, before, after), 8);
  assert.equal(patchedUnreadCount(8, after, before), 9);
  assert.equal(patchedUnreadCount(9, before, before), 9);
  assert.equal(patchedUnreadCount(0, before, after), 0);
});

test('currentInboxRevision accepts equal/newer revisions and legacy only before a known revision', () => {
  const cases: [number | undefined, number | undefined, boolean][] = [
    [undefined, undefined, true],
    [undefined, 0, true],
    [undefined, 5, true],
    [0, undefined, false],
    [0, 0, true],
    [5, undefined, false],
    [5, 4, false],
    [5, 5, true],
    [5, 6, true],
  ];
  for (const [previous, incoming, expected] of cases) {
    assert.equal(currentInboxRevision(previous, incoming), expected,
      `previous=${previous}, incoming=${incoming}`);
  }
});
