import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueueAdvancer, type QueueAdvancePort } from './advance-queue.ts';

function fixture() {
  const manager = new QueueAdvancer();
  let pending = 3;
  let interrupts = 0;
  let listener: Parameters<QueueAdvancePort['observe']>[0] = () => {};
  let interrupt: QueueAdvancePort['interrupt'] = async () => { interrupts++; return { interrupted: true }; };
  const port: QueueAdvancePort = {
    pending: async () => pending, interrupt: (isCurrent, signal) => interrupt(isCurrent, signal),
    observe: callback => { listener = callback; return () => { listener = () => {}; }; },
  };
  return {
    manager, get interrupts() { return interrupts; },
    set pending(value: number) { pending = value; },
    set interrupt(value: QueueAdvancePort['interrupt']) { interrupt = value; },
    event: (event: Parameters<typeof listener>[0]) => listener(event),
    call: (action: 'start' | 'get' | 'cancel', operationId?: string) =>
      manager.call({ action, sessionId: 's', operationId }, async () => port).operation!,
  };
}

test('advance starts immediately, preserves latest tail and never reinterrupts an unsettled admission', async () => {
  const f = fixture();
  const first = f.call('start');
  assert.equal(first.state, 'running');
  await setImmediate();
  assert.equal(f.interrupts, 1);
  assert.equal(f.call('start').operationId, first.operationId);
  f.event('changed'); f.event('started');
  await setImmediate();
  assert.equal(f.interrupts, 1);
  f.pending = 2; f.event('admitted');
  await setImmediate();
  assert.equal(f.interrupts, 1, 'an admitted message must reach its native start before the next interrupt');
  f.event('started');
  await setImmediate();
  assert.equal(f.interrupts, 2);
  f.pending = 5; f.event('changed');
  await setImmediate();
  assert.equal(f.interrupts, 2);
  f.pending = 1; f.event('admitted'); f.event('started');
  await setImmediate();
  assert.equal(f.interrupts, 3);
  f.pending = 0; f.event('admitted');
  await setImmediate();
  assert.equal(f.call('get').state, 'completed', 'latest admitted turn continues; no idle event needed');
  f.pending = 1; f.event('changed');
  await setImmediate();
  assert.equal(f.interrupts, 3, 'completed operations do not monitor future arrivals');
});

test('cancel wakes an event wait without touching target; in-flight interruption settles once', async () => {
  const f = fixture();
  let settle!: (result: { interrupted: boolean }) => void;
  let calls = 0;
  f.interrupt = () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  const first = f.call('start');
  await setImmediate();
  assert.equal(f.call('cancel', first.operationId).state, 'cancelling');
  settle({ interrupted: true });
  await setImmediate();
  assert.equal(f.call('get').state, 'cancelled');
  assert.equal(calls, 1);
  const next = f.call('start');
  assert.notEqual(next.operationId, first.operationId);
  await setImmediate();
  settle({ interrupted: true });
  await setImmediate();
  f.call('cancel');
  await setImmediate();
  assert.equal(f.call('get').state, 'cancelled');
});

test('failed or uncertain interrupt stops and is queryable, never retried', async () => {
  const f = fixture();
  let calls = 0;
  f.interrupt = async () => { calls++; throw new Error('Outcome uncertain'); };
  f.call('start');
  await setImmediate();
  assert.equal(f.call('get').state, 'failed');
  assert.match(f.call('get').error!, /uncertain/);
  f.event('admitted'); f.event('started');
  await setImmediate();
  assert.equal(calls, 1);
});

test('empty queue completes without an interrupt; a closed target fails a waiting operation', async () => {
  const f = fixture();
  f.pending = 0;
  f.call('start');
  await setImmediate();
  assert.equal(f.call('get').state, 'completed');
  assert.equal(f.interrupts, 0);
  f.pending = 1; f.call('start');
  await setImmediate();
  f.event(new Error('Native session closed'));
  await setImmediate();
  assert.equal(f.call('get').state, 'failed');
  assert.throws(() => f.call('get', 'missing'), /Unknown/);
});

test('an idle false interrupt waits for admission rather than spinning', async () => {
  const f = fixture();
  let calls = 0;
  f.interrupt = async () => { calls++; return { interrupted: false }; };
  f.call('start');
  await setImmediate(); await setImmediate();
  assert.equal(calls, 1);
  f.pending = 0; f.event('admitted');
  await setImmediate();
  assert.equal(f.call('get').state, 'completed');
});
