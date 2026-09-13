import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IntentBody, ModuleServiceJob, ModuleServiceStatus, ModuleStatus } from '@cockpit/protocol';
import { ModuleServiceOperation, selectedServiceRelease, serviceActionReason, serviceRecoveryReason, serviceJobLabels } from './moduleService';
import type { BrowserOperationLock } from './browserOperationLock';

type Request = IntentBody<'modules/service'>;
const digest = 'c'.repeat(64);
const identity = { moduleId: 'task' as const, moduleVersion: '1.0.0', moduleDigest: 'a'.repeat(64), instanceId: 'actual-instance' };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function serialLock(): BrowserOperationLock {
  let tail = Promise.resolve();
  return claim => {
    const next = tail.then(claim);
    tail = next.then(() => {}, () => {});
    return next;
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixtures(running = false) {
  const runner: ModuleServiceStatus = { id: 'task', status: running ? 'running' : 'stopped',
    owned: running, recoveryRequired: false, ...(running ? { identity, pid: 123 } : {}) };
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task service', roles: [],
    installed: [{ version: '1.0.0', digest: identity.moduleDigest }, { version: '2.0.0', digest }],
    selectedVersion: '2.0.0', service: { ownership: 'managed', status: runner.status, runner,
      ...(running ? { version: identity.moduleVersion, digest: identity.moduleDigest, instanceId: identity.instanceId } : {}) } };
  return { runner, module };
}
function job(request: Request, phase: ModuleServiceJob['phase'] = 'accepted'): ModuleServiceJob {
  const { moduleId, ...command } = request;
  return { schemaVersion: 1, command: { id: moduleId, ...command }, phase,
    step: phase === 'waiting' ? 'waiting-exit' : phase === 'done' || phase === 'failed' ? 'complete' : 'queued',
    acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:01.000Z',
    ...(phase === 'waiting' ? { reason: 'active native work is still draining' } : {}) };
}
const noSubmit = async (): Promise<{ job: ModuleServiceJob }> => { assert.fail('must not submit'); };
function recoveryFixtures(noSpawn = false) {
  const { module, runner } = fixtures(!noSpawn);
  const request: Request = { moduleId: 'task', action: 'start', operationId: 'original-fault-operation', version: '2.0.0', digest };
  const recoverable: ModuleServiceStatus = { ...runner, status: 'unknown', recoveryRequired: true,
    canRecoverStop: true, job: job(request, 'unknown') };
  return { module: { ...module, service: { ...module.service, runner: recoverable } }, runner: recoverable, request };
}

for (const noSpawn of [false, true]) {
  test(`explicit recovery stops only, with a separate durable ID and preserved original job (no spawn: ${noSpawn})`, async () => {
    const { module, runner, request: original } = recoveryFixtures(noSpawn);
    const saved = storage(), operation = new ModuleServiceOperation('task', saved, () => 'separate-recovery-operation', serialLock());
    const calls: Request[] = [];
    let confirmation = '';
    await operation.recover(module, runner, message => { confirmation = message; return true; },
      async request => { calls.push(request); return { job: job(request, 'done') }; });
    assert.deepEqual(calls, [{ moduleId: 'task', action: 'stop', operationId: 'separate-recovery-operation',
      recoveryOf: original.operationId, confirmRecovery: true }]);
    assert.match(confirmation, /不启动替代、不回滚数据、不清除旧作业、不强停、不重发业务/);
    assert.equal(operation.getSnapshot().attempt?.request.operationId, original.operationId);
    assert.equal(operation.getSnapshot().attempt?.recovery?.request.operationId, 'separate-recovery-operation');
    await assert.rejects(operation.newOperation(), /确认恢复停止 done/);
    await operation.read(async id => { assert.equal(id, original.operationId); return { job: job(original, 'unknown') }; });
    await operation.readRecovery(async id => {
      assert.equal(id, 'separate-recovery-operation');
      return { job: job(calls[0], 'done') };
    });
    assert.equal(operation.getSnapshot().job?.phase, 'unknown');
    assert.equal(operation.getSnapshot().attempt?.terminal, undefined);
    assert.equal(operation.getSnapshot().attempt?.recovery?.terminal, 'done');
    const reopened = new ModuleServiceOperation('task', saved, undefined, serialLock());
    assert.equal(reopened.getSnapshot().attempt?.recovery?.terminal, 'done');
    await reopened.newOperation();
    assert.equal(reopened.getSnapshot().attempt, undefined);
    assert.equal(runner.job?.phase, 'unknown', 'clearing the GUI attempt never changes the original runner job');
    assert.equal(calls.length, 1);
  });
}

test('health uncertainty can recover a completed start without rewriting its result', async () => {
  const { module, runner, request: original } = recoveryFixtures();
  const completed = job(original, 'done');
  const uncertain = { ...runner, job: completed };
  const target = { ...module, service: { ...module.service, status: 'unknown' as const, runner: uncertain } };
  const operation = new ModuleServiceOperation('task', storage(), () => 'health-recovery-operation', serialLock());
  await operation.read(async () => ({ job: completed }), completed);
  assert.equal(operation.getSnapshot().attempt?.terminal, 'done');
  assert.equal(serviceRecoveryReason(target, uncertain), undefined);
  for (const action of ['start', 'stop', 'apply'] as const) {
    assert.ok(serviceActionReason(target, uncertain, action));
  }
  await operation.recover(target, uncertain, () => false, noSubmit);
  assert.equal(operation.getSnapshot().attempt?.recovery, undefined);
  await assert.rejects(operation.recover(target,
    { ...uncertain, job: job({ ...original, operationId: 'different-completed-start' }, 'done') },
    () => true, noSubmit), /不同原操作/);
  await assert.rejects(operation.recover(target,
    { ...uncertain, job: job({ ...original, moduleId: 'wechat' }, 'done') },
    () => { assert.fail('mismatched module must not reach confirmation'); }, noSubmit));
  let calls = 0;
  await operation.recover(target, uncertain, message => {
    assert.match(message, /original-fault-operation/);
    assert.match(message, /不启动替代、不回滚数据、不清除旧作业、不强停、不重发业务/);
    return true;
  }, async request => {
    calls++;
    assert.deepEqual(request, { moduleId: 'task', action: 'stop', operationId: 'health-recovery-operation',
      recoveryOf: original.operationId, confirmRecovery: true });
    return { job: job(request, 'waiting') };
  });
  assert.equal(calls, 1);
  assert.equal(uncertain.job.phase, 'done');
  assert.equal(operation.getSnapshot().job?.phase, 'done');
  assert.equal(operation.getSnapshot().attempt?.terminal, 'done');
  assert.equal(operation.getSnapshot().recoveryJob?.phase, 'waiting');
  await assert.rejects(operation.newOperation(), /确认恢复停止 done/);
});

test('recovery requires explicit runner authority and confirmation; cancellation never allocates an ID', async () => {
  const { module, runner } = recoveryFixtures();
  let ids = 0, confirmations = 0;
  const operation = new ModuleServiceOperation('task', storage(), () => { ids++; return 'unissued-recovery-operation'; }, serialLock());
  for (const blocked of [{ ...runner, canRecoverStop: undefined }, { ...runner, canRecoverStop: false },
    { ...runner, job: undefined }, { ...runner, id: 'wechat' as const }]) {
    assert.ok(serviceRecoveryReason(module, blocked));
    await assert.rejects(operation.recover(module, blocked, () => { confirmations++; return true; }, noSubmit));
  }
  await assert.rejects(operation.recover({ ...module, service: { ...module.service, ownership: 'external' } },
    runner, () => { confirmations++; return true; }, noSubmit));
  assert.equal(confirmations, 0);
  await operation.recover(module, runner, () => { confirmations++; return false; }, noSubmit);
  assert.equal(ids, 0);
  assert.equal(confirmations, 1);
  assert.equal(operation.getSnapshot().attempt, undefined);
});

for (const phase of ['unknown', 'failed', 'transport'] as const) {
  test(`${phase} recovery retains its own ID across reload and cannot become a regular retry`, async () => {
    const { module, runner } = recoveryFixtures();
    const saved = storage(), lock = serialLock();
    const operation = new ModuleServiceOperation('task', saved, () => 'uncertain-recovery-operation', lock);
    const send = operation.recover(module, runner, () => true, async request => {
      if (phase === 'transport') throw new Error('recovery response lost');
      return { job: job(request, phase) };
    });
    if (phase === 'transport') await assert.rejects(send, /response lost/); else await send;
    const restored = new ModuleServiceOperation('task', saved, () => { assert.fail('cannot replace recovery identity'); }, lock);
    await assert.rejects(restored.recover(module, runner, () => true, noSubmit), /保留的恢复操作/);
    const recovery = restored.getSnapshot().attempt?.recovery?.request;
    assert.ok(recovery);
    assert.equal(recovery.operationId, 'uncertain-recovery-operation');
    await assert.rejects(restored.readRecovery(async () => ({ job: null })), /尚无原操作回执/);
    await restored.readRecovery(async id => {
      assert.equal(id, recovery.operationId);
      return { job: job(recovery, phase === 'transport' ? 'unknown' : phase) };
    });
    await assert.rejects(restored.newOperation(), /确认恢复停止 done/);
    const healthy = fixtures();
    await assert.rejects(restored.send(healthy.module, healthy.runner, 'start', noSubmit), /原 ID/);
  });
}

test('competing tabs allocate one recovery ID and can read it while submission is in flight', { timeout: 5000 }, async () => {
  const { module, runner } = recoveryFixtures();
  const saved = storage(), lock = serialLock(), pending = deferred<{ job: ModuleServiceJob }>();
  let ids = 0, calls = 0;
  const first = new ModuleServiceOperation('task', saved, () => { ids++; return 'shared-recovery-operation'; }, lock);
  const second = new ModuleServiceOperation('task', saved, () => { ids++; return 'unwanted-recovery-operation'; }, lock);
  const sending = first.recover(module, runner, () => true, async () => { calls++; return pending.promise; });
  await assert.rejects(second.recover(module, runner, () => true, noSubmit), /保留的恢复操作/);
  const recovery = second.getSnapshot().attempt?.recovery?.request;
  assert.ok(recovery);
  await second.readRecovery(async id => { assert.equal(id, recovery.operationId); return { job: job(recovery, 'waiting') }; });
  pending.resolve({ job: job(recovery, 'waiting') });
  await sending;
  assert.equal(ids, 1); assert.equal(calls, 1);
});

test('a recovery must reference the preserved original fault and cannot clear an earlier failed record', async () => {
  const { module, runner, request: original } = recoveryFixtures();
  const healthy = fixtures(), saved = storage(), lock = serialLock();
  let ids = 0;
  const operation = new ModuleServiceOperation('task', saved, () => ++ids === 1 ? original.operationId : 'linked-recovery-operation', lock);
  await operation.send(healthy.module, healthy.runner, 'start', async request => ({ job: job(request, 'failed') }));
  await operation.read(async () => ({ job: job(original, 'failed') }));
  await assert.rejects(operation.recover(module, { ...runner, job: job({ ...original, operationId: 'other-fault-operation' }, 'unknown') },
    () => true, noSubmit), /不同原操作/);
  await operation.recover(module, runner, () => true, async request => ({ job: job(request, 'unknown') }));
  assert.equal(operation.getSnapshot().attempt?.terminal, 'failed');
  await assert.rejects(operation.newOperation(), /确认恢复停止 done/);
  const recovery = operation.getSnapshot().attempt?.recovery?.request;
  assert.ok(recovery);
  await assert.rejects(operation.readRecovery(async () => ({ job: job({ ...recovery, recoveryOf: 'wrong-original-operation' }, 'done') })), /不匹配/);
  assert.equal(operation.getSnapshot().attempt?.recovery?.terminal, undefined);
});

test('read-confirmed failed recovery advances only by explicit authorized safe-stop links across reload', async () => {
  const { module, runner, request: original } = recoveryFixtures();
  const saved = storage(), lock = serialLock(), history = new Map<string, ModuleServiceJob>();
  history.set(original.operationId, job(original, 'unknown'));
  let ids = 0;
  const newId = () => `chain-recovery-operation-${++ids}`;
  let operation = new ModuleServiceOperation('task', saved, newId, lock);
  const submit = async (request: Request) => {
    assert.equal(request.action, 'stop');
    assert.equal(request.confirmRecovery, true);
    assert.equal(request.version, undefined);
    assert.equal(request.digest, undefined);
    const result = job(request, 'failed');
    history.set(request.operationId, result);
    return { job: result };
  };
  await operation.recover(module, runner, () => true, submit);
  for (let link = 1; link <= 2; link++) {
    const failed = operation.getSnapshot().attempt?.recovery?.request;
    assert.ok(failed);
    const latest = { ...runner, job: job(failed, 'failed') };
    const noConfirmation = () => { assert.fail('cannot ask to advance an unconfirmed or unauthorized link'); };
    await assert.rejects(operation.recover(module, latest, noConfirmation, noSubmit), /显式读回/);
    await assert.rejects(operation.readRecovery(async () => ({ job: null })), /尚无原操作回执/);
    await assert.rejects(operation.readRecovery(async () => ({ job: job({ ...failed, recoveryOf: 'wrong-previous-link' }, 'failed') })), /不匹配/);
    await assert.rejects(operation.recover(module, latest, noConfirmation, noSubmit), /显式读回/);
    await operation.readRecovery(async id => { assert.equal(id, failed.operationId); return { job: job(failed, 'failed') }; });
    operation = new ModuleServiceOperation('task', saved, newId, lock);
    await assert.rejects(operation.newOperation(), /确认恢复停止 done/);
    await assert.rejects(operation.recover(module, { ...latest, canRecoverStop: false }, noConfirmation, noSubmit), /未授权/);
    await assert.rejects(operation.recover(module, { ...latest, job: job(failed, 'unknown') }, noConfirmation, noSubmit), /显式读回/);
    await assert.rejects(operation.recover(module, runner, noConfirmation, noSubmit), /完全匹配/);
    await operation.recover(module, latest, () => false, noSubmit);
    assert.equal(ids, link, 'cancelled and blocked transitions never allocate another operation');
    const preservedHistory = JSON.stringify([...history]);
    let confirmation = '';
    await operation.recover(module, latest, message => { confirmation = message; return true; }, submit);
    assert.match(confirmation, /确认已修正失败原因/);
    assert.match(confirmation, /此前作业及失败结果保留在后台/);
    assert.ok(confirmation.includes(failed.operationId));
    assert.deepEqual(operation.getSnapshot().attempt?.request, failed);
    assert.equal(operation.getSnapshot().attempt?.terminal, 'failed');
    assert.equal(operation.getSnapshot().attempt?.recovery?.request.recoveryOf, failed.operationId);
    assert.equal(operation.getSnapshot().job?.phase, 'failed');
    assert.equal(JSON.stringify([...history].slice(0, -1)), preservedHistory);
    assert.equal(latest.job.phase, 'failed');
  }
  assert.equal(ids, 3);
  assert.equal(history.size, 4);
});

test('unknown recovery links remain read-only even when runner permits safe stop', async () => {
  const { module, runner } = recoveryFixtures();
  const saved = storage(), lock = serialLock();
  let ids = 0;
  const operation = new ModuleServiceOperation('task', saved, () => `unknown-link-operation-${++ids}`, lock);
  await operation.recover(module, runner, () => true, async request => ({ job: job(request, 'unknown') }));
  const request = operation.getSnapshot().attempt?.recovery?.request;
  assert.ok(request);
  await operation.readRecovery(async () => ({ job: job(request, 'unknown') }));
  const restored = new ModuleServiceOperation('task', saved, () => { assert.fail('must retain unknown link'); }, lock);
  await assert.rejects(restored.recover(module, { ...runner, job: job(request, 'unknown') },
    () => { assert.fail('unknown link must not ask to advance'); }, noSubmit), /unknown 的恢复链节/);
  await assert.rejects(restored.newOperation(), /确认恢复停止 done/);
  assert.equal(ids, 1);
});

test('adopting a failed recovery from runner history requires explicit readback and never allows a regular reset', async () => {
  const { module, runner, request: original } = recoveryFixtures();
  const failed: Request = { moduleId: 'task', action: 'stop', operationId: 'adopted-failed-recovery',
    recoveryOf: original.operationId, confirmRecovery: true };
  const latest = { ...runner, job: job(failed, 'failed') };
  const operation = new ModuleServiceOperation('task', storage(), () => 'adopted-next-recovery', serialLock());
  await assert.rejects(operation.recover(module, latest, () => { assert.fail('read required'); }, noSubmit), /显式读回/);
  await operation.read(async () => ({ job: latest.job }), latest.job);
  await assert.rejects(operation.newOperation(), /确认恢复停止 done/);
  await operation.recover(module, latest, () => true, async request => {
    assert.equal(request.recoveryOf, failed.operationId);
    return { job: job(request, 'done') };
  });
  const next = operation.getSnapshot().attempt?.recovery?.request;
  assert.ok(next);
  await operation.readRecovery(async () => ({ job: job(next, 'done') }));
  await operation.newOperation();
  assert.equal(operation.getSnapshot().attempt, undefined);
  assert.equal(latest.job.phase, 'failed');
});

test('competing tabs advance one failed recovery link and late earlier receipts cannot replace the new link', { timeout: 5000 }, async () => {
  const { module, runner } = recoveryFixtures();
  const saved = storage(), lock = serialLock(), pending = deferred<{ job: ModuleServiceJob }>();
  let ids = 0, calls = 0;
  const make = () => new ModuleServiceOperation('task', saved, () => `competing-chain-operation-${++ids}`, lock);
  const first = make();
  const started = deferred<Request>();
  const sending = first.recover(module, runner, () => true, async request => { started.resolve(request); return pending.promise; });
  const failed = await started.promise;
  const second = make(), third = make();
  await second.readRecovery(async () => ({ job: job(failed, 'failed') }));
  const latest = { ...runner, job: job(failed, 'failed') };
  const advance = second.recover(module, latest, () => true, async request => { calls++; return { job: job(request, 'unknown') }; });
  await assert.rejects(third.recover(module, latest, () => true, noSubmit), /完全匹配/);
  await advance;
  pending.resolve({ job: job(failed, 'failed') });
  await sending;
  const snapshot = make().getSnapshot();
  assert.equal(snapshot.attempt?.request.operationId, failed.operationId);
  assert.equal(snapshot.attempt?.terminal, 'failed');
  assert.equal(snapshot.attempt?.recovery?.request.operationId, 'competing-chain-operation-2');
  assert.equal(snapshot.attempt?.recovery?.terminal, undefined);
  assert.equal(calls, 1);
  assert.equal(ids, 2);
});

for (const action of ['start', 'stop', 'apply'] as const) {
  test(`${action} submits exactly the selected installed identity, except stop has no version fields`, async () => {
    const { module, runner } = fixtures(action !== 'start');
    const saved = storage();
    const operation = new ModuleServiceOperation('task', saved, () => 'exact-service-operation', serialLock());
    const calls: Request[] = [];
    await operation.send(module, runner, action, async request => { calls.push(request); return { job: job(request) }; });
    assert.deepEqual(calls, [{ moduleId: 'task', action, operationId: 'exact-service-operation',
      ...(action === 'stop' ? {} : { version: '2.0.0', digest }) }]);
    assert.equal(operation.getSnapshot().job?.phase, 'accepted');
    assert.equal(operation.getSnapshot().attempt?.terminal, undefined);
    assert.equal(module.service.version, action === 'start' ? undefined : '1.0.0');
    const persisted = JSON.parse([...saved.values.values()][0]);
    assert.deepEqual(Object.keys(persisted).sort(), ['request', 'version']);
    assert.equal(persisted.job, undefined, 'actual runner status is never mirrored into persistent GUI records');
  });
}

test('service gates reject external, missing, unsafe and mismatched runner authority without allocating IDs', async () => {
  const { module, runner } = fixtures(true);
  const cases: { module: ModuleStatus; runner: ModuleServiceStatus; action: Request['action'] }[] = [
    { module: { ...module, service: { ...module.service, ownership: 'external' } }, runner, action: 'stop' },
    { module: { ...module, service: { ...module.service, ownership: 'none' } }, runner, action: 'stop' },
    { module: { ...module, service: { ...module.service, runner: undefined } }, runner, action: 'stop' },
    ...(['starting', 'draining', 'failed', 'unknown'] as const).map(status => ({ module, runner: { ...runner, status }, action: 'stop' as const })),
    { module, runner: { ...runner, id: 'wechat' }, action: 'stop' },
    { module, runner: { ...runner, owned: false }, action: 'stop' },
    { module, runner: { ...runner, recoveryRequired: true, canRecoverStop: true }, action: 'stop' },
    { module, runner: { ...runner, identity: undefined }, action: 'stop' },
    { module, runner: { ...runner, identity: { ...identity, moduleId: 'wechat' } }, action: 'apply' },
    { module, runner: { ...runner, expectedIdentity: { ...identity, instanceId: 'different-instance' } }, action: 'apply' },
    { module, runner: { ...runner, expectedPid: 999 }, action: 'stop' },
    { module: { ...module, selectedVersion: '3.0.0' }, runner, action: 'apply' },
    { module: { ...module, installed: [{ version: '2.0.0', digest: 'invalid' }] }, runner, action: 'apply' },
    { module: { ...module, selectedVersion: '1.0.0' }, runner, action: 'apply' },
  ];
  for (const item of cases) {
    let ids = 0;
    const operation = new ModuleServiceOperation('task', storage(), () => { ids++; return 'not-issued'; }, serialLock());
    assert.ok(serviceActionReason(item.module, item.runner, item.action));
    await assert.rejects(operation.send(item.module, item.runner, item.action, noSubmit));
    assert.equal(ids, 0);
    assert.equal(operation.getSnapshot().attempt, undefined);
  }
});

test('stopped/unowned runner may start, but an occupied or active-job state cannot', () => {
  const { module, runner } = fixtures();
  assert.equal(serviceActionReason(module, runner, 'start'), undefined);
  for (const occupied of [{ ...runner, owned: true }, { ...runner, identity }, { ...runner, pid: 123 }]) {
    assert.ok(serviceActionReason(module, occupied, 'start'));
  }
  const request: Request = { moduleId: 'task', action: 'start', operationId: 'active-runner-operation', version: '2.0.0', digest };
  for (const phase of ['accepted', 'running', 'waiting', 'unknown'] as const) {
    assert.ok(serviceActionReason(module, { ...runner, job: job(request, phase) }, 'start'));
  }
  assert.equal(selectedServiceRelease(module)?.digest, digest);
  assert.equal(selectedServiceRelease({ ...module, installed: [...module.installed, module.installed[1]] }), undefined);
});

test('accepted/running/waiting/unknown receipts never enable a replacement or claim actual service readiness', async () => {
  const { module, runner } = fixtures();
  for (const phase of ['accepted', 'running', 'waiting', 'unknown'] as const) {
    const saved = storage();
    const operation = new ModuleServiceOperation('task', saved, () => 'pending-service-operation', serialLock());
    await operation.send(module, runner, 'start', async request => ({ job: job(request, phase) }));
    await operation.read(async () => ({ job: job(operation.getSnapshot().attempt!.request, phase) }));
    await assert.rejects(operation.newOperation(), /未知结果不能替换/);
    const reopened = new ModuleServiceOperation('task', saved, () => { assert.fail('cannot replace on reopen'); }, serialLock());
    await assert.rejects(reopened.send(module, runner, 'start', noSubmit), /原 ID/);
    assert.equal(reopened.getSnapshot().attempt?.request.operationId, 'pending-service-operation');
    assert.equal(reopened.getSnapshot().job, undefined);
  }
  assert.match(serviceJobLabels.accepted, /不是服务就绪/);
  assert.match(serviceJobLabels.running, /不是服务运行确认/);
  assert.match(serviceJobLabels.waiting, /等待/);
});

test('timeout and null or mismatched readback retain the original operation across reload', async () => {
  const { module, runner } = fixtures();
  const saved = storage();
  const operation = new ModuleServiceOperation('task', saved, () => 'lost-service-operation', serialLock());
  let calls = 0;
  await assert.rejects(operation.send(module, runner, 'start', async () => { calls++; throw new TypeError('timeout'); }), /timeout/);
  const restored = new ModuleServiceOperation('task', saved, undefined, serialLock());
  const ids: string[] = [];
  await assert.rejects(restored.read(async id => { ids.push(id); return { job: null }; }), /不能据此认定未执行/);
  const request = restored.getSnapshot().attempt!.request;
  await assert.rejects(restored.read(async () => ({ job: job({ ...request, operationId: 'wrong-operation' }, 'failed') })), /不匹配/);
  await assert.rejects(restored.read(async () => ({ job: job({ ...request, digest: 'd'.repeat(64) }, 'done') })), /不匹配/);
  await assert.rejects(restored.send(module, runner, 'start', noSubmit), /原 ID/);
  assert.deepEqual(ids, ['lost-service-operation']);
  assert.equal(calls, 1);
  assert.equal(restored.getSnapshot().attempt?.terminal, undefined);
});

for (const phase of ['failed', 'done'] as const) {
  test(`${phase} permits a new explicit operation only after exact original-job readback`, async () => {
    const { module, runner } = fixtures();
    const saved = storage();
    let ids = 0;
    const operation = new ModuleServiceOperation('task', saved, () => `terminal-operation-${++ids}`, serialLock());
    await operation.send(module, runner, 'start', async request => ({ job: job(request, phase) }));
    await assert.rejects(operation.newOperation(), /先读回/);
    const request = operation.getSnapshot().attempt!.request;
    await operation.read(async id => { assert.equal(id, request.operationId); return { job: job(request, phase) }; });
    assert.equal(operation.getSnapshot().attempt?.terminal, phase);
    const reopened = new ModuleServiceOperation('task', saved, undefined, serialLock());
    assert.equal(reopened.getSnapshot().attempt?.terminal, phase);
    await operation.newOperation();
    assert.equal(ids, 1, 'unlocking does not issue a mutation or allocate an ID');
    await operation.send(module, runner, 'start', async request => ({ job: job(request) }));
    assert.equal(ids, 2);
  });
}

test('competing tabs send once and can read the original job before the POST resolves', { timeout: 5000 }, async () => {
  const { module, runner } = fixtures();
  const saved = storage(), lock = serialLock(), response = deferred<{ job: ModuleServiceJob }>();
  let ids = 0, calls = 0;
  const first = new ModuleServiceOperation('task', saved, () => { ids++; return 'shared-service-operation'; }, lock);
  const second = new ModuleServiceOperation('task', saved, () => { ids++; return 'wrong-new-operation'; }, lock);
  const sending = first.send(module, runner, 'start', async () => { calls++; return response.promise; });
  await assert.rejects(second.send(module, runner, 'start', noSubmit), /原 ID/);
  assert.equal(ids, 1);
  assert.equal(calls, 1);
  const request = second.getSnapshot().attempt!.request;
  await first.read(async id => { assert.equal(id, request.operationId); return { job: job(request, 'waiting') }; });
  await second.read(async id => { assert.equal(id, request.operationId); return { job: job(request, 'waiting') }; });
  response.resolve({ job: job(request, 'waiting') });
  await sending;
  assert.equal(first.getSnapshot().job?.reason, 'active native work is still draining');
});

test('an explicitly observed runner job can be read without submitting or assigning a new ID', async () => {
  const request: Request = { moduleId: 'task', action: 'stop', operationId: 'existing-runner-operation' };
  const operation = new ModuleServiceOperation('task', storage(), () => { assert.fail('reads cannot allocate'); }, serialLock());
  await operation.read(async id => { assert.equal(id, request.operationId); return { job: job(request, 'waiting') }; }, job(request, 'waiting'));
  assert.equal(operation.getSnapshot().attempt?.request.operationId, request.operationId);
});

test('stale readback cannot overwrite a newer operation claimed by another tab', async () => {
  const { module, runner } = fixtures();
  const saved = storage(), lock = serialLock();
  const old = new ModuleServiceOperation('task', saved, () => 'old-service-operation', lock);
  await old.send(module, runner, 'start', async request => ({ job: job(request, 'done') }));
  const request = old.getSnapshot().attempt!.request;
  const pending = deferred<{ job: ModuleServiceJob }>();
  const reading = old.read(async () => pending.promise);
  const other = new ModuleServiceOperation('task', saved, () => 'new-service-operation', lock);
  await other.read(async () => ({ job: job(request, 'done') }));
  await other.newOperation();
  await other.send(module, runner, 'start', async next => ({ job: job(next, 'unknown') }));
  pending.resolve({ job: job(request, 'done') });
  await reading;
  assert.equal(old.getSnapshot().attempt?.request.operationId, 'new-service-operation');
  assert.equal(new ModuleServiceOperation('task', saved).getSnapshot().attempt?.request.operationId, 'new-service-operation');
});

test('unsafe locks, storage or corrupt records cannot send an untrackable operation', async () => {
  const { module, runner } = fixtures();
  const corrupt = storage();
  corrupt.setItem('cockpit:module-service:task:v1', '{broken');
  const denied: BrowserOperationLock = async () => { throw new Error('lock denied'); };
  for (const [saved, lock] of [[undefined, serialLock()], [corrupt, serialLock()],
    [{ ...storage(), setItem() { throw new Error('quota'); } }, serialLock()], [storage(), denied]] as const) {
    const operation = new ModuleServiceOperation('task', saved, () => 'unsafe-service-operation', lock);
    await assert.rejects(operation.send(module, runner, 'start', noSubmit));
    assert.ok(operation.getSnapshot().error);
  }
});
