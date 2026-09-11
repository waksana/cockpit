import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { ModuleCatalog, type ModuleId, type ModuleManifest, type ModuleSelection } from './catalog.ts';
import { ModuleSessionRemoval } from './session-removal.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(process.cwd(), '.removal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userRoot = join(root, 'u');
  const sources = { assistant: join(root, 'assistant'), task: join(root, 'task'), wechat: join(root, 'wechat') };
  for (const path of Object.values(sources)) mkdirSync(path, { mode: 0o700 });
  const catalog = new ModuleCatalog({ userRoot, trustedSources: Object.values(sources) });
  const removal = new ModuleSessionRemoval(catalog);
  function install(id: ModuleId, version = '1.0.0', hook = true) {
    const manifest: ModuleManifest = { schemaVersion: 1, id, version, name: `${id} module`, description: 'Offline test module',
      compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
      roles: [{ id: 'role', name: 'Role', description: 'Role' }],
      ...(hook ? { sessionLifecycle: { unbind: { entry: 'unbind.mjs', args: ['--module', id, '--version', version] } } } : {}) };
    writeFileSync(join(sources[id], 'module.json'), JSON.stringify(manifest));
    writeFileSync(join(sources[id], 'unbind.mjs'), readFileSync(new URL('./session-removal-hook.fixture.mjs', import.meta.url)));
    const installed = catalog.installFromDirectory(sources[id]);
    if (hook && !existsSync(join(root, `${id}.config.json`))) {
      const configFile = join(root, `${id}.config.json`);
      writeFileSync(configFile, JSON.stringify({ stateFile: join(root, `${id}.state.json`), controlFile: join(root, `${id}.control.json`),
        callsFile: join(root, `${id}.calls.jsonl`), parentLock: join(userRoot, 'session-deletions', 'session-1.lock') }), { mode: 0o600 });
      writeFileSync(join(root, `${id}.state.json`), JSON.stringify({ boundSessionId: 'session-1', operations: {}, mutations: 0 }), { mode: 0o600 });
      writeFileSync(join(root, `${id}.control.json`), '{}', { mode: 0o600 });
      catalog.updateConfig(id, { configFile }, 0);
    }
    return installed;
  }
  function select(selections: ModuleSelection[], pendingSelections?: ModuleSelection[]) {
    return catalog.writeSession({ sessionId: 'session-1', selections, ...(pendingSelections ? { pendingSelections } : {}),
      phase: pendingSelections ? 'unknown' : 'applied', operationId: 'binding-operation' });
  }
  const choice = (moduleId: ModuleId, version = '1.0.0'): ModuleSelection => ({ moduleId, roleId: 'role', version });
  const control = (id: ModuleId, values: object) => writeFileSync(join(root, `${id}.control.json`), JSON.stringify(values), { mode: 0o600 });
  const calls = (id: ModuleId): Array<{ request: { operation: string; operationId: string; sessionId: string }; argv: string[]; env: Record<string, string> }> =>
    existsSync(join(root, `${id}.calls.jsonl`)) ? readFileSync(join(root, `${id}.calls.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const state = (id: ModuleId) => JSON.parse(readFileSync(join(root, `${id}.state.json`), 'utf8'));
  const receiptFile = join(userRoot, 'session-deletions', 'session-1.json');
  return { root, userRoot, catalog, removal, install, select, choice, control, calls, state, receiptFile };
}
async function waitForCall(calls: () => unknown[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (calls().length) return; await sleep(10); }
  throw new Error('Fixture hook did not start');
}

test('no session or no declared capability is passive and never probes config/services/hooks', async t => {
  const f = fixture(t);
  const empty = await f.removal.plan('session-1');
  assert.deepEqual(empty.modules, []);
  await f.removal.unbind('session-1');
  await f.removal.removed('session-1');
  f.removal.assertReady('session-1');
  assert.equal(existsSync(f.userRoot), false);
  f.install('assistant', '1.0.0', false);
  f.install('wechat');
  f.select([f.choice('assistant')]);
  f.catalog.readConfig = () => { throw new Error('Must never read undeclared module configuration'); };
  assert.deepEqual((await f.removal.plan('session-1')).modules, []);
  await f.removal.unbind('session-1');
  await f.removal.removed('session-1');
  assert.equal(existsSync(join(f.userRoot, 'session-deletions')), false);
  assert.deepEqual(f.calls('assistant'), []);
  assert.deepEqual(f.calls('wechat'), [], 'globally installed capabilities are not session selections');
});

test('declared plan is passive; explicit approval unbinds only then records native deletion', async t => {
  const f = fixture(t);
  f.install('wechat');
  f.select([f.choice('wechat')]);
  const plan = await f.removal.plan('session-1');
  assert.deepEqual(plan.modules, [{ moduleId: 'wechat', name: 'wechat module', version: '1.0.0' }]);
  assert.match(plan.planId, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls('wechat'), []);
  assert.equal(existsSync(f.receiptFile), false);
  await assert.rejects(f.removal.unbind('session-1'), /APPROVAL_REQUIRED/);
  await f.removal.unbind('session-1', { planId: plan.planId, operationId: 'delete-operation-1' });
  const after = await f.removal.plan('session-1');
  assert.equal(after.state, 'unbound');
  assert.deepEqual(after.completedModules, ['wechat']);
  assert.equal(f.state('wechat').boundSessionId, null);
  assert.throws(() => f.removal.assertReady('session-1'), /DELETION_INCOMPLETE/);
  assert.ok(f.catalog.getSession('session-1'), 'only the parent removes catalog/native session records');
  await f.removal.removed('session-1');
  await f.removal.removed('session-1');
  assert.equal((await f.removal.plan('session-1')).state, 'deleted');
  f.removal.assertReady('session-1');
  assert.equal(statSync(f.receiptFile).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f.receiptFile)).mode & 0o777, 0o700);
});

test('hook stdin is exact, operation ID derived and credentials are not inherited', async t => {
  const f = fixture(t);
  f.install('wechat');
  f.select([f.choice('wechat')]);
  const plan = await f.removal.plan('session-1');
  const previous = process.env.COCKPIT_API_TOKEN;
  process.env.COCKPIT_API_TOKEN = 'not-authorized-for-this-hook';
  try {
    await f.removal.unbind('session-1', { planId: plan.planId, operationId: 'parent-delete-operation' });
  } finally {
    if (previous === undefined) delete process.env.COCKPIT_API_TOKEN; else process.env.COCKPIT_API_TOKEN = previous;
  }
  const call = f.calls('wechat')[0]!;
  assert.deepEqual(Object.keys(call.request).sort(), ['operation', 'operationId', 'sessionId']);
  assert.equal(call.request.operation, 'session-unbind');
  assert.equal(call.request.sessionId, 'session-1');
  assert.match(call.request.operationId, /^unbind-[a-f0-9]{64}$/);
  assert.notEqual(call.request.operationId, 'parent-delete-operation');
  assert.deepEqual(call.argv, ['--module', 'wechat', '--version', '1.0.0', '--config', join(f.root, 'wechat.config.json')]);
  assert.equal(call.env.COCKPIT_API_TOKEN, undefined);
  assert.equal(call.env.SERVICE_DELIVERY_SHA, undefined);
  assert.equal(call.env.WORK_MODULE_MANAGER_CREDENTIAL, undefined);
});

test('pending-only partial bind is included; applied hook takes precedence over pending hook', async t => {
  const f = fixture(t);
  f.install('wechat', '1.0.0');
  f.install('wechat', '2.0.0');
  f.select([], [f.choice('wechat', '2.0.0')]);
  let plan = await f.removal.plan('session-1');
  assert.equal(plan.modules[0]?.version, '2.0.0');
  const current = f.catalog.getSession('session-1')!;
  f.catalog.writeSession({ ...current, phase: 'applied', selections: [f.choice('wechat')], pendingSelections: undefined });
  const applied = f.catalog.getSession('session-1')!;
  f.catalog.writeSession({ ...applied, phase: 'unknown', pendingSelections: [f.choice('wechat', '2.0.0')] });
  plan = await f.removal.plan('session-1');
  assert.equal(plan.modules.length, 1);
  assert.equal(plan.modules[0]?.version, '1.0.0');
  await f.removal.unbind('session-1', { planId: plan.planId, operationId: 'applied-preferred' });
  assert.equal(f.calls('wechat').length, 1);
  assert.equal(f.calls('wechat')[0]?.argv[3], '1.0.0');
});

test('pending hook is selected when the applied release declares no hook', async t => {
  const f = fixture(t);
  f.install('wechat', '1.0.0', false);
  f.install('wechat', '2.0.0');
  f.select([f.choice('wechat')]);
  const current = f.catalog.getSession('session-1')!;
  f.catalog.writeSession({ ...current, phase: 'unknown', pendingSelections: [f.choice('wechat', '2.0.0')] });
  const plan = await f.removal.plan('session-1');
  assert.equal(plan.modules[0]?.version, '2.0.0');
  await f.removal.unbind('session-1', { planId: plan.planId, operationId: 'pending-hook-selected' });
  assert.equal(f.calls('wechat').length, 1);
});

test('hook refuses another bound session without clearing it or exposing stderr', async t => {
  const f = fixture(t);
  f.install('wechat');
  f.select([f.choice('wechat')]);
  writeFileSync(join(f.root, 'wechat.state.json'), JSON.stringify({ boundSessionId: 'session-other', operations: {}, mutations: 0 }));
  const plan = await f.removal.plan('session-1');
  await assert.rejects(f.removal.unbind('session-1', { planId: plan.planId, operationId: 'other-session-delete' }), /MODULE_UNBIND_FAILED: SESSION_MISMATCH/);
  assert.equal(f.state('wechat').boundSessionId, 'session-other');
  assert.equal((await f.removal.plan('session-1')).state, 'failed');
  await assert.rejects(f.removal.removed('session-1'), /UNBIND_REQUIRED/);
});

test('known failure and unconfirmed transport/malformed/mismatched outcomes never pretend success', async t => {
  for (const [mode, expected] of [['fail', 'failed'], ['malformed', 'unknown'], ['mismatch', 'unknown'],
    ['wrong-operation', 'unknown'], ['wrong-exit', 'unknown'], ['overflow', 'unknown'], ['bad-error', 'unknown'],
    ['unknown-receipt', 'unknown'], ['failure-receipt', 'failed'], ['failure-wrong-session', 'unknown']] as const) {
    await t.test(mode, async inner => {
      const f = fixture(inner);
      f.install('wechat');
      f.select([f.choice('wechat')]);
      f.control('wechat', { mode });
      const plan = await f.removal.plan('session-1');
      await assert.rejects(f.removal.unbind('session-1', { planId: plan.planId, operationId: 'failed-delete-operation' }), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('private-credential'), false);
        return true;
      });
      const result = await f.removal.plan('session-1');
      assert.equal(result.state, expected);
      assert.deepEqual(result.completedModules, []);
      assert.equal(JSON.stringify(result).includes('private-credential'), false);
      assert.throws(() => f.removal.assertReady('session-1'), /INCOMPLETE/);
    });
  }
});

test('an unconfirmed hook keeps lifecycle busy until its actual child exits', async t => {
  const f = fixture(t);
  f.install('wechat'); f.select([f.choice('wechat')]);
  f.control('wechat', { mode: 'overflow-held', holdAfterOutput: true });
  const approval = { planId: (await f.removal.plan('session-1')).planId, operationId: 'live-unconfirmed-child' };
  let settled = 0;
  const unsubscribe = f.removal.onSettled(() => { settled++; });
  try {
    await assert.rejects(f.removal.unbind('session-1', approval), /OUTPUT_UNCONFIRMED/);
    assert.equal(f.removal.activeCount(), 1, 'request failure does not imply the control child stopped');
    await assert.rejects(f.removal.unbind('session-1', approval), /ALREADY_WORKING/);
  } finally {
    f.control('wechat', {});
    for (let attempt = 0; attempt < 100 && f.removal.activeCount(); attempt++) await sleep(20);
    unsubscribe();
  }
  assert.equal(f.removal.activeCount(), 0);
  assert.ok(settled >= 2, 'host receives both request settlement and later actual child settlement');
});

test('same-ID explicit continuation skips completed modules after partial failure and disk reopen', async t => {
  const f = fixture(t);
  f.install('task'); f.install('wechat');
  f.select([f.choice('task'), f.choice('wechat')]);
  f.control('wechat', { mode: 'fail' });
  const plan = await f.removal.plan('session-1');
  const approval = { planId: plan.planId, operationId: 'partial-unbind-operation' };
  await assert.rejects(f.removal.unbind('session-1', approval), /MODULE_BUSY/);
  assert.deepEqual((await f.removal.plan('session-1')).completedModules, ['task']);
  f.control('wechat', {});
  const reopened = new ModuleSessionRemoval(new ModuleCatalog({ userRoot: f.userRoot }));
  await assert.rejects(reopened.unbind('session-1', { ...approval, operationId: 'replacement-operation' }), /OPERATION_CONFLICT/);
  await reopened.unbind('session-1', approval);
  assert.equal((await reopened.plan('session-1')).state, 'unbound');
  assert.equal(f.calls('task').length, 1);
  assert.equal(f.calls('wechat').length, 2);
  assert.equal(f.calls('wechat')[0]?.request.operationId, f.calls('wechat')[1]?.request.operationId);
});

test('unknown after actual unbind explicitly reuses the stable hook operation, never another mutation', async t => {
  const f = fixture(t);
  f.install('wechat'); f.select([f.choice('wechat')]);
  f.control('wechat', { mode: 'mutate-then-malformed' });
  const approval = { planId: (await f.removal.plan('session-1')).planId, operationId: 'unknown-effect-operation' };
  await assert.rejects(f.removal.unbind('session-1', approval), /RESPONSE_UNCONFIRMED/);
  assert.equal(f.state('wechat').mutations, 1);
  f.control('wechat', {});
  await new ModuleSessionRemoval(f.catalog).unbind('session-1', approval);
  assert.equal(f.state('wechat').mutations, 1);
  assert.equal(f.calls('wechat').length, 2);
  assert.equal(f.calls('wechat')[0]?.request.operationId, f.calls('wechat')[1]?.request.operationId);
});

test('native deletion failure can retry without repeating any completed hook; receipts remain after deletion', async t => {
  const f = fixture(t);
  f.install('wechat'); f.select([f.choice('wechat')]);
  const approval = { planId: (await f.removal.plan('session-1')).planId, operationId: 'native-failure-operation' };
  await f.removal.unbind('session-1', approval);
  // The native API failure is owned by the parent and deliberately does not call removed().
  const reopened = new ModuleSessionRemoval(f.catalog);
  await reopened.unbind('session-1', approval);
  assert.equal(f.calls('wechat').length, 1);
  await reopened.removed('session-1');
  const binding = f.catalog.getSession('session-1')!;
  f.catalog.removeBinding('session-1', binding.revision);
  await reopened.unbind('session-1', approval);
  assert.equal((await reopened.plan('session-1')).state, 'deleted');
  assert.equal(f.calls('wechat').length, 1);
  assert.ok(existsSync(f.receiptFile));
  assert.equal(f.state('wechat').mutations, 1);
});

test('capability version or config revision changes invalidate confirmation before any hook', async t => {
  const f = fixture(t);
  f.install('wechat');
  f.select([f.choice('wechat')]);
  const old = await f.removal.plan('session-1');
  f.catalog.updateConfig('wechat', { ownership: 'external' }, 1);
  await assert.rejects(f.removal.unbind('session-1', { planId: old.planId, operationId: 'changed-config-operation' }), /PLAN_CHANGED/);
  assert.deepEqual(f.calls('wechat'), []);
  const plan = await f.removal.plan('session-1');
  f.install('wechat', '2.0.0');
  const current = f.catalog.getSession('session-1')!;
  f.catalog.writeSession({ ...current, selections: [f.choice('wechat', '2.0.0')] });
  await assert.rejects(f.removal.unbind('session-1', { planId: plan.planId, operationId: 'changed-version-operation' }), /PLAN_CHANGED/);
  assert.deepEqual(f.calls('wechat'), []);
});

test('tampered installed code is rejected at the execution boundary', async t => {
  const f = fixture(t);
  const installed = f.install('wechat'); f.select([f.choice('wechat')]);
  const plan = await f.removal.plan('session-1');
  writeFileSync(join(installed.release, 'unbind.mjs'), 'throw new Error("modified");');
  await assert.rejects(f.removal.unbind('session-1', { planId: plan.planId, operationId: 'tampered-hook-operation' }), /integrity/);
  assert.deepEqual(f.calls('wechat'), []);
});

test('interrupted working is read as unknown without passive writes; same ID explicitly completes remaining work', async t => {
  const f = fixture(t);
  f.install('task'); f.install('wechat'); f.select([f.choice('task'), f.choice('wechat')]);
  f.control('wechat', { mode: 'fail' });
  const approval = { planId: (await f.removal.plan('session-1')).planId, operationId: 'interrupted-operation' };
  await assert.rejects(f.removal.unbind('session-1', approval), /MODULE_BUSY/);
  const saved = JSON.parse(readFileSync(f.receiptFile, 'utf8'));
  saved.state = 'working'; saved.attemptId = 'crashed-attempt'; saved.executorPid = process.pid;
  delete saved.error;
  writeFileSync(f.receiptFile, JSON.stringify(saved), { mode: 0o600 });
  const before = readFileSync(f.receiptFile, 'utf8');
  const reopened = new ModuleSessionRemoval(f.catalog);
  assert.equal((await reopened.plan('session-1')).state, 'unknown');
  assert.equal(readFileSync(f.receiptFile, 'utf8'), before);
  f.control('wechat', {});
  await reopened.unbind('session-1', approval);
  assert.equal(f.calls('task').length, 1);
  assert.equal((await reopened.plan('session-1')).state, 'unbound');
});

test('session mutations serialize across instances while short disk locks are released during the hook', async t => {
  const f = fixture(t);
  f.install('wechat'); f.select([f.choice('wechat')]);
  f.control('wechat', { hold: true, mode: 'inspect-lock' });
  const approval = { planId: (await f.removal.plan('session-1')).planId, operationId: 'concurrent-operation' };
  const first = f.removal.unbind('session-1', approval);
  try {
    await waitForCall(() => f.calls('wechat'));
    assert.equal(existsSync(join(f.userRoot, 'session-deletions', 'session-1.lock')), false);
    assert.equal((await f.removal.plan('session-1')).state, 'working');
    await assert.rejects(new ModuleSessionRemoval(f.catalog).unbind('session-1', approval), /ALREADY_WORKING/);
  } finally {
    f.control('wechat', { mode: 'inspect-lock' });
    await first;
  }
  assert.equal(f.calls('wechat').length, 1);
});

test('stale short mutation locks are never automatically stolen', async t => {
  const f = fixture(t);
  f.install('wechat'); f.select([f.choice('wechat')]);
  const plan = await f.removal.plan('session-1');
  const directory = join(f.userRoot, 'session-deletions');
  mkdirSync(directory, { mode: 0o700 });
  const lock = join(directory, 'session-1.lock');
  writeFileSync(lock, '{"pid":99999999}', { mode: 0o600 });
  await assert.rejects(f.removal.unbind('session-1', { planId: plan.planId, operationId: 'stale-lock-operation' }), /LOCKED/);
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":99999999}');
  assert.deepEqual(f.calls('wechat'), []);
  assert.equal(readdirSync(directory).length, 1);
});

test('a second process cannot concurrently continue the same live unbind operation', async t => {
  const f = fixture(t);
  f.install('wechat'); f.select([f.choice('wechat')]);
  f.control('wechat', { hold: true });
  const approval = { planId: (await f.removal.plan('session-1')).planId, operationId: 'cross-process-unbind' };
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./session-removal-driver.fixture.mjs', import.meta.url).pathname,
    f.userRoot, approval.planId, approval.operationId], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value.toString(); });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    await waitForCall(() => f.calls('wechat'));
    assert.equal((await f.removal.plan('session-1')).state, 'working');
    await assert.rejects(f.removal.unbind('session-1', approval), /ALREADY_WORKING/);
    assert.equal(f.calls('wechat').length, 1);
  } finally {
    f.control('wechat', {});
    assert.equal(await done, 0, stderr);
  }
  assert.equal((await f.removal.plan('session-1')).state, 'unbound');
  await f.removal.unbind('session-1', approval);
  assert.equal(f.calls('wechat').length, 1);
});
