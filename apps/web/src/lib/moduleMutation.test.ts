import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IntentBody, ModuleUnbindOperation, ModuleUpdateOperation, SessionModules } from '@cockpit/protocol';
import { createModuleApply, createModuleInstall, createWechatUnbind, type ModuleInstallRequest } from './moduleMutation';
import type { BrowserOperationLock } from './browserOperationLock';
import { createKeyedAsync } from './keyedAsync';

type Apply = IntentBody<'session/modules/apply'>;
type Install = IntentBody<'modules/updates/install'>;
const selections = [{ moduleId: 'task' as const, roleId: 'commander', version: '1.2.1' }];
const makeApply = (operationId: string): Apply => ({ sessionId: 'session-a', selections, operationId });
const makeInstall = (operationId: string): Install => ({ moduleId: 'task', version: '1.2.1', sha256: 'a'.repeat(64), operationId });
function applied(request: Apply, phase: SessionModules['phase'] = 'applied'): SessionModules {
  return { sessionId: request.sessionId, operationId: request.operationId, phase, selections,
    ...(phase === 'applied' ? {} : { pendingSelections: selections }) };
}
const installed = (request: ModuleInstallRequest, state: ModuleUpdateOperation['state'] = 'succeeded'): ModuleUpdateOperation => ({
  ...request, state, updatedAt: 1,
});
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function lock(): BrowserOperationLock {
  let tail = Promise.resolve();
  return claim => { const next = tail.then(claim); tail = next.then(() => {}, () => {}); return next; };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('application timeout retains exact selections and ID after reload; other operation success cannot acknowledge it', async () => {
  const saved = storage(), mutex = lock();
  const original = createModuleApply('session-a', saved, () => 'apply-original-operation', mutex);
  await assert.rejects(original.start(makeApply, async () => { throw new Error('timeout'); }));
  const restored = createModuleApply('session-a', saved, () => { assert.fail('no replacement ID'); }, mutex);
  const body = restored.getSnapshot().attempt?.request;
  assert.ok(body);
  assert.deepEqual(body, makeApply('apply-original-operation'));
  await assert.rejects(restored.start(makeApply, async request => applied(request)), /不能换 ID/);
  for (const result of [null, applied({ ...body, operationId: 'someone-else-operation' }),
    { ...applied(body), selections: [{ ...selections[0], version: '1.2.0' }] },
    { ...applied(body), sessionId: 'session-b' }]) {
    await assert.rejects(restored.read(async () => result));
    await assert.rejects(restored.newOperation(), /未确认/);
  }
  assert.equal(restored.getSnapshot().attempt?.request.operationId, body.operationId);
});

test('applied ACK requires matching original readback before an explicit new apply is permitted', async () => {
  const operation = createModuleApply('session-a', storage(), () => 'applied-original-operation', lock());
  await operation.start(makeApply, async request => applied(request));
  await assert.rejects(operation.newOperation(), /未确认/);
  await operation.read(async request => ({ ...applied(request), nativePresent: false }));
  await assert.rejects(operation.newOperation(), /未确认/);
  await operation.read(async request => applied(request));
  assert.equal(operation.getSnapshot().attempt?.confirmed, 'succeeded');
  await operation.newOperation();
  assert.equal(operation.getSnapshot().attempt, undefined);
});

for (const phase of ['failed', 'unknown'] as const) {
  test(`${phase} application can continue only after matching pending readback, using exactly the retained request`, async () => {
    const operation = createModuleApply('session-a', storage(), () => 'retained-apply-operation', lock());
    const calls: Apply[] = [];
    const submit = async (request: Apply) => { calls.push(request); return applied(request, phase); };
    await operation.start(makeApply, submit);
    await assert.rejects(operation.resume(() => true, submit), /先只读核对/);
    await operation.read(async request => applied(request, phase));
    await assert.rejects(operation.newOperation(), /未确认/);
    await operation.resume(() => false, submit);
    assert.equal(calls.length, 1);
    await operation.resume(() => true, submit);
    assert.deepEqual(calls, [makeApply('retained-apply-operation'), makeApply('retained-apply-operation')]);
    await assert.rejects(operation.resume(() => true, submit), /先只读核对/);
    await assert.rejects(operation.read(async request => ({ ...applied(request, phase), pendingSelections: undefined })), /选择不匹配/);
    await assert.rejects(operation.resume(() => true, submit), /先只读核对/);
  });
}

test('a failed read invalidates previous continuation evidence without changing the original request', async () => {
  const operation = createModuleApply('session-a', storage(), () => 'failed-read-operation', lock());
  await operation.start(makeApply, async request => applied(request, 'unknown'));
  await operation.read(async request => applied(request, 'unknown'));
  await assert.rejects(operation.read(async () => { throw new Error('offline'); }));
  await assert.rejects(operation.resume(() => true, async () => { assert.fail('stale evidence cannot continue'); }));
  assert.equal(operation.getSnapshot().attempt?.request.operationId, 'failed-read-operation');
});

test('competing application sends and explicit continuations each claim one operation generation', { timeout: 5000 }, async () => {
  const saved = storage(), mutex = lock(), response = deferred<SessionModules>();
  let ids = 0, calls = 0;
  const first = createModuleApply('session-a', saved, () => { ids++; return 'shared-apply-operation'; }, mutex);
  const second = createModuleApply('session-a', saved, () => { ids++; return 'wrong-apply-operation'; }, mutex);
  const sending = first.start(makeApply, async () => { calls++; return response.promise; });
  await assert.rejects(second.start(makeApply, async () => { assert.fail('only one send'); }));
  assert.equal(ids, 1); assert.equal(calls, 1);
  const body = second.getSnapshot().attempt?.request;
  assert.ok(body);
  response.resolve(applied(body, 'unknown')); await sending;
  await first.read(async request => applied(request, 'unknown'));
  const pending = deferred<SessionModules>();
  const continuing = first.resume(() => true, async () => { calls++; return pending.promise; });
  await assert.rejects(second.resume(() => true, async () => { assert.fail('only one continuation'); }));
  pending.resolve(applied(body)); await continuing;
  assert.equal(ids, 1); assert.equal(calls, 2);
});

test('adopting a retained server application for readback never submits or creates an operation ID', async () => {
  const operation = createModuleApply('session-a', storage(), () => { assert.fail('read-only adoption'); }, lock());
  await operation.read(async request => applied(request, 'failed'), makeApply('server-retained-operation'));
  assert.equal(operation.getSnapshot().attempt?.request.operationId, 'server-retained-operation');
  assert.equal(operation.getSnapshot().attempt?.continuable, true);
});

for (const state of ['unknown', 'failed', 'succeeded'] as const) {
  test(`installation ${state} never gets a new ID without an original historical get and explicit transition`, async () => {
    const saved = storage(), mutex = lock();
    const operation = createModuleInstall('task', saved, () => 'retained-install-operation', mutex);
    await operation.start(makeInstall, async request => installed(request, state));
    await assert.rejects(operation.newOperation(), /未确认/);
    const restored = createModuleInstall('task', saved, () => { assert.fail('no replacement install'); }, mutex);
    await assert.rejects(restored.start(makeInstall, async () => { assert.fail('no resubmit'); }));
    await assert.rejects(restored.read(async () => null));
    await restored.read(async request => installed(request, state));
    if (state === 'unknown') await assert.rejects(restored.newOperation(), /未确认/);
    else { await restored.newOperation(); assert.equal(restored.getSnapshot().attempt, undefined); }
  });
}

test('installation checks archive and original ID rather than whichever newer installation is listed', async () => {
  const operation = createModuleInstall('task', storage(), () => 'old-install-operation', lock());
  await assert.rejects(operation.start(makeInstall, async () => { throw new Error('response lost'); }));
  const original = operation.getSnapshot().attempt?.request;
  assert.ok(original);
  for (const patch of [{ operationId: 'new-install-operation' }, { sha256: 'b'.repeat(64) }, { version: '1.2.2' }]) {
    await assert.rejects(operation.read(async () => installed({ ...original, ...patch })), /原 ID\/归档/);
  }
  await operation.read(async request => { assert.equal(request.operationId, original.operationId); return installed(request); });
  assert.equal(operation.getSnapshot().attempt?.confirmed, 'succeeded');
});

test('competing installation tabs preserve a single fixed archive request', { timeout: 5000 }, async () => {
  const saved = storage(), mutex = lock(), response = deferred<ModuleUpdateOperation>();
  let ids = 0;
  const first = createModuleInstall('task', saved, () => { ids++; return 'shared-install-operation'; }, mutex);
  const second = createModuleInstall('task', saved, () => { ids++; return 'wrong-install-operation'; }, mutex);
  const sending = first.start(makeInstall, async () => response.promise);
  await assert.rejects(second.start(makeInstall, async () => { assert.fail('duplicate install'); }));
  const request = second.getSnapshot().attempt?.request;
  assert.ok(request);
  response.resolve(installed(request, 'unknown')); await sending;
  assert.equal(ids, 1);
});

const makeLocalInstall = (operationId: string): ModuleInstallRequest => ({
  moduleId: 'assistant', version: '1.0.0', sha256: 'c'.repeat(64), operationId, source: 'local',
});

for (const state of ['unknown', 'failed', 'succeeded', 'transport'] as const) {
  test(`local inventory ${state} persists its original source/version/digest and never becomes a remote retry`, async () => {
    const saved = storage(), mutex = lock();
    let calls = 0;
    const operation = createModuleInstall('assistant', saved, () => 'local-inventory-operation', mutex);
    const sending = operation.start(makeLocalInstall, async request => {
      calls++;
      assert.deepEqual(request, makeLocalInstall('local-inventory-operation'));
      assert.ok([...saved.values.values()][0].includes('"source":"local"'));
      if (state === 'transport') throw new Error('local install response lost');
      return installed(request, state);
    });
    if (state === 'transport') await assert.rejects(sending, /response lost/); else await sending;
    const restored = createModuleInstall('assistant', saved, () => { assert.fail('no new ID after reopen'); }, mutex);
    await assert.rejects(restored.start(id => ({ ...makeInstall(id), moduleId: 'assistant' }),
      async () => { assert.fail('cannot switch source around unknown local install'); }), /原出站操作/);
    await assert.rejects(restored.newOperation(), /未确认/);
    await assert.rejects(restored.read(async () => null), /未读到/);
    await restored.read(async request => {
      assert.equal(request.operationId, 'local-inventory-operation');
      assert.equal(request.source, 'local');
      assert.equal(request.sha256, 'c'.repeat(64));
      return installed(request, state === 'transport' ? 'unknown' : state);
    });
    if (state === 'failed' || state === 'succeeded') await restored.newOperation();
    else await assert.rejects(restored.newOperation(), /未确认/);
    assert.equal(calls, 1);
  });
}

test('local installation rejects an archive receipt with identical ID/version/hash and validates source-specific inputs', async () => {
  const operation = createModuleInstall('assistant', storage(), () => 'source-bound-operation', lock());
  await operation.start(makeLocalInstall, async request => installed(request, 'unknown'));
  const request = operation.getSnapshot().attempt?.request;
  assert.ok(request);
  await assert.rejects(operation.read(async () => ({ ...installed(request), source: undefined })), /inventory 来源/);
  assert.equal(operation.getSnapshot().attempt?.confirmed, undefined);
  await operation.read(async () => installed(request));
  assert.equal(operation.getSnapshot().attempt?.confirmed, 'succeeded');
  const invalid = createModuleInstall('assistant', storage(), () => 'invalid-local-operation', lock());
  for (const patch of [{ version: 'not-a-version' }, { sha256: 'invalid' }, { path: '/caller/supplied/path' }]) {
    await assert.rejects(invalid.start(id => ({ ...makeLocalInstall(id), ...patch }),
      async () => { assert.fail('local install must not accept paths or invalid identity'); }));
  }
});

for (const localFirst of [true, false]) {
  test(`local and archive installations share a single cross-tab lock (local first: ${localFirst})`, async () => {
    const saved = storage(), mutex = lock(), response = deferred<ModuleUpdateOperation>();
    let ids = 0, calls = 0;
    const first = createModuleInstall('assistant', saved, () => `shared-source-${++ids}`, mutex);
    const second = createModuleInstall('assistant', saved, () => `shared-source-${++ids}`, mutex);
    const remote = (id: string): ModuleInstallRequest => ({ ...makeInstall(id), moduleId: 'assistant' });
    const sending = first.start(localFirst ? makeLocalInstall : remote, async () => { calls++; return response.promise; });
    await assert.rejects(second.start(localFirst ? remote : makeLocalInstall,
      async () => { assert.fail('second source must not bypass original claim'); }), /原出站操作/);
    const original = second.getSnapshot().attempt?.request;
    assert.ok(original);
    await second.read(async request => {
      assert.deepEqual(request, original);
      return installed(request, 'unknown');
    });
    response.resolve(installed(original, 'unknown'));
    await sending;
    assert.equal(ids, 1); assert.equal(calls, 1);
  });
}

test('legacy archive records without source remain archive-bound while server local records can be adopted for readback', async () => {
  const saved = storage();
  saved.setItem('cockpit:module-install:task:v1', JSON.stringify({ version: 1, revision: 0, request: makeInstall('legacy-archive-operation') }));
  const operation = createModuleInstall('task', saved, () => { assert.fail('read-only legacy record'); }, lock());
  await assert.rejects(operation.read(async request => ({ ...installed(request), source: 'local' })), /inventory 来源/);
  await operation.read(async request => installed(request));
  assert.equal(operation.getSnapshot().attempt?.confirmed, 'succeeded');
  const observed = createModuleInstall('assistant', storage(), () => { assert.fail('read-only local adoption'); }, lock());
  await observed.read(async request => installed(request, 'unknown'), makeLocalInstall('observed-local-operation'));
  assert.equal(observed.getSnapshot().attempt?.request.source, 'local');
  await assert.rejects(observed.newOperation(), /未确认/);
});

test('unknown WeChat unbind is retained globally even if the binding disappears or another session binds', async () => {
  const saved = storage(), mutex = lock();
  const operation = createWechatUnbind(saved, () => 'unknown-unbind-operation', mutex);
  await assert.rejects(operation.start(operationId => ({ operationId, sessionId: 'old-session', confirm: true }),
    async () => { throw new Error('lost unbind response'); }));
  const restored = createWechatUnbind(saved, () => { assert.fail('cannot allocate replacement unbind'); }, mutex);
  await assert.rejects(restored.start(operationId => ({ operationId, sessionId: 'new-session', confirm: true }),
    async () => { assert.fail('no new POST'); }));
  await assert.rejects(restored.newOperation(), /未确认/);
  assert.equal(restored.getSnapshot().attempt?.request.sessionId, 'old-session');
  assert.equal(restored.getSnapshot().attempt?.request.operationId, 'unknown-unbind-operation');
});

test('WeChat direct acknowledgement permits only an explicit new operation, with no implicit resubmit', async () => {
  const operation = createWechatUnbind(storage(), () => 'acknowledged-unbind-operation', lock());
  await operation.start(operationId => ({ operationId, sessionId: 'old-session', confirm: true }), async () => ({ ok: true }));
  assert.equal(operation.getSnapshot().attempt?.confirmed, 'succeeded');
  await operation.newOperation();
  assert.equal(operation.getSnapshot().attempt, undefined);
});

for (const state of ['working', 'unknown', 'failed', 'succeeded'] as const) {
  test(`retained WeChat unbind ${state} is read by both original identities without replaying POST`, async () => {
    const saved = storage(), mutex = lock();
    const operation = createWechatUnbind(saved, () => 'unbind-history-operation', mutex);
    let posts = 0;
    await assert.rejects(operation.start(operationId => ({ operationId, sessionId: 'deleted-native-session', confirm: true }),
      async () => { posts++; throw new Error('lost POST response'); }));
    const reopened = createWechatUnbind(saved, () => { assert.fail('readback must not allocate an operation'); }, mutex);
    await assert.rejects(reopened.read(async () => null), /原 operationId 和 sessionId/);
    await assert.rejects(reopened.newOperation(), /未确认/);
    await assert.rejects(reopened.read(async () => { throw new Error('read-only route not ready'); }), /route not ready/);
    await assert.rejects(reopened.newOperation(), /未确认/);
    await reopened.read(async request => {
      assert.equal(request.operationId, 'unbind-history-operation');
      assert.equal(request.sessionId, 'deleted-native-session');
      return { operationId: request.operationId, sessionId: request.sessionId, state,
        ...(state === 'failed' ? { error: 'explicit original failure' } : {}) };
    });
    assert.equal(reopened.getSnapshot().result?.state, state);
    assert.equal(reopened.getSnapshot().attempt?.request.sessionId, 'deleted-native-session');
    await assert.rejects(reopened.start(operationId => ({ operationId, sessionId: 'new-current-binding', confirm: true }),
      async () => { assert.fail('even a terminal read must not automatically replace the original'); }));
    if (state === 'succeeded' || state === 'failed') {
      const restored = createWechatUnbind(saved, undefined, mutex);
      assert.equal(restored.getSnapshot().attempt?.confirmed, state);
      await restored.newOperation();
      assert.equal(restored.getSnapshot().attempt, undefined);
    } else await assert.rejects(reopened.newOperation(), /未确认/);
    assert.equal(posts, 1);
  });
}

test('WeChat readback rejects mismatched IDs/session, malformed receipts and bare POST acknowledgements', async () => {
  const operation = createWechatUnbind(storage(), () => 'matched-unbind-operation', lock());
  await assert.rejects(operation.start(operationId => ({ operationId, sessionId: 'original-native-session', confirm: true }),
    async () => { throw new Error('unknown'); }));
  const receipt: ModuleUnbindOperation = { operationId: 'matched-unbind-operation', sessionId: 'original-native-session', state: 'succeeded' };
  for (const result of [
    { ...receipt, operationId: 'unrelated-operation' }, { ...receipt, sessionId: 'new-binding-session' },
    JSON.parse('{"ok":true}'), JSON.parse('{"operationId":"matched-unbind-operation","sessionId":"original-native-session","state":"done"}'),
  ]) {
    await assert.rejects(operation.read(async () => result));
    assert.equal(operation.getSnapshot().attempt?.confirmed, undefined);
    await assert.rejects(operation.newOperation(), /未确认/);
  }
});

test('late WeChat POST does not overwrite an explicit historical failure or reopen a newer target', async () => {
  const saved = storage(), mutex = lock(), response = deferred<{ ok: true }>();
  const first = createWechatUnbind(saved, () => 'late-unbind-operation', mutex);
  const sending = first.start(operationId => ({ operationId, sessionId: 'old-target', confirm: true }), async () => response.promise);
  await Promise.resolve();
  const second = createWechatUnbind(saved, () => 'next-unbind-operation', mutex);
  await second.read(async request => ({ operationId: request.operationId, sessionId: request.sessionId, state: 'failed' }));
  response.resolve({ ok: true });
  await sending;
  assert.equal(first.getSnapshot().attempt?.confirmed, 'failed');
  const delayed = deferred<ModuleUnbindOperation>();
  const reading = first.read(async () => delayed.promise);
  await second.newOperation();
  await second.start(operationId => ({ operationId, sessionId: 'new-target', confirm: true }), async () => ({ ok: true }));
  delayed.resolve({ operationId: 'late-unbind-operation', sessionId: 'old-target', state: 'failed' });
  await reading;
  assert.equal(createWechatUnbind(saved, undefined, mutex).getSnapshot().attempt?.request.sessionId, 'new-target');
});

test('WeChat terminal proof cannot be downgraded by a stale working read', async () => {
  const operation = createWechatUnbind(storage(), () => 'terminal-unbind-operation', lock());
  await operation.start(operationId => ({ operationId, sessionId: 'original-target', confirm: true }), async () => ({ ok: true }));
  await assert.rejects(operation.read(async request =>
    ({ operationId: request.operationId, sessionId: request.sessionId, state: 'working' })), /终态冲突/);
  assert.equal(operation.getSnapshot().attempt?.confirmed, 'succeeded');
});

test('competing manual unbind tabs cannot allocate or send a second request, including another session target', { timeout: 5000 }, async () => {
  const saved = storage(), mutex = lock(), reply = deferred<{ ok: true }>();
  let ids = 0, calls = 0;
  const first = createWechatUnbind(saved, () => { ids++; return 'shared-unbind-operation'; }, mutex);
  const second = createWechatUnbind(saved, () => { ids++; return 'wrong-unbind-operation'; }, mutex);
  const sending = first.start(operationId => ({ sessionId: 'old-session', operationId, confirm: true }),
    async () => { calls++; return reply.promise; });
  await assert.rejects(second.start(operationId => ({ sessionId: 'other-session', operationId, confirm: true }),
    async () => { assert.fail('second tab must not send'); }), /不能换 ID/);
  assert.equal(second.getSnapshot().attempt?.request.sessionId, 'old-session');
  assert.equal(ids, 1); assert.equal(calls, 1);
  reply.resolve({ ok: true }); await sending;
});

test('late readback cannot replace another tab generation and cancelled views cannot navigate on application success', async () => {
  const saved = storage(), mutex = lock(), response = deferred<SessionModules>();
  const first = createModuleApply('session-a', saved, () => 'old-apply-operation', mutex);
  const view = createKeyedAsync<void>('apply-view', () => ({ connState: 'open', connectionGeneration: 1 }));
  let navigations = 0;
  view.activate();
  const sending = view.run(() => first.start(makeApply, async () => response.promise), () => { navigations++; });
  view.deactivate();
  const second = createModuleApply('session-a', saved, () => 'new-apply-operation', mutex);
  await second.read(async request => applied(request), makeApply('old-apply-operation'));
  await second.newOperation();
  await second.start(makeApply, async request => applied(request, 'unknown'));
  response.resolve(applied(makeApply('old-apply-operation'))); await sending;
  assert.equal(navigations, 0);
  assert.equal(first.getSnapshot().attempt?.request.operationId, 'new-apply-operation');
});

test('missing/failed storage, invalid records or unavailable locks fail closed before any mutation', async () => {
  const corrupt = storage();
  corrupt.setItem('cockpit:module-install:task:v1', '{broken');
  const denied: BrowserOperationLock = async () => { throw new Error('lock denied'); };
  for (const [saved, mutex] of [[undefined, lock()], [corrupt, lock()],
    [{ ...storage(), setItem() { throw new Error('quota'); } }, lock()], [storage(), denied]] as const) {
    const operation = createModuleInstall('task', saved, () => 'unsafe-install-operation', mutex);
    await assert.rejects(operation.start(makeInstall, async () => { assert.fail('untrackable install'); }));
    assert.ok(operation.getSnapshot().error);
  }
});
