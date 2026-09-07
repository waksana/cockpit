import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionMetaBusy, engineSessionBusy, queueTextTag, makeQueueId, parseQueueId,
} from './lifecycle.ts';

// Minimal meta shape the predicate reads. Cast through unknown to the Pick the
// helpers accept without dragging in the full SessionMeta.
function meta(over: Record<string, unknown> = {}): any {
  return { status: 'idle', ask: null, planRequest: null, elicitation: null, activeSubagents: 0, compacting: false, ...over };
}

test('sessionMetaBusy: idle with nothing pending is NOT busy', () => {
  assert.equal(sessionMetaBusy(meta()), false);
});

test('sessionMetaBusy: running is busy', () => {
  assert.equal(sessionMetaBusy(meta({ status: 'running' })), true);
});

test('sessionMetaBusy: a pending choice (ask/plan/elicitation) is busy even when idle', () => {
  assert.equal(sessionMetaBusy(meta({ ask: { requestId: 'r', prompt: 'p' } })), true);
  assert.equal(sessionMetaBusy(meta({ planRequest: { requestId: 'r' } })), true);
  assert.equal(sessionMetaBusy(meta({ elicitation: { requestId: 'r' } })), true);
});

test('sessionMetaBusy: an in-flight sub-agent is busy even when idle', () => {
  assert.equal(sessionMetaBusy(meta({ activeSubagents: 1 })), true);
  assert.equal(sessionMetaBusy(meta({ activeSubagents: 0 })), false);
});

test('sessionMetaBusy: a MANUAL compaction (status stays idle) is busy via compacting', () => {
  // The exact gap the old status-only guard missed.
  assert.equal(sessionMetaBusy(meta({ status: 'idle', compacting: true })), true);
});

test('sessionMetaBusy: an MCP mutation blocks unload and graceful restart', () => {
  assert.equal(sessionMetaBusy(meta({ activeMcpOperations: 1 })), true);
  assert.equal(sessionMetaBusy(meta({ activeMcpOperations: 0 })), false);
});

test('sessionMetaBusy: status:error is not, by itself, busy', () => {
  assert.equal(sessionMetaBusy(meta({ status: 'error' })), false);
});

test('engineSessionBusy: ORs the live in-flight count on top of the projected meta', () => {
  // meta says idle/0 but the live Set already has an add not yet projected.
  assert.equal(engineSessionBusy(meta(), 1), true);
  assert.equal(engineSessionBusy(meta(), 0), false);
  // and a busy meta stays busy regardless of the live count.
  assert.equal(engineSessionBusy(meta({ status: 'running' }), 0), true);
});

test('queueTextTag is stable, base36, and varies with content', () => {
  assert.equal(queueTextTag('hello'), queueTextTag('hello'));
  assert.notEqual(queueTextTag('hello'), queueTextTag('world'));
  assert.match(queueTextTag('anything'), /^[0-9a-z]+$/);
});

test('makeQueueId/parseQueueId round-trip carries index + content tag', () => {
  const id = makeQueueId(3, 'deploy the thing');
  const p = parseQueueId(id);
  assert.deepEqual(p, { index: 3, tag: queueTextTag('deploy the thing') });
});

test('parseQueueId tolerates the legacy positional form (empty tag)', () => {
  assert.deepEqual(parseQueueId('q-7'), { index: 7, tag: '' });
});

test('parseQueueId rejects anything else (fail-closed for the caller)', () => {
  assert.equal(parseQueueId('garbage'), null);
  assert.equal(parseQueueId('q-'), null);
  assert.equal(parseQueueId('q-x-y'), null);
});
