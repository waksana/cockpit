import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { OfficialRuntime } from '../runtime.ts';
import { ModuleManager } from './manager.ts';
import type { ModuleManifest } from './catalog.ts';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Manual unbind fixture did not settle');
    await setTimeout(10);
  }
}
function fixture(t: TestContext, capability = true) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-manual-unbind-'));
  const sources = { wechat: join(root, 'wechat'), task: join(root, 'task') };
  const runtime = new OfficialRuntime();
  let nativeReads = 0;
  t.mock.method(runtime, 'getSessionMetadata', async () => { nativeReads++; throw new Error('Native session no longer exists'); });
  const manager = new ModuleManager({ runtime, userRoot: join(root, 'user'), sources,
    sessionDirectory: async () => { nativeReads++; throw new Error('Native session directory no longer exists'); } });
  t.after(async () => {
    if (manager.activeCount()) {
      writeFileSync(join(root, 'state.json.release'), 'release fixture');
      await waitFor(() => manager.activeCount() === 0);
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['wechat', 'task'] as const) {
    mkdirSync(join(sources[id], 'hooks'), { recursive: true, mode: 0o700 });
    const manifest: ModuleManifest = { schemaVersion: 1, id, version: '1.0.0', name: id, description: 'Offline module fixture',
      compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
      roles: [{ id: 'role', name: 'Role', description: 'Role' }],
      ...((capability || id === 'task') ? { sessionLifecycle: { unbind: { entry: 'hooks/unbind.mjs', args: ['--fixture', id] } } } : {}) };
    writeFileSync(join(sources[id], 'module.json'), JSON.stringify(manifest));
    if (id === 'wechat') copyFileSync(new URL('./manager-unbind.fixture.mjs', import.meta.url), join(sources[id], 'hooks/unbind.mjs'));
    else writeFileSync(join(sources[id], 'hooks/unbind.mjs'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, 'task-hook-ran'))}, 'unexpected'); throw new Error('Task hook must not run');`);
    manager.catalog.installFromDirectory(sources[id]);
  }
  const stateFile = join(root, 'state.json'), configFile = join(root, 'wechat.json');
  writeFileSync(configFile, JSON.stringify({ stateFile }), { mode: 0o600 });
  writeFileSync(stateFile, JSON.stringify({ boundSessionId: 'missing-native-session', savedCwd: '/module-owned/old-project',
    mutations: 0, operations: {}, calls: [] }), { mode: 0o600 });
  manager.catalog.updateConfig('wechat', { configFile }, 0);
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return { root, manager, state, stateFile, configFile, nativeReads: () => nativeReads,
    mode(mode: string) { writeFileSync(configFile, JSON.stringify({ stateFile, mode }), { mode: 0o600 }); } };
}

test('manual WeChat unbind uses only its declared capability after native deletion, without another module hook', async t => {
  const f = fixture(t);
  f.manager.catalog.writeSession({ sessionId: 'missing-native-session', phase: 'applied', operationId: 'legacy-initialization',
    selections: [{ moduleId: 'task', roleId: 'role', version: '1.0.0' }, { moduleId: 'wechat', roleId: 'role', version: '1.0.0' }] });
  await f.manager.unbind('missing-native-session', 'manual-unbind-operation');
  const state = f.state();
  assert.equal(state.boundSessionId, null);
  assert.equal(state.savedCwd, '/module-owned/old-project');
  assert.equal(state.mutations, 1);
  assert.deepEqual(state.calls, [{
    request: { operation: 'session-unbind', sessionId: 'missing-native-session', operationId: 'manual-unbind-operation' },
    argv: ['--fixture', 'wechat', '--config', f.configFile],
  }]);
  assert.equal(f.nativeReads(), 0);
  assert.equal(existsSync(join(f.root, 'task-hook-ran')), false);
  assert.deepEqual(f.manager.catalog.getSession('missing-native-session')?.selections,
    [{ moduleId: 'task', roleId: 'role', version: '1.0.0' }]);
  assert.deepEqual(f.manager.unbindOperation('manual-unbind-operation'),
    { operationId: 'manual-unbind-operation', sessionId: 'missing-native-session', state: 'succeeded' });
});

test('manual unbind permits missing catalog session and incomplete initial session without resolving native cwd', async t => {
  for (const partial of [false, true]) await t.test(partial ? 'partial initialization' : 'no catalog record', async inner => {
    const f = fixture(inner);
    if (partial) {
      f.manager.catalog.prepareBinding('missing-native-session', [{ moduleId: 'wechat', roleId: 'role', version: '1.0.0' }], 'initial-operation');
      const record = f.manager.catalog.getSession('missing-native-session')!;
      f.manager.catalog.writeSession({ ...record, phase: 'unknown', error: 'Native initialization was interrupted' });
    }
    const before = f.manager.catalog.getSession('missing-native-session');
    await f.manager.unbind('missing-native-session', 'manual-unbind-operation');
    assert.equal(f.state().boundSessionId, null);
    assert.equal(f.nativeReads(), 0);
    assert.deepEqual(f.manager.catalog.getSession('missing-native-session'), before, 'manual unbind does not claim native initialization recovered');
    assert.equal(f.state().calls.length, 1, 'no automatic resend');
    await f.manager.unbind('missing-native-session', 'manual-unbind-operation');
    assert.equal(f.state().mutations, 1);
    assert.equal(f.state().calls.length, 1, 'explicit same-ID repeat reads only the host receipt');
  });
});

test('manual unbind of an absent old target leaves a different current module binding untouched', async t => {
  const f = fixture(t);
  writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), boundSessionId: 'newer-session' }), { mode: 0o600 });
  await f.manager.unbind('missing-native-session', 'manual-unbind-operation');
  assert.equal(f.state().boundSessionId, 'newer-session');
  assert.equal(f.state().mutations, 0);
  assert.equal(f.state().calls.length, 1);
  assert.equal(f.nativeReads(), 0);
});

test('manual unbind without a declared capability or with tampered release refuses without native fallback', async t => {
  const unsupported = fixture(t, false);
  await assert.rejects(unsupported.manager.unbind('missing-native-session', 'manual-unbind-operation'), /does not declare.*unsupported/);
  assert.equal(unsupported.state().calls.length, 0);
  assert.equal(unsupported.nativeReads(), 0);
  const tampered = fixture(t);
  const installed = tampered.manager.catalog.getInstalled('wechat')!;
  writeFileSync(join(installed.release, 'hooks/unbind.mjs'), 'throw new Error("tampered");');
  await assert.rejects(tampered.manager.unbind('missing-native-session', 'manual-unbind-operation'), /integrity/);
  assert.equal(tampered.state().calls.length, 0);
  assert.equal(tampered.nativeReads(), 0);
});

test('manual unbind failures validate identity and unbound acknowledgement without retry or local success', async t => {
  for (const mode of ['unknown', 'known-failure', 'wrong-failure-session', 'wrong-operation', 'wrong-session', 'not-unbound', 'missing-replayed', 'malformed']) {
    await t.test(mode, async inner => {
      const f = fixture(inner);
      f.manager.catalog.writeSession({ sessionId: 'missing-native-session', phase: 'applied', operationId: 'legacy-initialization',
        selections: [{ moduleId: 'wechat', roleId: 'role', version: '1.0.0' }] });
      const before = f.manager.catalog.getSession('missing-native-session');
      f.mode(mode);
      await assert.rejects(f.manager.unbind('missing-native-session', 'manual-unbind-operation'), error =>
        error instanceof Error && !error.message.includes('private-fixture')
        && 'moduleOutcomeUnknown' in error && error.moduleOutcomeUnknown === (mode !== 'known-failure'));
      assert.deepEqual(f.manager.catalog.getSession('missing-native-session'), before);
      assert.equal(f.state().calls.length, 1);
      assert.equal(f.nativeReads(), 0);
      const operation = f.manager.unbindOperation('manual-unbind-operation');
      assert.equal(operation?.state, mode === 'known-failure' ? 'failed' : 'unknown');
      await assert.rejects(f.manager.unbind('missing-native-session', 'manual-unbind-operation'));
      assert.equal(f.state().calls.length, 1);
      assert.deepEqual(f.manager.unbindOperation('manual-unbind-operation'), operation);
    });
  }
});

test('manual unbind readback is passive across active executors, restart and unavailable native/module state', async t => {
  const f = fixture(t);
  const operationId = 'manual-unbind-operation', sessionId = 'missing-native-session';
  assert.equal(f.manager.unbindOperation(operationId), null);
  const directory = join(f.manager.catalog.dataDirectory('wechat'), 'session-unbind');
  assert.equal(existsSync(directory), false, 'a passive miss creates no files');
  f.mode('held');
  const starting = f.manager.unbind(sessionId, operationId);
  await waitFor(() => existsSync(`${f.stateFile}.ready`));
  const file = join(directory, `${operationId}.json`), before = readFileSync(file, 'utf8');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(f.manager.unbindOperation(operationId)?.state, 'working');
  assert.equal(f.manager.activeCount(), 1);
  await assert.rejects(f.manager.unbind(sessionId, operationId), /IN_PROGRESS/);
  await assert.rejects(f.manager.unbind('another-session', operationId), /different session/);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { ModuleManager } from ${JSON.stringify(new URL('./manager.ts', import.meta.url).href)};
    const manager = new ModuleManager({ userRoot: ${JSON.stringify(f.manager.catalog.userRoot)}, runtime: {} });
    console.log(JSON.stringify(manager.unbindOperation(${JSON.stringify(operationId)})));
  `]);
  assert.deepEqual(JSON.parse(stdout), { operationId, sessionId, state: 'unknown', error: 'WECHAT_UNBIND_INTERRUPTED_NO_REPLAY' });
  assert.equal(readFileSync(file, 'utf8'), before, 'interruption projection never overwrites working history');
  assert.equal(f.state().calls.length, 1);
  let settled = 0;
  const off = f.manager.onSettled(() => { settled++; });
  t.after(off);
  writeFileSync(`${f.stateFile}.release`, 'release fixture');
  await starting;
  assert.equal(f.manager.activeCount(), 0);
  assert.ok(settled > 0);
  const completed = f.manager.unbindOperation(operationId);
  const installed = f.manager.catalog.getInstalled('wechat')!;
  writeFileSync(join(installed.release, 'hooks/unbind.mjs'), 'throw new Error("must not execute");');
  rmSync(f.configFile);
  const reopened = new ModuleManager({ userRoot: f.manager.catalog.userRoot, runtime: new OfficialRuntime() });
  assert.deepEqual(reopened.unbindOperation(operationId), completed);
  await reopened.unbind(sessionId, operationId);
  assert.equal(f.state().calls.length, 1);
  assert.equal(f.nativeReads(), 0);
  await assert.rejects(reopened.unbind('another-session', operationId), /different session/);
  assert.throws(() => reopened.unbindOperation('../escape'), /Invalid/);
});

test('interrupted manual unbind claims never replay and corrupt receipts fail explicitly', async t => {
  const f = fixture(t), operationId = 'manual-unbind-operation';
  const installed = f.manager.catalog.getInstalled('wechat')!;
  const directory = join(f.manager.catalog.dataDirectory('wechat'), 'session-unbind');
  mkdirSync(directory, { mode: 0o700 });
  const file = join(directory, `${operationId}.json`);
  const receipt = { schemaVersion: 1, version: installed.manifest.version, digest: installed.digest,
    operation: { operationId, sessionId: 'missing-native-session', state: 'working' } };
  writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  const before = readFileSync(file, 'utf8');
  assert.equal(f.manager.unbindOperation(operationId)?.state, 'unknown');
  await assert.rejects(f.manager.unbind('missing-native-session', operationId), /INTERRUPTED/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(f.state().calls.length, 0);
  writeFileSync(file, JSON.stringify({ ...receipt, operation: { ...receipt.operation, operationId: 'different-operation' } }));
  assert.throws(() => f.manager.unbindOperation(operationId), /Invalid manual unbind receipt/);
  await assert.rejects(f.manager.unbind('missing-native-session', operationId), /Invalid manual unbind receipt/);
  assert.equal(f.state().calls.length, 0);
});

test('a disappeared binding does not turn failed local publication into a successful operation', async t => {
  const f = fixture(t);
  f.manager.catalog.writeSession({ sessionId: 'missing-native-session', phase: 'applied', operationId: 'legacy-initialization',
    selections: [{ moduleId: 'wechat', roleId: 'role', version: '1.0.0' }] });
  t.mock.method(f.manager.catalog, 'writeSession', () => { throw new Error('private fixture CAS conflict'); });
  await assert.rejects(f.manager.unbind('missing-native-session', 'manual-unbind-operation'), /EFFECT_UNCONFIRMED/);
  assert.equal(f.state().boundSessionId, null);
  assert.deepEqual(f.manager.unbindOperation('manual-unbind-operation'),
    { operationId: 'manual-unbind-operation', sessionId: 'missing-native-session', state: 'unknown', error: 'WECHAT_UNBIND_EFFECT_UNCONFIRMED' });
  await assert.rejects(f.manager.unbind('missing-native-session', 'manual-unbind-operation'), /EFFECT_UNCONFIRMED/);
  assert.equal(f.state().calls.length, 1);
});

test('manual unbind never steals a stale exclusive claim lock or invokes the hook without a receipt', async t => {
  const f = fixture(t), operationId = 'manual-unbind-operation';
  const directory = join(f.manager.catalog.dataDirectory('wechat'), 'session-unbind');
  mkdirSync(directory, { mode: 0o700 });
  const lock = join(directory, `${operationId}.json.lock`);
  writeFileSync(lock, 'uncertain prior writer', { mode: 0o600 });
  await assert.rejects(f.manager.unbind('missing-native-session', operationId), /locked/);
  assert.equal(f.manager.unbindOperation(operationId), null);
  assert.equal(readFileSync(lock, 'utf8'), 'uncertain prior writer');
  assert.equal(f.state().calls.length, 0);
});
