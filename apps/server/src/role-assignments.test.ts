import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { RoleAssignment, RoleAssignmentNotification } from '@cockpit/module-api/backend';
import { RoleAssignmentFailure } from '@cockpit/protocol';
import { RoleAssignments, type AssignmentHandler } from './role-assignments.ts';
import { moduleFixture } from './test-support/module-fixture.ts';

const role = { moduleId: 'fixture', roleId: 'owner' };
const assignment = (sessionId: string, operation: 'create' | 'add' = 'add'): RoleAssignment =>
  ({ sessionId, operation, roles: [role], previousRoles: [] });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
const handler = (hooks: AssignmentHandler['hooks'], controller = new AbortController()): AssignmentHandler =>
  ({ moduleId: 'fixture', hooks, signal: controller.signal });
type PartialFailure = Error & { sessionId: string; code: string; roleAssignment: { notificationId: string; saved: boolean | null } };

test('unrelated completion may remove an enumerated pending receipt without failing assignment', async t => {
  const f = await moduleFixture(t);
  const saved = new Map<string, RoleAssignment['roles']>();
  const entered = deferred();
  const finish = deferred();
  const firstHandler = handler({ saved: async () => { entered.resolve(); await finish.promise; } });
  const otherRole = { moduleId: 'other', roleId: 'worker' };
  const otherHandler = { ...handler({ saved() {} }), moduleId: 'other' };
  const service = new RoleAssignments(f.hostRoot, () => [firstHandler, otherHandler], async id => saved.get(id) ?? []);
  const first = service.run(assignment('first'), async () => { saved.set('first', [role]); });
  await entered.promise;
  const read = fs.readFile;
  let removed = false;
  const mocked = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (!removed && String(args[0]).includes('/role-notifications/pending/')) {
      removed = true;
      finish.resolve();
      await first;
    }
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    await service.run({ ...assignment('other'), roles: [otherRole] },
      async () => { saved.set('other', [otherRole]); });
    assert.equal(removed, true);
    assert.deepEqual(saved.get('other'), [otherRole]);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    finish.resolve();
    await first;
  }
});

for (const hook of ['permit', 'saved'] as const) {
  test(`${hook} deadline aborts waiting and preserves the correct native-effect boundary`, async t => {
    const f = await moduleFixture(t);
    const entered = deferred();
    const late = deferred();
    let callbackSignal: AbortSignal | undefined;
    let nativeCalls = 0;
    const wait = async (signal: AbortSignal) => { callbackSignal = signal; entered.resolve(); await late.promise; };
    const h = handler(hook === 'permit'
      ? { permit: async (_input, signal) => { await wait(signal); return { allowed: true }; } }
      : { saved: async (_input, signal) => { await wait(signal); } });
    const service = new RoleAssignments(f.hostRoot, () => [h], async () => [role]);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = service.run(assignment('original'), async () => { nativeCalls++; });
    const rejected = assert.rejects(run, hook === 'permit'
      ? { code: 'ROLE_ASSIGNMENT_TIMEOUT' } : { code: 'ROLE_ASSIGNMENT_INCOMPLETE' });
    await entered.promise;
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(callbackSignal?.aborted, true);
    late.resolve();
    await nextTurn();
    assert.equal(nativeCalls, hook === 'permit' ? 0 : 1);
    h.hooks = {};
    if (hook === 'permit') await service.run(assignment('second'), async () => { nativeCalls++; });
    else await assert.rejects(service.run(assignment('second'), async () => { assert.fail('saved timeout stays fenced'); }),
      /earlier assignment/);
  });
}

for (const confirmed of [true, false]) {
  test(`upgraded callback preserves original ${confirmed ? 'confirmed' : 'uncertain'} creation evidence`, async t => {
    const f = await moduleFixture(t);
    const saved = [role, { moduleId: 'other', roleId: 'worker' }];
    const notifications: RoleAssignmentNotification[] = [];
    const handlers = [handler({ saved: value => { notifications.push(value); } })];
    const service = new RoleAssignments(f.hostRoot, () => handlers, async () => saved);
    const initial = service.run({ ...assignment('original', 'create'), roles: saved }, async () => {
      if (!confirmed) throw new Error('Creation acknowledgement lost');
      return 'original';
    });
    if (confirmed) await initial;
    else await assert.rejects(initial, /creation is unconfirmed/);
    handlers.push({ ...handler({ saved: () => { throw new Error('Upgraded handler failed'); } }), moduleId: 'other' });
    const unchanged = { sessionId: 'original', status: 'unchanged' as const,
      roles: saved.map(value => ({ ...value, name: value.roleId, moduleName: value.moduleId })),
      appliedRoles: [], loaded: false, rolesNeedReload: false };
    await assert.rejects(service.run({ ...assignment('original'), roles: saved, previousRoles: saved },
      async () => unchanged), error => {
      const failure = RoleAssignmentFailure.parse(error);
      assert.equal(failure.roleAssignment.nativeCreation, confirmed ? 'confirmed' : 'unconfirmed');
      assert.deepEqual(failure.roleAssignment.mutationResult,
        confirmed ? { operation: 'create', result: { sessionId: 'original' } } : undefined);
      assert.equal(failure.roleAssignment.notificationStatus, confirmed ? 'failed' : 'deferred');
      if (confirmed) assert.equal(failure.roleAssignment.notificationId, notifications[0]!.notificationId);
      else assert.equal(notifications.length, 0);
      return true;
    });
  });
}

for (const operation of ['create', 'add'] as const) {
  test(`${operation} partial error carries the original returned mutation result and typed notification status`, async t => {
    const f = await moduleFixture(t);
    const roles = [{ ...role, name: 'Owner', moduleName: 'Fixture' }];
    const result = operation === 'create' ? 'actual' : {
      sessionId: 'actual', status: 'saved' as const, roles, appliedRoles: [], loaded: false, rolesNeedReload: false,
    };
    const h = handler({ saved: () => { throw new Error('Registration unavailable'); } });
    const service = new RoleAssignments(f.hostRoot, () => [h], async () => roles);
    await assert.rejects(service.run(assignment('actual', operation), async () => result), error => {
      const failure = RoleAssignmentFailure.parse(error);
      assert.equal(failure.sessionId, 'actual');
      assert.equal(failure.roleAssignment.saved, true);
      assert.equal(failure.roleAssignment.notificationStatus, 'failed');
      assert.equal(failure.roleAssignment.nativeCreation, operation === 'create' ? 'confirmed' : 'not-applicable');
      assert.deepEqual(failure.roleAssignment.mutationResult, {
        operation, result: operation === 'create' ? { sessionId: 'actual' } : result,
      });
      return true;
    });
  });
}

test('no handlers preserve native results without reading or writing notification state', async t => {
  const f = await moduleFixture(t);
  const service = new RoleAssignments(f.hostRoot, () => [], async () => { throw new Error('must not read'); });
  const result = { value: 7 };
  assert.equal(await service.run(assignment('one'), async () => result), result);
});

for (const operation of ['create', 'add'] as const) {
  test(`${operation} checks complete combined roles before saving and reports exact identity`, async t => {
    const f = await moduleFixture(t);
    let saved: RoleAssignment['roles'] = [];
    const events: RoleAssignmentNotification[] = [];
    const input = { ...assignment('native-id', operation), roles: [role, { moduleId: 'fixture', roleId: 'worker' }] };
    let deny = true;
    const h = handler({
      permit: value => {
        assert.deepEqual(value, input);
        return deny ? { allowed: false, reason: 'Combined roles conflict' } : { allowed: true };
      },
      saved: notification => { events.push(notification); },
    });
    const service = new RoleAssignments(f.hostRoot, () => [h], async () => saved);
    const save = async () => { saved = input.roles; return 'native-result'; };
    await assert.rejects(service.run(input, save), { code: 'ROLE_ASSIGNMENT_DENIED', message: 'Combined roles conflict' });
    assert.deepEqual(saved, []);
    deny = false;
    assert.equal(await service.run(input, save), 'native-result');
    assert.equal(events[0]?.sessionId, 'native-id');
    assert.match(events[0]!.notificationId, /^[a-f0-9]{64}$/);
    assert.deepEqual(events[0]?.roles, input.roles);
    assert.equal((await service.replay(events[0]!.notificationId)).status, 'unchanged');
    assert.equal(events.length, 1);
  });
}

test('conflicting tabs serialize permission through saved notification, unrelated modules do not wait', async t => {
  const f = await moduleFixture(t);
  const saved = new Map<string, RoleAssignment['roles']>();
  const gate = deferred();
  const notified = deferred();
  let occupied = false;
  let permits = 0;
  const h = handler({
    permit: () => { permits++; return occupied ? { allowed: false, reason: 'Occupied' } : { allowed: true }; },
    saved: async () => { notified.resolve(); await gate.promise; occupied = true; },
  });
  const service = new RoleAssignments(f.hostRoot, () => [h], async id => saved.get(id) ?? []);
  const save = (id: string) => service.run(assignment(id), async () => { saved.set(id, [role]); });
  const first = save('first');
  await notified.promise;
  const second = save('second');
  await nextTurn();
  assert.equal(permits, 1);
  await service.run({ ...assignment('other'), roles: [{ moduleId: 'other', roleId: 'worker' }] }, async () => {});
  gate.resolve();
  await first;
  await assert.rejects(second, /Occupied/);
  assert.equal(saved.has('second'), false);
});

test('failed saved callback fences conflicting assignments and explicitly replays after restart with stable identity', async t => {
  const f = await moduleFixture(t);
  let saved: RoleAssignment['roles'] = [];
  let fail = true;
  const ids: string[] = [];
  const h = handler({ saved: value => { ids.push(value.notificationId); if (fail) throw new Error('module storage unavailable'); } });
  let service = new RoleAssignments(f.hostRoot, () => [h], async () => saved);
  let failure!: PartialFailure;
  await assert.rejects(service.run(assignment('actual'), async () => { saved = [role]; }), error => {
    failure = error as PartialFailure;
    return failure.code === 'ROLE_ASSIGNMENT_INCOMPLETE';
  });

  test('unchanged role addition recovers failed notification with its original identity and never repeats accepted handling', async t => {
    const f = await moduleFixture(t);
    let saved: RoleAssignment['roles'] = [];
    let fail = true;
    let permits = 0;
    let saves = 0;
    const events: RoleAssignmentNotification[] = [];
    const h = handler({
      permit: () => { permits++; return { allowed: true }; },
      saved: value => { events.push(value); if (fail) throw new Error('Registration failed'); },
    });
    const service = new RoleAssignments(f.hostRoot, () => [h], async () => saved);
    await assert.rejects(service.run(assignment('actual', 'create'), async () => { saves++; saved = [role]; }), /Registration failed/);
    fail = false;
    const unchanged = { ...assignment('actual'), previousRoles: [role] };
    const results: string[] = [];
    await service.run(unchanged, async () => 'unchanged', result => { results.push(result.status); });
    await service.run(unchanged, async () => 'unchanged', result => { results.push(result.status); });
    assert.equal(saves, 1);
    assert.equal(permits, 1, 'recovery of an accepted selection is not a second permission or mutation');
    assert.deepEqual(results, ['notified', 'unchanged']);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.notificationId, events[1]!.notificationId);
    assert.equal(events[1]!.operation, 'create', 'recovery preserves the original accepted notification');
  });

  test('adding a callback after upgrade can notify already-saved roles without a new role save', async t => {
    const f = await moduleFixture(t);
    const saved = [role];
    const events: RoleAssignmentNotification[] = [];
    let handlers: AssignmentHandler[] = [];
    const service = new RoleAssignments(f.hostRoot, () => handlers, async () => saved);
    const input = { ...assignment('existing'), previousRoles: saved };
    await service.run(input, async () => 'unchanged');
    assert.equal(events.length, 0);
    handlers = [handler({ saved: value => { events.push(value); } })];
    const results: string[] = [];
    await service.run(input, async () => 'unchanged', value => { results.push(value.status); });
    await service.run(input, async () => 'unchanged', value => { results.push(value.status); });
    assert.deepEqual(results, ['notified', 'unchanged']);
    assert.equal(events.length, 1);
    assert.deepEqual(saved, [role]);
  });

  test('an upgraded callback on another selected module does not redeliver already-accepted handlers', async t => {
    const f = await moduleFixture(t);
    const saved = [role, { moduleId: 'another', roleId: 'worker' }];
    let first = 0;
    let second = 0;
    let fail = true;
    const existing = handler({ saved: () => { first++; } });
    const handlers = [existing];
    const service = new RoleAssignments(f.hostRoot, () => handlers, async () => saved);
    const input = { ...assignment('existing'), roles: saved, previousRoles: saved };
    await service.run(input, async () => 'unchanged');
    handlers.push({ ...handler({ saved: () => { second++; if (fail) throw new Error('New handler failed'); } }), moduleId: 'another' });
    await assert.rejects(service.run(input, async () => 'unchanged'), /New handler failed/);
    fail = false;
    await service.run(input, async () => 'unchanged');
    await service.run(input, async () => 'unchanged');
    assert.equal(first, 1);
    assert.equal(second, 2);
  });
  assert.equal(failure.sessionId, 'actual');
  assert.equal(failure.roleAssignment.saved, true);
  service = new RoleAssignments(f.hostRoot, () => [h], async () => saved);
  await assert.rejects(service.run(assignment('second'), async () => { assert.fail('must stay fenced'); }), /earlier assignment/);
  fail = false;
  const result = await service.replay(failure.roleAssignment.notificationId);
  assert.equal(result.status, 'notified');
  assert.deepEqual(ids, [result.notificationId, result.notificationId]);
  assert.equal((await service.replay(result.notificationId)).status, 'unchanged');
});

test('permission and notification callbacks allow reads but reject reentrant role mutations without deadlock', async t => {
  const f = await moduleFixture(t);
  let saved: RoleAssignment['roles'] = [];
  const read = async () => saved;
  const check = async () => {
    await read();
    service.assertHostCallAllowed('session/directory');
    service.assertHostCallAllowed('session/tool-scope');
    assert.throws(() => service.assertHostCallAllowed('session/load'), { code: 'ROLE_ASSIGNMENT_REENTRANT' });
    assert.throws(() => service.assertHostCallAllowed('session/tools-initialize'), { code: 'ROLE_ASSIGNMENT_REENTRANT' });
    await assert.rejects(service.run(assignment('nested'), async () => {}), { code: 'ROLE_ASSIGNMENT_REENTRANT' });
  };
  const h = handler({ permit: async () => { await check(); return { allowed: true }; }, saved: check });
  const service = new RoleAssignments(f.hostRoot, () => [h], read);
  await service.run(assignment('one'), async () => { saved = [role]; });
});

test('module lifecycle abort interrupts a waiting permission without saving', async t => {
  const f = await moduleFixture(t);
  const entered = deferred();
  const controller = new AbortController();
  const h = handler({ permit: () => { entered.resolve(); return new Promise(() => {}); } }, controller);
  const service = new RoleAssignments(f.hostRoot, () => [h], async () => []);
  const run = service.run(assignment('one'), async () => { assert.fail('must not save after abort'); });
  await entered.promise;
  controller.abort(new Error('module stopped'));
  await assert.rejects(run, /module stopped/);
});

test('shutdown aborts pending notification without waiting for module code and preserves recovery', async t => {
  const f = await moduleFixture(t);
  const entered = deferred();
  let saved: RoleAssignment['roles'] = [];
  let callbackSignal: AbortSignal | undefined;
  const h = handler({ saved: (_value, signal) => {
    callbackSignal = signal;
    entered.resolve();
    return new Promise(() => {});
  } });
  const service = new RoleAssignments(f.hostRoot, () => [h], async () => saved);
  const run = service.run(assignment('actual'), async () => { saved = [role]; });
  await entered.promise;
  service.stop();
  await assert.rejects(run, error => {
    const value = error as PartialFailure;
    assert.equal(value.roleAssignment.saved, true);
    assert.equal(value.sessionId, 'actual');
    return value.code === 'ROLE_ASSIGNMENT_INCOMPLETE';
  });
  assert.equal(callbackSignal?.aborted, true);
  await assert.rejects(service.run(assignment('next'), async () => { assert.fail(); }), /shutting down/);
});

test('native uncertainty after confirmed save remains a partial failure, never a success-shaped result', async t => {
  const f = await moduleFixture(t);
  let saved: RoleAssignment['roles'] = [];
  const notifications: RoleAssignmentNotification[] = [];
  const h = handler({ saved: value => { notifications.push(value); } });
  let exists = false;
  let id = '';
  const service = new RoleAssignments(f.hostRoot, () => [h], async () => saved, async () => exists);
  await assert.rejects(service.run(assignment('actual', 'create'), async () => {
    saved = [role];
    throw new Error('native acknowledgement lost');
  }), error => {
    const value = error as PartialFailure;
    assert.equal(value.sessionId, 'actual');
    assert.equal(value.roleAssignment.saved, true);
    assert.match(value.message, /creation is unconfirmed/);
    id = value.roleAssignment.notificationId;
    return true;
  });
  assert.equal(notifications.length, 0);
  await assert.rejects(service.replay(id), /creation remains unconfirmed/);
  exists = true;
  assert.equal((await service.replay(id)).status, 'notified');
  assert.equal(notifications.length, 1);
});

test('uncertain role persistence is fenced and explicitly reconciles unchanged previous selection without callback', async t => {
  const f = await moduleFixture(t);
  let unreadable = true;
  let count = 0;
  const h = handler({ saved: () => { count++; } });
  const service = new RoleAssignments(f.hostRoot, () => [h], async () => {
    if (unreadable) throw new Error('role storage unavailable');
    return [];
  });
  let id = '';
  await assert.rejects(service.run(assignment('actual'), async () => {}), error => {
    const value = error as PartialFailure;
    id = value.roleAssignment.notificationId;
    assert.equal(value.roleAssignment.saved, null);
    return true;
  });
  unreadable = false;
  assert.equal((await service.replay(id)).status, 'not-saved');
  assert.equal((await service.replay(id)).status, 'not-saved');
  assert.equal(count, 0);
});
