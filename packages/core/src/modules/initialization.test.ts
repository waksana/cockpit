import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ModuleInitializationOperation, type ModuleInitializationRequest } from '@cockpit/protocol';
import { ModuleCatalog, type ModuleManifest } from './catalog.ts';
import { ModuleInitialization } from './initialization.ts';
import { ModuleManager } from './manager.ts';
import { OfficialRuntime } from '../runtime.ts';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Synthetic initialization did not reach expected boundary');
    await nextTurn();
  }
}
function fixture(t: TestContext, mode = 'success', capability = true) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-config-init-'));
  const source = join(root, 'source'), userRoot = join(root, 'user');
  const data = join(userRoot, 'data/task');
  let initializer: ModuleInitialization | undefined;
  t.after(async () => {
    const owner = initializer;
    if (owner?.activeCount()) {
      writeFileSync(join(data, 'release'), 'release synthetic child');
      await waitFor(() => owner.activeCount() === 0);
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(source, { mode: 0o700 });
  const manifest: ModuleManifest = { schemaVersion: 1, id: 'task', version: '1.0.0', name: 'Task', description: 'Offline setup fixture',
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
    ...(capability ? { configLifecycle: { initialize: { entry: 'setup.mjs', args: ['--mode', mode] } } } : {}) };
  writeFileSync(join(source, 'module.json'), JSON.stringify(manifest));
  copyFileSync(new URL('./initialization-hook.fixture.mjs', import.meta.url), join(source, 'setup.mjs'));
  const catalog = new ModuleCatalog({ userRoot, trustedSources: [source] });
  const installed = catalog.installFromDirectory(source);
  initializer = new ModuleInitialization(catalog);
  const input: ModuleInitializationRequest = { moduleId: 'task', operationId: 'initial-config-operation',
    version: '1.0.0', digest: installed.digest, gatewayUrl: 'https://cockpit.example', confirm: true };
  const callsFile = join(data, 'calls.jsonl');
  const calls = () => {
    if (!existsSync(callsFile)) return [];
    const lines = readFileSync(callsFile, 'utf8').split('\n');
    lines.pop(); // A concurrent writer may not have published the terminating newline yet.
    return lines.map(line => JSON.parse(line));
  };
  const receiptFile = join(userRoot, 'module-config-initializations/task.json');
  return { root, source, userRoot, data, catalog, installed, initializer, input, calls, receiptFile };
}
function driver(root: string, input: ModuleInitializationRequest, mode = 'normal') {
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./initialization-driver.fixture.mjs', import.meta.url).pathname, root, mode],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.end(JSON.stringify(input));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('configuration initialization executes only the declared CLI once and writes private managed references without starting a service', async t => {
  const f = fixture(t);
  const operation = await f.initializer.start(f.input);
  assert.equal(operation.phase, 'succeeded', operation.reason);
  assert.deepEqual(ModuleInitializationOperation.parse(operation), operation);
  assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0].body, { operation: 'config-initialize', operationId: f.input.operationId, dataDirectory: f.data });
  assert.deepEqual(f.calls()[0].argv, ['--mode', 'success']);
  assert.deepEqual(f.calls()[0].env, {}, 'no HOME, tokens, NODE_OPTIONS, PATH or delivery environment is inherited');
  const config = f.catalog.readConfig('task');
  assert.equal(config.revision, 1);
  assert.equal(config.values.ownership, 'managed');
  assert.equal(config.values.activationEnabled, true);
  assert.equal(config.values.gatewayUrl, f.input.gatewayUrl);
  assert.equal(config.values.dataDirectory, f.data);
  assert.equal(statSync(f.receiptFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.userRoot, 'module-config-initializations')).mode & 0o777, 0o700);
  assert.equal(readFileSync(f.receiptFile, 'utf8').includes('M'.repeat(48)), false);
  assert.equal(JSON.stringify(operation).includes('V'.repeat(48)), false);
  const url = new URL(String(config.values.serviceUrl)), listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject); listener.listen(Number(url.port), '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const before = readFileSync(f.receiptFile, 'utf8');
  const reopened = new ModuleInitialization(new ModuleCatalog({ userRoot: f.userRoot }));
  assert.deepEqual(reopened.get(f.input.operationId), operation);
  assert.deepEqual(await reopened.start(f.input), operation);
  assert.equal(readFileSync(f.receiptFile, 'utf8'), before);
  assert.equal(f.calls().length, 1);
  assert.equal(reopened.get('different-operation'), null);
  await assert.rejects(reopened.start({ ...f.input, operationId: 'different-operation' }), /original operation/);
  await assert.rejects(reopened.start({ ...f.input, gatewayUrl: 'https://changed.example' }), /original operation/);
});

test('Manager advertises initialization only for the installed Task capability, never a local source alone', async t => {
  for (const capability of [true, false]) {
    const f = fixture(t, 'success', capability);
    const manager = new ModuleManager({ runtime: new OfficialRuntime(), userRoot: f.userRoot, sources: { task: f.source } });
    const modules = await manager.list();
    assert.equal(modules.find(module => module.id === 'task')?.supportsInitialization, capability);
    assert.ok(modules.filter(module => module.id !== 'task').every(module => module.supportsInitialization === false));
    f.catalog.uninstall('task');
    assert.equal((await manager.list()).find(module => module.id === 'task')?.supportsInitialization, false);
    assert.equal(f.calls().length, 0);
  }
});

test('absent capability, malformed request, existing configuration and nonempty data never invoke a setup hook', async t => {
  for (const scenario of ['capability', 'confirm', 'gateway', 'gateway-size', 'digest', 'config', 'values', 'data', 'data-mode', 'symlink']) {
    await t.test(scenario, async inner => {
      const f = fixture(inner, 'success', scenario !== 'capability');
      let input = f.input;
      if (scenario === 'confirm') input = { ...input, confirm: false } as unknown as ModuleInitializationRequest;
      if (scenario === 'gateway') input = { ...input, gatewayUrl: 'https://example.test/not-an-origin' };
      if (scenario === 'gateway-size') input = { ...input, gatewayUrl: `https://${'a'.repeat(2049)}.example` };
      if (scenario === 'digest') input = { ...input, digest: '0'.repeat(64) };
      if (scenario === 'config') f.catalog.updateConfig('task', { ownership: 'external' }, 0);
      if (scenario === 'values') {
        writeFileSync(f.catalog.moduleConfigPath('task'), JSON.stringify({ schemaVersion: 1, moduleId: 'task',
          revision: 0, configVersion: 1, values: { ownership: 'external' } }), { mode: 0o600 });
      }
      if (scenario === 'data') writeFileSync(join(f.data, 'existing-business'), 'retain me');
      if (scenario === 'data-mode') chmodSync(f.data, 0o500);
      if (scenario === 'symlink') {
        const other = join(f.root, 'other-data'); mkdirSync(other, { mode: 0o700 });
        rmSync(f.data, { recursive: true }); symlinkSync(other, f.data);
      }
      await assert.rejects(f.initializer.start(input));
      assert.equal(f.calls().length, 0);
      assert.equal(f.initializer.get(f.input.operationId), null);
      assert.equal(existsSync(f.receiptFile), false);
    });
  }
});

test('readback validates receipt references without treating historical success as live credential state', async t => {
  const f = fixture(t);
  const operation = await f.initializer.start(f.input);
  assert.equal(operation.phase, 'succeeded', operation.reason);
  const before = readFileSync(f.receiptFile, 'utf8');
  for (const values of [
    { managerCredentialFile: join(f.root, 'outside.json') },
    { serviceUrl: 'http://127.0.0.1:12345' },
    { gatewayUrl: 'https://changed.example' },
    { activationEnabled: false },
  ]) {
    const receipt = JSON.parse(before) as { operation: typeof operation };
    assert.ok(receipt.operation.config);
    Object.assign(receipt.operation.config.values, values);
    writeFileSync(f.receiptFile, JSON.stringify(receipt));
    assert.throws(() => f.initializer.get(f.input.operationId), /Invalid initialization config receipt/);
    await assert.rejects(f.initializer.start(f.input), /Invalid initialization config receipt/);
  }
  writeFileSync(f.receiptFile, before);
  rmSync(join(f.data, 'module-manager.json'));
  assert.deepEqual(f.initializer.get(f.input.operationId), operation, 'success is a historical config-write receipt, not current readiness');
  assert.deepEqual(await f.initializer.start(f.input), operation, 'missing credentials never cause a new setup invocation');
  assert.equal(f.calls().length, 1);
});

test('invalid CLI responses and unsafe credential references retain unknown outcomes without config writes or reexecution', async t => {
  for (const mode of ['exit', 'malformed', 'wrong-operation', 'wrong-data', 'outside', 'extra-field', 'public', 'symlink', 'duplicate-value']) {
    await t.test(mode, async inner => {
      const f = fixture(inner, mode);
      const operation = await f.initializer.start(f.input);
      assert.equal(operation.phase, 'unknown');
      assert.equal(operation.config, undefined);
      assert.equal(f.catalog.readConfig('task').revision, 0);
      assert.equal(f.calls().length, 1);
      assert.equal(JSON.stringify(operation).includes('private'), false);
      const reopened = new ModuleInitialization(f.catalog);
      assert.deepEqual(await reopened.start(f.input), operation);
      await assert.rejects(reopened.start({ ...f.input, operationId: 'replacement-operation' }), /original operation/);
      assert.equal(f.calls().length, 1);
      assert.ok(readdirSync(f.data).length > 0, 'partial CLI artifacts are retained');
    });
  }
});

test('config CAS conflict preserves CLI credentials, user edits and an unknown non-replayable operation', async t => {
  const f = fixture(t, 'held');
  const starting = f.initializer.start(f.input);
  await waitFor(() => f.calls().length === 1);
  const user = f.catalog.updateConfig('task', { ownership: 'external', serviceUrl: 'http://127.0.0.1:18999' }, 0);
  writeFileSync(join(f.data, 'release'), 'release synthetic child');
  const operation = await starting;
  assert.equal(operation.phase, 'unknown');
  assert.deepEqual(f.catalog.readConfig('task'), user);
  assert.ok(existsSync(join(f.data, 'module-manager.json')));
  assert.ok(existsSync(join(f.data, 'credentials/module-viewer.json')));
  assert.deepEqual(await f.initializer.start(f.input), operation);
  assert.equal(f.calls().length, 1);
});

test('a child surviving output rejection remains Manager lifecycle work until actual close, without late config commit', async t => {
  const f = fixture(t, 'overflow-held');
  const manager = new ModuleManager({ userRoot: f.userRoot, runtime: new OfficialRuntime() });
  let notifications = 0;
  const off = manager.onSettled(() => { notifications++; });
  t.after(off);
  const operation = await manager.initializeConfig(f.input);
  assert.equal(operation.phase, 'unknown');
  assert.equal(manager.activeCount(), 1);
  assert.equal(f.initializer.activeCount(), 1, 'same-root instances observe the same live child');
  assert.deepEqual(manager.configInitialization(f.input.operationId), operation);
  const other = new ModuleInitialization(new ModuleCatalog({ userRoot: join(f.root, 'other') }));
  assert.equal(other.activeCount(), 0);
  const before = notifications;
  writeFileSync(join(f.data, 'release'), 'release synthetic child');
  await waitFor(() => manager.activeCount() === 0);
  assert.ok(notifications > before);
  assert.equal(f.catalog.readConfig('task').revision, 0, 'late close never resumes configuration commit');
  assert.equal(f.initializer.get(f.input.operationId)?.phase, 'unknown');
});

test('initializer timeout does not kill its child, clear busy early or retry', async t => {
  const f = fixture(t, 'held');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = f.initializer.start(f.input);
  await waitFor(() => f.calls().length === 1);
  t.mock.timers.tick(30_000);
  const operation = await starting;
  assert.equal(operation.reason, 'MODULE_INITIALIZATION_TIMEOUT_UNCONFIRMED');
  assert.equal(f.initializer.activeCount(), 1);
  assert.deepEqual(await f.initializer.start(f.input), operation);
  assert.equal(f.calls().length, 1);
  writeFileSync(join(f.data, 'release'), 'release synthetic child');
  await waitFor(() => f.initializer.activeCount() === 0);
  assert.equal(f.catalog.readConfig('task').revision, 0);
});

test('durable claim prevents a second process from executing and interruption before CLI remains unknown', async t => {
  const f = fixture(t, 'held');
  const first = driver(f.userRoot, f.input);
  try {
    await waitFor(() => f.calls().length === 1);
    const duplicate = await driver(f.userRoot, f.input);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).phase, 'unknown', 'a different process cannot assert the original executor is active');
    assert.equal(f.calls().length, 1);
  } finally {
    writeFileSync(join(f.data, 'release'), 'release synthetic child');
    const complete = await first;
    assert.equal(complete.code, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).phase, 'succeeded');
  }
  const interrupted = fixture(t);
  const crashed = await driver(interrupted.userRoot, interrupted.input, 'crash-before-hook');
  assert.equal(crashed.code, 17);
  const before = readFileSync(interrupted.receiptFile, 'utf8');
  assert.equal(interrupted.initializer.get(interrupted.input.operationId)?.phase, 'unknown');
  assert.equal((await interrupted.initializer.start(interrupted.input)).phase, 'unknown');
  assert.equal(readFileSync(interrupted.receiptFile, 'utf8'), before);
  assert.equal(interrupted.calls().length, 0);
});

test('stale claim locks are not stolen and release tampering after claim fails before CLI', async t => {
  const f = fixture(t);
  mkdirSync(join(f.userRoot, 'module-config-initializations'), { mode: 0o700 });
  writeFileSync(`${f.receiptFile}.lock`, '', { mode: 0o600 });
  await assert.rejects(f.initializer.start(f.input), /locked/);
  assert.equal(f.calls().length, 0);
  assert.equal(f.initializer.get(f.input.operationId), null);
  const g = fixture(t);
  const get = g.catalog.getInstalled.bind(g.catalog);
  let calls = 0;
  t.mock.method(g.catalog, 'getInstalled', (id, version) => {
    if (++calls === 2) writeFileSync(join(g.installed.release, 'setup.mjs'), 'throw new Error("tampered");');
    return get(id, version);
  });
  const operation = await g.initializer.start(g.input);
  assert.equal(operation.phase, 'failed');
  assert.equal(g.calls().length, 0);
});
