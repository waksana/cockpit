import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMetaBusy } from './lifecycle.ts';

type BusyMeta = Parameters<typeof sessionMetaBusy>[0];

function meta(over: Partial<BusyMeta> = {}): BusyMeta {
  return { status: 'idle', ask: null, ...over };
}

function assertProtected(over: Partial<BusyMeta>): void {
  for (const status of ['idle', 'error', 'unloaded'] as const) {
    for (const scheduleCount of [undefined, 0, 1, 3]) {
      const snapshot = meta({ scheduleCount, ...over, status });
      const context = `while ${status} with ${scheduleCount ?? 'no'} schedules`;
      assert.equal(sessionMetaBusy(snapshot), true, `snapshot protection ${context}`);
    }
  }
}

test('sessionMetaBusy: inactive statuses with optional fields absent are not busy', () => {
  for (const status of ['idle', 'error', 'unloaded'] as const) {
    assert.equal(sessionMetaBusy(meta({ status })), false);
  }
});

test('sessionMetaBusy: running is busy', () => {
  for (const scheduleCount of [undefined, 0, 1, 3]) {
    const snapshot = meta({ status: 'running', scheduleCount });
    assert.equal(sessionMetaBusy(snapshot), true);
  }
});

test('sessionMetaBusy: a pending ask protects the session until answered', () => {
  assertProtected({ ask: { requestId: 'ask', question: 'Continue?' } });
  assert.equal(sessionMetaBusy(meta({ ask: null })), false);
});

test('sessionMetaBusy: a pending plan protects the session until resolved', () => {
  assertProtected({ planRequest: { requestId: 'plan', summary: 'Proposed changes' } });
  assert.equal(sessionMetaBusy(meta({ planRequest: null })), false);
});

test('sessionMetaBusy: a pending elicitation protects the session until resolved', () => {
  assertProtected({ elicitation: { requestId: 'input', message: 'Provide input' } });
  assert.equal(sessionMetaBusy(meta({ elicitation: null })), false);
});

for (const field of ['activeSubagents', 'activeMcpOperations', 'activeOperations'] as const) {
  test(`sessionMetaBusy: ${field} protects the session only when positive`, () => {
    for (const count of [1, 3]) assertProtected({ [field]: count });
    for (const count of [0, -1]) {
      assert.equal(sessionMetaBusy(meta({ [field]: count })), false);
    }
  });
}

test('sessionMetaBusy: future idle schedules do not protect inactive sessions', () => {
  for (const status of ['idle', 'error', 'unloaded'] as const) {
    for (const scheduleCount of [0, 1, 3]) {
      const snapshot = meta({ status, scheduleCount });
      assert.equal(sessionMetaBusy(snapshot), false);
    }
  }
});

for (const field of ['compacting', 'loading', 'closing', 'cancelling', 'nativeProcessing'] as const) {
  test(`sessionMetaBusy: ${field} protects the session until cleared`, () => {
    assertProtected({ [field]: true });
    assert.equal(sessionMetaBusy(meta({ [field]: false })), false);
  });
}

test('sessionMetaBusy: queued work protects the session until drained', () => {
  assertProtected({ queue: [{ id: 'queued-item', text: 'pending' }] });
  assert.equal(sessionMetaBusy(meta({ queue: [] })), false);
});

test('sessionMetaBusy: clearing one protection does not discard other active work', () => {
  assertProtected({ nativeProcessing: false, activeOperations: 1 });
  assertProtected({ activeOperations: 0, activeMcpOperations: 1 });
  assertProtected({ scheduleCount: 0, queue: [{ id: 'queued-item', text: 'pending' }] });
});

test('sessionMetaBusy: UI pinning neither makes a session busy nor overrides protection', () => {
  for (const pinned of [true, false]) {
    for (const scheduleCount of [undefined, 0, 1, 3]) {
      const snapshot = { ...meta({ scheduleCount }), pinned };
      assert.equal(sessionMetaBusy(snapshot), false);
      assert.equal(sessionMetaBusy({ ...snapshot, nativeProcessing: true }), true);
    }
  }
});
