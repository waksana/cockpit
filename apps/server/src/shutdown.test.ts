import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { GracefulShutdown } from './shutdown.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let busy = 1;
  const events: string[] = [], errors: unknown[] = [], exits: number[] = [];
  const busyCount = t.mock.fn(async () => busy);
  const stopNative = t.mock.fn(async () => { events.push('native'); });
  const closeTransport = t.mock.fn(async () => { events.push('transport'); });
  const shutdown = new GracefulShutdown({
    busyCount, stopNative, closeTransport, delayMs: 10,
    exit: code => { exits.push(code); events.push('exit'); },
    report: error => { errors.push(error); },
  });
  t.after(() => shutdown.dispose());
  const advance = async () => { await nextTurn(); t.mock.timers.tick(10); await nextTurn(); };
  return { shutdown, events, errors, exits, busyCount, stopNative, closeTransport, advance,
    idle: () => { busy = 0; }, busy: () => { busy = 1; } };
}

test('shutdown returns acceptance, waits for current native work, then closes exactly once', async t => {
  const f = fixture(t);
  const first = f.shutdown.request();
  assert.equal(first.phase, 'waiting');
  assert.equal(typeof first.requestedAt, 'number');
  await f.advance();
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.shutdown.request(), first);
  f.idle();
  f.shutdown.notify();
  await f.advance();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.shutdown.snapshot().phase, 'closed');
  f.shutdown.notify();
  await f.advance();
  assert.equal(f.stopNative.mock.callCount(), 1);
});

test('a retained mutation/response prevents shutdown even when native sessions are idle', async t => {
  const f = fixture(t);
  f.idle();
  const release = f.shutdown.retain();
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.inFlightRequests, 1);
  assert.deepEqual(f.events, []);
  release();
  release();
  await f.advance();
  assert.equal(f.shutdown.inFlightRequests, 0);
  assert.deepEqual(f.exits, [0]);
});

test('new protected work between idle observation and final close is not interrupted', async t => {
  const f = fixture(t);
  f.idle();
  f.shutdown.request();
  await nextTurn();
  f.busy();
  await f.advance();
  assert.deepEqual(f.events, []);
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  f.idle();
  f.shutdown.notify();
  await f.advance();
  assert.deepEqual(f.exits, [0]);
});

test('native close remains awaited before transport release and process exit', async t => {
  const f = fixture(t), held = deferred();
  f.idle();
  f.stopNative.mock.mockImplementation(async () => { f.events.push('native'); await held.promise; });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'closing');
  assert.deepEqual(f.events, ['native']);
  assert.throws(() => f.shutdown.retain(), /closing/);
  held.resolve();
  await nextTurn();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
});

test('unreadable or invalid native safety never becomes an idle success', async t => {
  const f = fixture(t);
  f.busyCount.mock.mockImplementation(async () => { throw new Error('Native safety unavailable'); });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  assert.match(f.shutdown.snapshot().error!, /unavailable/);
  assert.deepEqual(f.events, []);
  f.busyCount.mock.mockImplementation(async () => Number.NaN);
  f.shutdown.notify();
  await f.advance();
  assert.match(f.shutdown.snapshot().error!, /invalid/);
  f.busyCount.mock.mockImplementation(async () => 0);
  f.shutdown.notify();
  await f.advance();
  assert.deepEqual(f.exits, [0]);
});

test('a native busy preflight can return to waiting without replaying an uncertain close', async t => {
  const f = fixture(t);
  f.idle();
  f.stopNative.mock.mockImplementationOnce(async () => {
    f.busy();
    throw Object.assign(new Error('Session has protected work'), { code: 'SESSION_BUSY' });
  });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  assert.equal(f.closeTransport.mock.callCount(), 0);
  f.idle();
  f.shutdown.notify();
  await f.advance();
  assert.deepEqual(f.exits, [0]);
});

test('an uncertain native close stays failed and cannot be automatically requested again', async t => {
  const f = fixture(t);
  f.idle();
  f.stopNative.mock.mockImplementation(async () => { throw new Error('Close acknowledgement unknown'); });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'failed');
  assert.throws(() => f.shutdown.request(), /unknown/);
  f.shutdown.notify();
  await f.advance();
  assert.equal(f.stopNative.mock.callCount(), 1);
  assert.deepEqual(f.exits, []);
  assert.equal(f.closeTransport.mock.callCount(), 0);
});

test('transport failure is reported without claiming a normal exit', async t => {
  const f = fixture(t);
  f.idle();
  f.closeTransport.mock.mockImplementation(async () => { throw new Error('Transport close failed'); });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'failed');
  assert.deepEqual(f.exits, []);
});

test('confirmed native failure closes transports and exits nonzero even if native cleanup errors', async t => {
  const f = fixture(t);
  f.stopNative.mock.mockImplementation(async () => { throw new Error('Dead native cleanup error'); });
  f.shutdown.runtimeFailed(new Error('Owned native child exited'));
  await nextTurn();
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.closeTransport.mock.callCount(), 1);
  assert.equal(f.errors.length, 2);
  assert.equal(f.busyCount.mock.callCount(), 0);
});

test('disposing a test or detached controller cancels a pending exit timer', async t => {
  const f = fixture(t);
  f.idle();
  f.shutdown.request();
  await nextTurn();
  f.shutdown.dispose();
  await f.advance();
  assert.deepEqual(f.events, []);
});
