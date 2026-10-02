import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as nextTurn, setTimeout as wait } from 'node:timers/promises';
import { GracefulShutdown } from './shutdown.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext, prepareStop?: () => Promise<void>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let busy = 1;
  const events: string[] = [], errors: unknown[] = [], exits: number[] = [];
  const busyCount = t.mock.fn(async () => busy);
  const stopNative = t.mock.fn(async (beforeClose: () => Promise<void>) => { await beforeClose(); events.push('native'); });
  const closeTransport = t.mock.fn(async () => { events.push('transport'); });
  const shutdown = new GracefulShutdown({
    busyCount, prepareStop, stopNative, closeTransport, delayMs: 10,
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

test('native busy after preparation fails closed without reopening waiting or repeating module stop', async t => {
  const prepareStop = t.mock.fn(async () => {});
  const f = fixture(t, prepareStop);
  f.idle();
  f.stopNative.mock.mockImplementation(async beforeClose => {
    await beforeClose();
    throw Object.assign(new Error('Native work reappeared'), { code: 'SESSION_BUSY' });
  });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'failed');
  assert.match(f.shutdown.snapshot().error!, /reappeared/);
  f.shutdown.notify();
  f.shutdown.runtimeFailed(new Error('Later native failure'));
  await f.advance();
  assert.equal(f.stopNative.mock.callCount(), 1);
  assert.equal(prepareStop.mock.callCount(), 1);
  assert.deepEqual(f.events, []);
});

test('startup failure with a live busy runtime waits without stopping modules', async t => {
  const prepareStop = t.mock.fn(async () => {});
  const f = fixture(t, prepareStop);
  f.shutdown.startupFailed(new Error('Listen failed'));
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  assert.equal(prepareStop.mock.callCount(), 0);
  assert.deepEqual(f.events, []);
  f.idle();
  f.shutdown.notify();
  await f.advance();
  assert.equal(prepareStop.mock.callCount(), 1);
  assert.deepEqual(f.exits, [1]);
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

test('without preparation native failure retains the legacy immediate cleanup path', async t => {
  const f = fixture(t);
  const release = f.shutdown.retain();
  f.shutdown.runtimeFailed(new Error('Owned native child exited'));
  await nextTurn();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
  assert.deepEqual(f.exits, [1]);
  release();
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

test('preparation starts only inside native preflight after idle and precedes native shutdown', async t => {
  const held = deferred();
  const prepareStop = t.mock.fn(() => {
    f.events.push('prepare');
    return held.promise;
  });
  const f = fixture(t, prepareStop);
  f.idle();
  const first = f.shutdown.request();
  assert.equal(first.phase, 'waiting');
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.shutdown.request(), first);
  await f.advance();
  assert.equal(f.stopNative.mock.callCount(), 1);
  assert.equal(f.shutdown.snapshot().phase, 'closing');
  assert.equal(prepareStop.mock.callCount(), 1);

  held.resolve();
  await f.advance();
  assert.deepEqual(f.events, ['prepare', 'native', 'transport', 'exit']);
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.shutdown.snapshot().phase, 'closed');
});

test('preparation cannot start while native busy or retained response work remains', async t => {
  const held = deferred(), prepareStop = t.mock.fn(() => held.promise);
  const f = fixture(t, prepareStop);
  f.shutdown.request();
  held.resolve();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  assert.deepEqual(f.events, []);
  assert.equal(prepareStop.mock.callCount(), 0);
  assert.ok(f.busyCount.mock.callCount() > 0);

  const release = f.shutdown.retain();
  f.idle();
  f.shutdown.notify();
  await f.advance();
  assert.deepEqual(f.events, []);
  assert.equal(prepareStop.mock.callCount(), 0);
  release();
  await f.advance();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
  assert.equal(prepareStop.mock.callCount(), 1);
});

test('a native busy preflight returns to waiting without starting preparation', async t => {
  const prepareStop = t.mock.fn(async () => {});
  const f = fixture(t, prepareStop);
  f.idle();
  f.stopNative.mock.mockImplementationOnce(async () => {
    f.busy();
    throw Object.assign(new Error('Session has protected work'), { code: 'SESSION_BUSY' });
  });
  f.shutdown.request();
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  assert.equal(f.closeTransport.mock.callCount(), 0);
  assert.equal(prepareStop.mock.callCount(), 0);
  f.idle();
  f.shutdown.request();
  await f.advance();
  assert.equal(prepareStop.mock.callCount(), 1);
  assert.equal(f.stopNative.mock.callCount(), 2);
  assert.deepEqual(f.exits, [0]);
});

for (const code of ['MODULE_SHUTDOWN_FAILED', 'MODULE_SHUTDOWN_TIMEOUT', 'SESSION_BUSY']) {
  test(`preparation rejection (${code}) stays failed even after native runtime failure`, async t => {
    const held = deferred(), prepareStop = t.mock.fn(() => held.promise);
    const f = fixture(t, prepareStop);
    f.idle();
    f.shutdown.request();
    await f.advance();
    const error = Object.assign(new Error('Module preparation failed'), { code });
    held.reject(error);
    await f.advance();
    assert.equal(f.shutdown.snapshot().phase, 'failed');
    assert.equal(f.shutdown.snapshot().error, error.message);
    assert.equal(f.errors[0], error);
    assert.throws(() => f.shutdown.request(), /Module preparation failed/);
    f.shutdown.runtimeFailed(new Error('Native subsequently exited'));
    f.shutdown.notify();
    held.resolve();
    await f.advance();
    assert.equal(f.shutdown.snapshot().phase, 'failed');
    assert.equal(f.shutdown.snapshot().error, error.message);
    assert.equal(prepareStop.mock.callCount(), 1);
    assert.deepEqual(f.errors, [error]);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.exits, []);
  });
}

test('a synchronous preparation exception fails closed without escaping the request', async t => {
  const error = new Error('Synchronous module failure');
  const prepareStop = t.mock.fn((): Promise<void> => { throw error; });
  const f = fixture(t, prepareStop);
  f.idle();
  assert.equal(f.shutdown.request().phase, 'waiting');
  await f.advance();
  assert.equal(f.shutdown.snapshot().phase, 'failed');
  f.shutdown.runtimeFailed(new Error('Native subsequently exited'));
  await f.advance();
  assert.equal(f.shutdown.snapshot().error, error.message);
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.events, []);
  assert.equal(prepareStop.mock.callCount(), 1);
});

for (const requested of [false, true]) {
  test(`native failure waits for preparation ${requested ? 'during shutdown' : 'at startup'}`, async t => {
    const held = deferred(), prepareStop = t.mock.fn(() => held.promise);
    const f = fixture(t, prepareStop);
    if (requested) f.shutdown.request();
    f.shutdown.runtimeFailed(new Error('Owned native child exited'));
    assert.equal(prepareStop.mock.callCount(), 1);
    assert.equal(f.shutdown.snapshot().phase, 'closing');
    await f.advance();
    assert.deepEqual(f.events, []);
    f.shutdown.request();
    f.shutdown.runtimeFailed(new Error('Repeated native failure'));
    held.resolve();
    await nextTurn();
    assert.deepEqual(f.events, ['native', 'transport', 'exit']);
    assert.deepEqual(f.exits, [1]);
    assert.equal(prepareStop.mock.callCount(), 1);
    assert.equal(f.busyCount.mock.callCount(), requested ? 1 : 0);
  });
}

test('preparation rejection after native failure blocks all cleanup and preserves its error', async t => {
  const held = deferred(), f = fixture(t, () => held.promise);
  f.shutdown.runtimeFailed(new Error('Owned native child exited'));
  const error = new Error('Module shutdown timed out');
  held.reject(error);
  await f.advance();
  f.shutdown.runtimeFailed(new Error('Repeated native failure'));
  assert.equal(f.shutdown.snapshot().phase, 'failed');
  assert.equal(f.shutdown.snapshot().error, error.message);
  assert.equal(f.errors.at(-1), error);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.exits, []);
});

test('native failure still retains an HTTP response while preparation completes', async t => {
  const held = deferred(), f = fixture(t, () => held.promise);
  const release = f.shutdown.retain();
  f.shutdown.request();
  f.shutdown.runtimeFailed(new Error('Owned native child exited'));
  assert.equal(f.shutdown.snapshot().phase, 'waiting');
  held.resolve();
  await f.advance();
  assert.deepEqual(f.events, []);
  release();
  await nextTurn();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
  assert.deepEqual(f.exits, [1]);
});

test('reentrant shutdown requests and runtime failure cannot start preparation twice', async t => {
  const held = deferred();
  const prepareStop = t.mock.fn(() => {
    assert.equal(f.shutdown.request().phase, 'closing');
    f.shutdown.runtimeFailed(new Error('Native failed during preparation'));
    return held.promise;
  });
  const f = fixture(t, prepareStop);
  f.idle();
  f.shutdown.request();
  await f.advance();
  assert.equal(prepareStop.mock.callCount(), 1);
  await f.advance();
  assert.deepEqual(f.events, []);
  held.resolve();
  await nextTurn();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
  assert.deepEqual(f.exits, [1]);
  assert.equal(prepareStop.mock.callCount(), 1);
});

test('disposing pending preparation cannot trigger cleanup after it resolves', async t => {
  const held = deferred(), f = fixture(t, () => held.promise);
  f.idle();
  f.shutdown.request();
  await f.advance();
  f.shutdown.dispose();
  held.resolve();
  await f.advance();
  assert.deepEqual(f.events, []);
});

test('runtime failure reported reentrantly during native cleanup does not duplicate cleanup', async t => {
  const f = fixture(t, async () => {});
  f.idle();
  f.stopNative.mock.mockImplementation(async beforeClose => {
    await beforeClose();
    f.events.push('native');
    f.shutdown.runtimeFailed(new Error('Native child exited during close'));
  });
  f.shutdown.request();
  await f.advance();
  assert.deepEqual(f.events, ['native', 'transport', 'exit']);
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.stopNative.mock.callCount(), 1);
});

for (const code of ['MODULE_SHUTDOWN_FAILED', 'MODULE_SHUTDOWN_TIMEOUT']) {
  for (const nativeFailed of [false, true]) {
    test(`module disposal ${code} prevents exit with native runtime ${nativeFailed ? 'dead' : 'healthy'}`, async t => {
      const f = fixture(t, async () => {});
      const error = Object.assign(new Error('Module disposal incomplete'), { code });
      f.idle();
      f.closeTransport.mock.mockImplementation(async () => { throw error; });
      if (nativeFailed) f.shutdown.runtimeFailed(new Error('Owned native child exited'));
      else f.shutdown.request();
      await f.advance();
      assert.equal(f.shutdown.snapshot().phase, 'failed');
      assert.equal(f.shutdown.snapshot().error, error.message);
      assert.equal(f.errors.at(-1), error);
      assert.deepEqual(f.exits, []);
      assert.throws(() => f.shutdown.request(), /Module disposal incomplete/);

      f.shutdown.runtimeFailed(new Error('Subsequent native failure'));
      f.shutdown.notify();
      await f.advance();
      assert.equal(f.shutdown.snapshot().phase, 'failed');
      assert.equal(f.shutdown.snapshot().error, error.message);
      assert.equal(f.errors.at(-1), error);
      assert.equal(f.stopNative.mock.callCount(), 1);
      assert.equal(f.closeTransport.mock.callCount(), 1);
      assert.deepEqual(f.exits, []);
    });
  }
}

test('generic transport failure after confirmed native failure retains the nonzero exit path', async t => {
  const f = fixture(t, async () => {});
  f.closeTransport.mock.mockImplementation(async () => { throw new Error('Transport close failed'); });
  f.shutdown.runtimeFailed(new Error('Owned native child exited'));
  await nextTurn();
  assert.equal(f.shutdown.snapshot().phase, 'closed');
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.errors.length, 2);
});

function shutdownProcess(t: TestContext, trigger: 'request' | 'fatal', exitThrows = false) {
  const script = `
    import { GracefulShutdown } from ${JSON.stringify(new URL('./shutdown.ts', import.meta.url).href)};
    let resolve, reject;
    const preparation = new Promise((done, fail) => { resolve = done; reject = fail; });
    const events = [];
    const shutdown = new GracefulShutdown({
      prepareStop: () => preparation,
      busyCount: async () => 0,
      stopNative: async beforeClose => { await beforeClose(); events.push('native'); },
      closeTransport: async () => { events.push('transport'); },
      exit: () => {
        events.push('exit');
        if (${exitThrows}) throw new Error('Exit callback failed');
      },
      report: () => {},
      delayMs: 0,
    });
    const send = () => process.send({ ...shutdown.snapshot(), events });
    process.on('message', message => {
      if (message === 'dispose') shutdown.dispose();
      else if (message === 'resolve') resolve();
      else reject(Object.assign(new Error('Module preparation failed'), { code: message }));
      setImmediate(send);
    });
    process.on('SIGINT', () => {});
    process.channel.unref();
    ${trigger === 'request' ? 'shutdown.request()' : "shutdown.runtimeFailed(new Error('Startup failed'))"};
    send();
  `;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  assert.ok(child.stderr);
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const message = async () => {
    const [snapshot] = await Promise.race([
      once(child, 'message'),
      exited.then(([code, signal]) => {
        throw new Error(`Shutdown subprocess exited before its response: ${code}/${signal}; ${stderr}`);
      }),
    ]);
    return snapshot as { phase: string; error: string | null; events: string[] };
  };
  const send = (command: string) => {
    const response = message();
    child.send(command);
    return response;
  };
  const alive = async () => {
    await wait(100);
    assert.equal(child.exitCode, null, stderr);
    assert.equal(child.signalCode, null, stderr);
  };
  return { message, send, alive, exited };
}

for (const trigger of ['request', 'fatal'] as const) {
  for (const code of ['MODULE_SHUTDOWN_FAILED', 'MODULE_SHUTDOWN_TIMEOUT']) {
    test(`${trigger} before startup holds the real process through pending preparation and ${code}`, {
      timeout: 10_000,
    }, async t => {
      const child = shutdownProcess(t, trigger);
      assert.equal((await child.message()).phase, trigger === 'fatal' ? 'closing' : 'waiting');
      await child.alive();
      const failed = await child.send(code);
      assert.equal(failed.phase, 'failed');
      assert.equal(failed.error, 'Module preparation failed');
      assert.deepEqual(failed.events, []);
      await child.alive();
      await child.send('dispose');
      assert.deepEqual(await child.exited, [0, null]);
    });
  }
}

for (const exitThrows of [false, true]) {
  test(`shutdown liveness ${exitThrows ? 'survives a throwing' : 'releases after a successful'} exit callback`, {
    timeout: 10_000,
  }, async t => {
    const child = shutdownProcess(t, 'fatal', exitThrows);
    assert.equal((await child.message()).phase, 'closing');
    const completed = await child.send('resolve');
    assert.equal(completed.phase, exitThrows ? 'failed' : 'closed');
    assert.deepEqual(completed.events, ['native', 'transport', 'exit']);
    if (exitThrows) {
      assert.equal(completed.error, 'Exit callback failed');
      await child.alive();
      await child.send('dispose');
    }
    assert.deepEqual(await child.exited, [0, null]);
  });
}
