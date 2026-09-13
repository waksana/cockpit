// Unit tests for attention.ts — the authoritative "needs the user" derivation.
// Pure transition function; no Engine/SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAttention, applySeen } from './attention.ts';

const idle = { status: 'idle', choicePending: false };
const running = { status: 'running', choicePending: false };

test('a confirmed native reply raises ready', () => {
  assert.equal(
    nextAttention({ status: 'running', choicePending: false, attention: null }, { ...idle, replyReady: true }),
    'ready',
  );
});

test('a pending choice raises choice (outranks everything)', () => {
  assert.equal(
    nextAttention({ status: 'running', choicePending: false, attention: null }, { status: 'running', choicePending: true }),
    'choice',
  );
  // choice wins even if status is idle
  assert.equal(
    nextAttention({ status: 'running', choicePending: false, attention: null }, { status: 'idle', choicePending: true }),
    'choice',
  );
});

test('answering a choice while the turn resumes clears attention', () => {
  // choice pending → user answers → turn continues (running), no choice
  assert.equal(
    nextAttention({ status: 'running', choicePending: true, attention: 'choice' }, running),
    null,
  );
});

test('a freshly loaded idle session does NOT read as ready', () => {
  // unloaded → idle on load; was not busy → stays null
  assert.equal(
    nextAttention({ status: 'unloaded', choicePending: false, attention: null }, idle),
    null,
  );
});

test('ready persists across an unrelated idle→idle patch', () => {
  // e.g. a todo/title patch arrives while already idle-and-ready
  assert.equal(
    nextAttention({ status: 'idle', choicePending: false, attention: 'ready' }, idle),
    'ready',
  );
});

test('sending the next prompt (idle→running) clears ready', () => {
  assert.equal(
    nextAttention({ status: 'idle', choicePending: false, attention: 'ready' }, running),
    null,
  );
});

test('answering a choice without a native reply does not invent unread content', () => {
  assert.equal(
    nextAttention({ status: 'running', choicePending: true, attention: 'choice' }, idle),
    null,
  );
});

test('error does not invent attention and unloading preserves unread replies', () => {
  assert.equal(
    nextAttention({ status: 'running', choicePending: false, attention: null }, { status: 'error', choicePending: false }),
    null,
  );
  assert.equal(
    nextAttention({ status: 'idle', choicePending: false, attention: 'ready' }, { status: 'unloaded', choicePending: false }),
    'ready',
  );
});

test('user-initiated (silent) idle never raises ready', () => {
  // The cancel path: running → idle, but the user caused it and is present, so
  // no ready/notification must fire.
  assert.equal(
    nextAttention({ status: 'running', choicePending: false, attention: null }, { status: 'idle', choicePending: false, silent: true }),
    null,
  );
});

test('silent transition clears a prior raised attention', () => {
  // Cancelling out of a pending-choice idle also clears it (user acted).
  assert.equal(
    nextAttention({ status: 'running', choicePending: true, attention: 'choice' }, { status: 'idle', choicePending: false, silent: true }),
    null,
  );
});

// --- applySeen: how a raised attention resolves on sight ---------------------

test('seeing a ready clears it (sight is completion)', () => {
  assert.deepEqual(
    applySeen({ attention: 'ready', attnId: 5, seenId: 0 }),
    { attention: null, seenId: 5 },
  );
});

test('seeing a choice keeps it raised, only advances seenId', () => {
  assert.deepEqual(
    applySeen({ attention: 'choice', attnId: 7, seenId: 0 }),
    { attention: 'choice', seenId: 7 },
  );
});

test('seenId is monotonic — a stale seen never lowers it', () => {
  assert.deepEqual(
    applySeen({ attention: null, attnId: 3, seenId: 9 }),
    { attention: null, seenId: 9 },
  );
});

test('seeing with nothing raised is a no-op on attention', () => {
  assert.deepEqual(
    applySeen({ attention: null, attnId: 0, seenId: 0 }),
    { attention: null, seenId: 0 },
  );
});
