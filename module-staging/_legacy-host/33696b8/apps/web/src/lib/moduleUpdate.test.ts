import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IntentBody, ModuleUpdateOperation } from '@cockpit/protocol';
import { reconcileModuleUpdate } from './moduleUpdate';

const operation: ModuleUpdateOperation = { moduleId: 'task', operationId: 'original-install-operation',
  version: '1.2.0', sha256: 'a'.repeat(64), state: 'unknown', updatedAt: 1 };

test('installation reconciliation cancellation does nothing and explains its non-retry boundary', async () => {
  let confirmation = '';
  const result = await reconcileModuleUpdate(operation, message => { confirmation = message; return false; },
    async () => { assert.fail('cancel must not send'); });
  assert.equal(result, undefined);
  assert.match(confirmation, /original-install-operation/);
  assert.match(confirmation, /不下载、不安装、不改 selected、不重启，不自动恢复/);
  assert.match(confirmation, /不会偷锁/);
});

for (const state of ['succeeded', 'failed', 'unknown'] as const) {
  test(`reconciliation preserves authoritative ${state} and sends only the original identity with confirmation`, async () => {
    const requests: IntentBody<'modules/updates/reconcile'>[] = [];
    const expected = { ...operation, state, error: state === 'failed' ? 'package retained; selection unchanged' : undefined };
    const result = await reconcileModuleUpdate(operation, () => true,
      async body => { requests.push(body); return expected; });
    assert.deepEqual(requests, [{ moduleId: 'task', operationId: 'original-install-operation', confirm: true }]);
    assert.deepEqual(result, expected);
    assert.equal(operation.state, 'unknown');
  });
}

test('only unknown operations may reconcile, and rejected locks or unknown responses are not retried', async () => {
  for (const state of ['downloading', 'extracting', 'installing', 'succeeded', 'failed'] as const) {
    await assert.rejects(reconcileModuleUpdate({ ...operation, state },
      () => { assert.fail('known state must not offer confirmation'); },
      async () => { assert.fail('known state must not reconcile'); }), /仅可核对/);
  }
  for (const error of ['existing operation lock', 'response unknown']) {
    let calls = 0;
    await assert.rejects(reconcileModuleUpdate(operation, () => true, async () => {
      calls++; throw new Error(error);
    }), new RegExp(error));
    assert.equal(calls, 1);
  }
});

test('a reconciliation receipt for another operation or archive is rejected', async () => {
  for (const patch of [{ operationId: 'other-operation' }, { moduleId: 'wechat' as const },
    { version: '2.0.0' }, { sha256: 'b'.repeat(64) }]) {
    await assert.rejects(reconcileModuleUpdate(operation, () => true,
      async () => ({ ...operation, ...patch, state: 'succeeded' })), /不匹配/);
  }
});

test('local reconciliation labels inventory SHA256 and cannot silently adopt a remote archive receipt', async () => {
  const local: ModuleUpdateOperation = { ...operation, moduleId: 'assistant', source: 'local' };
  let message = '';
  const result = await reconcileModuleUpdate(local, value => { message = value; return true; }, async body => {
    assert.deepEqual(body, { moduleId: 'assistant', operationId: operation.operationId, confirm: true });
    return { ...local, state: 'failed' };
  });
  assert.equal(result?.source, 'local');
  assert.match(message, /本机 inventory SHA256（不是归档哈希）/);
  await assert.rejects(reconcileModuleUpdate(local, () => true, async () => ({ ...local, source: undefined })), /不匹配/);
  await assert.rejects(reconcileModuleUpdate(operation, () => true, async () => ({ ...operation, source: 'local' })), /不匹配/);
});
