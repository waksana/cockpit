import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Intents, SessionControls, SessionProjection } from './index.ts';

test('native control actions require a loaded-handle identity and exact scoped input', () => {
  const parse = (action: unknown) => Intents['session/control'].body.parse({ sessionId: 's', token: 'handle', action });
  for (const action of [
    { type: 'stop-all' }, { type: 'stop-task', id: 'native-id' },
    { type: 'clear-tasks', kind: 'shell', ids: ['one', 'two'] },
    { type: 'clear-queue' }, { type: 'remove', id: 'queue-id' }, { type: 'steer', id: 'queue-id' },
    { type: 'cancel-decision', kind: 'ask', requestId: 'native-request' },
  ]) assert.deepEqual(parse(action).action, action);
  for (const action of [
    { type: 'stop-task', name: 'not-an-id' }, { type: 'stop-all', killAllProcesses: true },
    { type: 'clear-tasks', kind: 'shell', ids: ['one', 'one'] },
    { type: 'clear-tasks', kind: 'client', ids: ['one'] },
    { type: 'cancel-decision', kind: 'ask' }, { type: 'clear-tasks', kind: 'agent', ids: [] },
  ]) assert.throws(() => parse(action));
  assert.throws(() => Intents['session/control'].body.parse({ sessionId: 's', action: { type: 'stop-all' } }));
});

test('controls distinguish an unrequested resource from invalid data and retain every partial outcome', () => {
  assert.equal('controls' in SessionProjection.parse({ sessionId: 's', loaded: true }), false);
  assert.equal(SessionProjection.parse({ sessionId: 's', loaded: true, controls: null }).controls, null);
  SessionControls.parse({ token: 'h', sampledAt: 1, main: false, compaction: 'unknown', tasks: [], steering: [] });
  const result = { ok: false, outcomes: [
    { operation: 'task-cancel', targetId: 'a', state: 'accepted', result: { cancelled: true } },
    { operation: 'task-cancel', targetId: 'b', state: 'unconfirmed', error: 'Native acknowledgement missing' },
  ] };
  assert.deepEqual(Intents['session/control'].result.parse(result), result);
});
