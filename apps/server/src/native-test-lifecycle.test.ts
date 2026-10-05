import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { NativeTestLifecycle } from '../../../packages/core/test-support/native-test-lifecycle.ts';

const deferred = <T = void>() => Promise.withResolvers<T>();
const killIfPresent = (pid: number) => {
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};

async function stubbornChild(
  t: TestContext, lifecycle: NativeTestLifecycle, client: Parameters<NativeTestLifecycle['starting']>[0],
) {
  const closed = deferred();
  let rescued = false;
  const child = await lifecycle.starting(client, async () => {
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => process.send('ignored SIGTERM'));
      setInterval(() => {}, 1000);
      process.send('ready');
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('close', () => closed.resolve());
    const kill = child.kill.bind(child);
    const safety = setTimeout(() => { rescued = true; kill('SIGKILL'); }, 3_000);
    t.after(async () => { clearTimeout(safety); kill('SIGKILL'); await closed.promise; });
    assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
    return child;
  });
  return { child, closed: closed.promise, wasRescued: () => rescued };
}

test('native fixture abort interrupts the body and closes owned HTTP connections', { timeout: 5_000 }, async t => {
  const controller = new AbortController();
  const messages: string[] = [];
  const lifecycle = new NativeTestLifecycle(controller.signal, message => messages.push(message));
  const body = deferred();
  let forced = 0, removed = false;
  lifecycle.own({ async forceStop() { forced++; body.reject(controller.signal.reason); } });
  const server = lifecycle.server(createServer());
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  lifecycle.setPhase('synthetic body');
  const running = lifecycle.operation('client.createSession', () => body.promise);
  const rejection = assert.rejects(running, /deadline/);
  controller.abort(new Error('deadline'));
  await rejection;
  await lifecycle.finish(async () => assert.fail('must not start graceful cleanup after abort'), async () => { removed = true; });
  assert.equal(forced, 1);
  assert.equal(removed, true);
  assert.equal(server.listening, false);
  assert.match(messages[0]!, /phase=synthetic body; pending=client.createSession/);
});

test('native fixture deadline interrupts pending graceful cleanup', async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  const lifecycle = new NativeTestLifecycle(controller.signal, message => messages.push(message));
  const stopping = deferred(), entered = deferred();
  let forced = 0, disposed = false;
  lifecycle.own({ async forceStop() { forced++; stopping.reject(new Error('disposed connection')); } });
  const finishing = lifecycle.finish(() => lifecycle.operation('client.stop', () => {
    entered.resolve(); return stopping.promise;
  }), async () => { disposed = true; });
  const rejection = assert.rejects(finishing, /Native fixture cleanup failed/);
  await entered.promise;
  controller.abort(new Error('deadline'));
  await rejection;
  assert.ok(forced >= 1);
  assert.equal(disposed, true);
  assert.match(messages[0]!, /phase=graceful cleanup; pending=client.stop/);
  assert.ok(messages.includes('Native fixture cleanup failed: graceful cleanup'));
});

test('native fixture successful teardown disarms node:test completion abort', async () => {
  const controller = new AbortController();
  const lifecycle = new NativeTestLifecycle(controller.signal, () => assert.fail('unexpected diagnostic'));
  let forced = 0, disposed = false;
  lifecycle.own({ async forceStop() { forced++; } });
  await lifecycle.finish(async () => {}, async () => { disposed = true; });
  controller.abort();
  assert.equal(forced, 0);
  assert.equal(disposed, true);
});

test('native fixture abort closes the child that actual SDK stop has already forgotten', { timeout: 5_000 }, async t => {
  const controller = new AbortController();
  const messages: string[] = [];
  const lifecycle = new NativeTestLifecycle(controller.signal, message => messages.push(message));
  const client = lifecycle.clientFactory({});
  const owned = await stubbornChild(t, lifecycle, client);
  // Inject only this synthetic child into the real SDK's stop/forceStop path.
  const sdk = client as unknown as { cliProcess: ChildProcess | null };
  sdk.cliProcess = owned.child;
  let closed = false, removed = false;
  void owned.closed.then(() => { closed = true; });
  const ignored = once(owned.child, 'message');
  const finishing = lifecycle.finish(async () => { await client.stop(); }, async () => {
    assert.equal(closed, true, 'child close must precede directory removal');
    removed = true;
  });
  assert.deepEqual(await ignored, ['ignored SIGTERM', undefined]);
  assert.equal(sdk.cliProcess, null, 'SDK stop clears its reference before waiting for child exit');
  await client.forceStop();
  assert.equal(owned.child.exitCode, null);
  assert.equal(owned.child.signalCode, null, 'SDK forceStop can return while the forgotten child is alive');
  assert.equal(closed, false);
  controller.abort(new Error('deadline after SDK reference clearing'));
  await finishing;
  assert.equal(owned.wasRescued(), false, 'lifecycle, not the safety timer, must kill the child');
  assert.equal(owned.child.signalCode, 'SIGKILL');
  assert.equal(removed, true);
  assert.match(messages[0]!, /phase=graceful cleanup; pending=client.stop/);
});

test('native fixture graceful failure kills owned children even when forceStop does nothing', { timeout: 5_000 }, async t => {
  const lifecycle = new NativeTestLifecycle(new AbortController().signal, () => {});
  const client = lifecycle.own({ async forceStop() {} });
  const owned = await stubbornChild(t, lifecycle, client);
  const failure = new Error('stop failed');
  let closed = false, removed = false;
  void owned.closed.then(() => { closed = true; });
  await assert.rejects(lifecycle.finish(async () => { throw failure; }, async () => {
    assert.equal(closed, true);
    removed = true;
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(owned.wasRescued(), false);
  assert.equal(owned.child.signalCode, 'SIGKILL');
  assert.equal(removed, true);
});

for (const mode of ['false', 'throw', 'error event'] as const) {
  test(`native fixture diagnoses child kill ${mode} without waiting forever or removing its directory`, {
    timeout: 5_000,
  }, async t => {
    const controller = new AbortController();
    const messages: string[] = [];
    const lifecycle = new NativeTestLifecycle(controller.signal, message => messages.push(message));
    const client = lifecycle.own({ async forceStop() {} });
    const owned = await stubbornChild(t, lifecycle, client);
    const failure = new Error('synthetic SIGKILL failure');
    const kill = t.mock.method(owned.child, 'kill', () => {
      if (mode === 'throw') throw failure;
      if (mode === 'error event') owned.child.emit('error', failure);
      return false;
    });
    let removed = false;
    const entered = deferred(), stopping = deferred();
    const finishing = lifecycle.finish(async () => {
      entered.resolve(); await stopping.promise;
    }, async () => { removed = true; });
    const rejection = assert.rejects(finishing, error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      if (mode === 'false') assert.match(error.errors[0].message, /rejected SIGKILL/);
      else assert.equal(error.errors[0], failure);
      return true;
    });
    try {
      await entered.promise;
      controller.abort(new Error('deadline'));
      await rejection;
      assert.equal(owned.wasRescued(), false);
      assert.equal(removed, false, 'a live owned child prevents directory removal');
      assert.equal(owned.child.signalCode, null);
      assert.ok(messages.includes('Native fixture cleanup failed: owned child SIGKILL'));
    } finally {
      stopping.resolve();
      kill.mock.restore();
    }
  });
}

test('native fixture surfaces forceStop and disposal failures without replacing the abort reason', async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  const lifecycle = new NativeTestLifecycle(controller.signal, message => messages.push(message));
  const forceError = new Error('force failed'), disposeError = new Error('remove failed');
  lifecycle.own({ async forceStop() { throw forceError; } });
  const timeout = new Error('original deadline');
  controller.abort(timeout);
  await assert.rejects(lifecycle.finish(async () => {}, async () => { throw disposeError; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [forceError, disposeError]);
    return true;
  });
  assert.equal(controller.signal.reason, timeout);
  assert.ok(messages.includes('Native fixture cleanup failed: client.forceStop'));
  assert.ok(messages.includes('Native fixture cleanup failed: fixture removal'));
  assert.throws(() => lifecycle.own({ async forceStop() {} }), /original deadline/);
});

test('native fixture tracks startup before a child exists and awaits late child close', { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  const lifecycle = new NativeTestLifecycle(controller.signal, () => {});
  const ready = deferred(), spawn = deferred();
  let child: ReturnType<typeof execFile> | undefined;
  let forced = 0;
  const client = lifecycle.own({ async forceStop() { forced++; } });
  const starting = lifecycle.starting(client, async () => {
    ready.resolve();
    await spawn.promise;
    child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeout: 5_000, killSignal: 'SIGKILL',
    });
    await new Promise<void>(resolve => child!.once('close', () => resolve()));
  });
  await ready.promise;
  controller.abort(new Error('deadline during executable resolution'));
  const finishing = lifecycle.finish(async () => {}, async () => {
    assert.notEqual(child!.signalCode, null, 'child termination precedes directory removal');
  });
  spawn.resolve();
  await starting;
  await finishing;
  assert.ok(forced >= 2, 'abort before spawn must also stop the late child');
});

test('unresponsive synthetic MCP exits nonzero at the native test deadline without leaked resources', {
  skip: process.env.COCKPIT_NATIVE_TOOL_SCOPE !== '1', timeout: 25_000,
}, async () => {
  const root = resolve(`.native-timeout-regression-${randomUUID()}`);
  await mkdir(root);
  let evidence: { pids: number[]; port: number; held: boolean } | undefined;
  let verified = false;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, COCKPIT_NATIVE_TIMEOUT_ROOT: root };
    // A nested runner must not inherit the parent's test-worker IPC mode.
    delete env.NODE_TEST_CONTEXT;
    const result = await new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>(resolve => {
      // Keep the fixture in the owned process so its outer timeout cannot orphan a test worker.
      execFile(process.execPath, ['--import', 'tsx', '--test', '--test-isolation=none', 'src/test-support/native-timeout.fixture.test.ts'], {
        cwd: process.cwd(), env,
        timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.ok(result.error, result.stdout + result.stderr);
    assert.equal(result.error.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /test timed out after 2000ms/);
    assert.match(result.stdout + result.stderr, /phase=unresponsive synthetic MCP; pending=client.createSession/);
    evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'));
    assert.equal(evidence!.held, true, 'the synthetic MCP actually received and withheld tools/list');
    assert.equal(await readFile(join(root, 'removed'), 'utf8'), 'closed and removed');
    assert.equal(existsSync(join(root, 'fixture')), false);
    assert.ok(evidence!.pids.length > 0);
    for (const pid of evidence!.pids) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `native child ${pid} is gone`);
    }
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(evidence!.port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
    });
    verified = true;
  } finally {
    // A failing regression must not leave its synthetic child behind either.
    evidence ??= await readFile(join(root, 'evidence.json'), 'utf8').then(JSON.parse, () => undefined);
    if (!verified) for (const pid of evidence?.pids ?? []) killIfPresent(pid);
    await rm(root, { recursive: true, force: true });
  }
});
