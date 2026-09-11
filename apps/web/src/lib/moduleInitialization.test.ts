import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModuleConfig, ModuleInitializationOperation, ModuleInitializationRequest, ModuleStatus } from '@cockpit/protocol';
import { createModuleInitialization, moduleInitializationReason } from './moduleInitialization';
import type { BrowserOperationLock } from './browserOperationLock';
import { createKeyedAsync } from './keyedAsync';

const digest = 'a'.repeat(64);
const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', installed: [{ version: '1.2.3', digest }],
  selectedVersion: '1.2.3', roles: [], supportsInitialization: true, service: { ownership: 'external', status: 'unknown' } };
const empty: ModuleConfig = { moduleId: 'task', configVersion: 1, revision: 0, values: {} };
const gateway = 'https://127.0.0.1:34907';
const configured: ModuleConfig = { ...empty, revision: 1, values: { ownership: 'managed', serviceUrl: 'http://127.0.0.1:34908',
  gatewayUrl: gateway, dataDirectory: '/isolated/data/task', managerCredentialFile: '/isolated/data/task/manager.json',
  viewerCredentialFile: '/isolated/data/task/viewer.json' } };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function lock(): BrowserOperationLock {
  let tail = Promise.resolve();
  return claim => {
    const next = tail.then(claim);
    tail = next.then(() => {}, () => {});
    return next;
  };
}
function result(request: ModuleInitializationRequest, phase: ModuleInitializationOperation['phase'] = 'succeeded'): ModuleInitializationOperation {
  const { confirm: _confirm, ...identity } = request;
  return { ...identity, phase, updatedAt: 1, ...(phase === 'succeeded' ? { config: configured } : {}) };
}
const noSubmit = async (): Promise<ModuleInitializationOperation> => { assert.fail('must not run initialization'); };

test('fresh initialization pins the installed identity and canonical HTTPS port with explicit confirmation', async () => {
  const saved = storage(), operation = createModuleInitialization(saved, () => 'first-initialization-operation', lock());
  let calls = 0, message = '';
  await operation.initialize(module, empty, gateway, () => false, noSubmit);
  assert.equal(saved.values.size, 0);
  await operation.initialize(module, empty, gateway, value => { message = value; return true; }, async request => {
    calls++;
    assert.equal(saved.values.size, 1, 'claim must be persisted before invoking the host');
    assert.deepEqual(request, { moduleId: 'task', operationId: 'first-initialization-operation', version: '1.2.3',
      digest, gatewayUrl: gateway, confirm: true });
    return result(request);
  });
  assert.match(message, /仅在新空 data\/task 创建私有 manager 和只读 viewer/);
  assert.match(message, /保留已有配置\/数据且拒绝接管/);
  assert.match(message, /不启动服务、不新建 caller\/session、不发消息/);
  assert.match(message, /超时或结果未知仅只读核对/);
  assert.equal(calls, 1);
  assert.equal(operation.getSnapshot().result?.phase, 'succeeded');
  assert.equal([...saved.values.values()].some(value => value.includes('CredentialFile')), false, 'store outgoing request, not generated config');
  assert.equal('newOperation' in operation, false);
  assert.equal('resume' in operation, false);
});

test('missing capability/config, existing deployment and occupied runtime cannot allocate or initialize', async () => {
  const cases: [ModuleStatus, ModuleConfig | undefined][] = [
    [{ ...module, supportsInitialization: false }, empty],
    [{ ...module, supportsInitialization: undefined }, empty],
    [{ ...module, id: 'wechat' }, empty],
    [{ ...module, id: 'assistant' }, empty],
    [{ ...module, selectedVersion: '1.2.4' }, empty],
    [{ ...module, installed: [...module.installed, ...module.installed] }, empty],
    [{ ...module, installed: [{ version: '1.2.3', digest: 'not-a-digest' }] }, empty],
    [module, undefined], [module, { ...empty, moduleId: 'wechat' }], [module, configured],
    [module, { ...empty, values: { ownership: 'external', serviceUrl: 'http://127.0.0.1:8790' } }],
    [module, { ...empty, revision: 1 }],
    [{ ...module, service: { ownership: 'external', status: 'running' } }, empty],
    [{ ...module, service: { ownership: 'managed', status: 'unknown', instanceId: 'retained-instance' } }, empty],
    [{ ...module, service: { ownership: 'managed', status: 'unknown',
      runner: { id: 'task', status: 'unknown', owned: false, recoveryRequired: true } } }, empty],
  ];
  assert.equal(moduleInitializationReason(module, empty), undefined, 'fresh defaults may be external/unknown without any config');
  for (const [target, config] of cases) {
    const operation = createModuleInitialization(storage(), () => { assert.fail('no identity before eligibility'); }, lock());
    assert.ok(moduleInitializationReason(target, config));
    await assert.rejects(operation.initialize(target, config, gateway, () => { assert.fail('no confirmation before eligibility'); }, noSubmit));
  }
});

test('invalid gateway origins cannot allocate an operation or silently normalize user input', async () => {
  for (const invalid of ['http://cockpit.test', 'https://cockpit.test/', 'https://cockpit.test/modules/task',
    'https://user:pass@cockpit.test', 'https://cockpit.test?query', 'https://cockpit.test#hash',
    'https://cockpit.test:443', ' https://cockpit.test', 'not-a-url']) {
    const operation = createModuleInitialization(storage(), () => { assert.fail('invalid origin cannot allocate'); }, lock());
    await assert.rejects(operation.initialize(module, empty, invalid, () => { assert.fail('invalid origin cannot confirm'); }, noSubmit));
  }
});

for (const phase of ['preparing', 'succeeded', 'failed', 'unknown', 'transport'] as const) {
  test(`${phase} initialization remains readable across reload, never obtaining another identity`, async () => {
    const saved = storage(), sharedLock = lock();
    const operation = createModuleInitialization(saved, () => 'retained-initialization-operation', sharedLock);
    const sending = operation.initialize(module, empty, gateway, () => true, async request => {
      if (phase === 'transport') throw new Error('response lost');
      return result(request, phase);
    });
    if (phase === 'transport') await assert.rejects(sending, /response lost/); else await sending;
    const reopened = createModuleInitialization(saved, () => { assert.fail('must keep original identity'); }, sharedLock);
    await assert.rejects(reopened.initialize(module, empty, gateway, () => true, noSubmit), /原出站操作/);
    await assert.rejects(reopened.read(async () => null), /未读到匹配原 ID/);
    await reopened.read(async request => {
      assert.equal(request.operationId, 'retained-initialization-operation');
      return result(request, phase === 'transport' ? 'unknown' : phase);
    });
    await assert.rejects(reopened.initialize(module, empty, 'https://different.test', () => true, noSubmit), /原出站操作/);
    assert.equal(reopened.getSnapshot().attempt?.request.gatewayUrl, gateway);
  });
}

test('competing tabs send one initialization and read the original while the POST remains in flight', async () => {
  const saved = storage(), sharedLock = lock();
  let ids = 0, calls = 0;
  const first = createModuleInitialization(saved, () => `initialization-tab-${++ids}`, sharedLock);
  const second = createModuleInitialization(saved, () => `initialization-tab-${++ids}`, sharedLock);
  let resolve!: (value: ModuleInitializationOperation) => void;
  const pending = new Promise<ModuleInitializationOperation>(yes => { resolve = yes; });
  const sending = first.initialize(module, empty, gateway, () => true, async () => { calls++; return pending; });
  await assert.rejects(second.initialize(module, empty, 'https://other.test', () => true, noSubmit), /原出站操作/);
  const request = second.getSnapshot().attempt?.request;
  assert.ok(request);
  await second.read(async original => result(original));
  resolve(result(request, 'preparing'));
  await sending;
  assert.equal(ids, 1); assert.equal(calls, 1);
  assert.equal(createModuleInitialization(saved, undefined, sharedLock).getSnapshot().attempt?.confirmed, 'succeeded');
});

test('readback must match all original initialization fields and include Task config on success', async () => {
  const operation = createModuleInitialization(storage(), () => 'identity-checked-initialization', lock());
  await operation.initialize(module, empty, gateway, () => true, async request => result(request, 'unknown'));
  const request = operation.getSnapshot().attempt?.request;
  assert.ok(request);
  for (const patch of [{ operationId: 'other-operation' }, { version: '1.2.4' }, { digest: 'b'.repeat(64) },
    { gatewayUrl: 'https://other.test' }, { config: undefined }, { config: { ...configured, moduleId: 'wechat' as const } }]) {
    await assert.rejects(operation.read(async () => ({ ...result(request), ...patch })));
    assert.equal(operation.getSnapshot().attempt?.confirmed, undefined);
  }
});

test('unavailable persistence or Web Locks refuses initialization before invoking any hook', async () => {
  for (const [saved, sharedLock] of [
    [undefined, lock()],
    [{ ...storage(), setItem() { throw new Error('storage quota'); } }, lock()],
    [storage(), async () => { throw new Error('Web Locks unavailable'); }],
  ] as const) {
    const operation = createModuleInitialization(saved, () => 'unissued-initialization', sharedLock);
    await assert.rejects(operation.initialize(module, empty, gateway, () => true, noSubmit));
    assert.ok(operation.getSnapshot().error);
  }
});

test('closing the initialization view suppresses stale refreshes but preserves its original receipt', async () => {
  const operation = createModuleInitialization(storage(), () => 'closed-initialization-view', lock());
  const connection = { connState: 'open', connectionGeneration: 1 };
  const view = createKeyedAsync<void>('initialization-view', () => connection);
  let resolve!: (value: ModuleInitializationOperation) => void;
  const pending = new Promise<ModuleInitializationOperation>(yes => { resolve = yes; });
  view.activate();
  let refreshes = 0;
  const sending = view.run(() => operation.initialize(module, empty, gateway, () => true, async () => pending), () => { refreshes++; });
  await Promise.resolve();
  const request = operation.getSnapshot().attempt?.request;
  assert.ok(request);
  view.deactivate();
  resolve(result(request));
  await sending;
  assert.equal(refreshes, 0);
  assert.equal(operation.getSnapshot().result?.phase, 'succeeded');
});
