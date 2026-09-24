import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeyedAsync, type ResourceConnection } from './keyedAsync';
import { IntentHttpError } from '../net/client';
import { canAutoRefreshSessionResource } from './useSessionResource';
import { recordOperationFailure } from './operationErrors';
import { dismissUxError, getUxErrors } from './errorReporter';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup<T>() {
  let connection: ResourceConnection = { connState: 'open', connectionGeneration: 1 };
  const task = createKeyedAsync<T>(() => connection);
  task.activate();
  return {
    task,
    reconnect() { connection = { ...connection, connectionGeneration: connection.connectionGeneration + 1 }; },
    offline() { connection = { ...connection, connState: 'closed' }; },
  };
}

test('settled refresh callbacks run after both outcomes only while their action still owns the view', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    for (const leave of ['stay', 'unmount', 'reconnect', 'offline'] as const) {
      const h = setup<void>();
      const held = deferred<void>();
      let refreshes = 0;
      const result = h.task.run(() => held.promise, undefined, true, () => { refreshes++; });
      if (leave === 'unmount') h.task.deactivate();
      if (leave === 'reconnect') h.reconnect();
      if (leave === 'offline') h.offline();
      if (outcome === 'failure') held.reject(new Error('Mutation failed'));
      else held.resolve();
      await result;
      assert.equal(refreshes, leave === 'stay' ? 1 : 0, `${outcome}/${leave}`);
    }
  }
});

test('resource refresh coalesces same-turn triggers and loops once for a late dirty read', async () => {
  const { task } = setup<string>();
  let reads = 0;
  const held = deferred<string>();
  const load = () => { reads++; return reads === 1 ? held.promise : Promise.resolve('current'); };
  const result = task.refresh(load);
  assert.equal(task.refresh(load), result);
  await Promise.resolve();
  assert.equal(reads, 1);
  void task.refresh(load);
  void task.refresh(load);
  held.resolve('obsolete');
  assert.equal(await result, true);
  assert.equal(reads, 2);
  assert.equal(task.getSnapshot().data, 'current');
});

test('a deactivated pending resource cannot start after a source change or overwrite a new source', async () => {
  const { task } = setup<string>();
  const old = task.refresh(() => assert.fail('obsolete source must not start'));
  task.deactivate(true);
  task.activate();
  const fresh = task.refresh(async () => 'new-source');
  assert.equal(await old, false);
  assert.equal(await fresh, true);
  assert.equal(task.getSnapshot().data, 'new-source');
});

test('an explicit offline refresh neither starts a read nor schedules a dirty retry', async () => {
  const h = setup<string>();
  h.offline();
  assert.equal(await h.task.refresh(() => assert.fail('offline read')), false);
  h.task.deactivate();
  assert.equal(await h.task.refresh(() => assert.fail('unmounted read')), false);
});
test('first read exposes pending and a real failure, not a false empty resource', async () => {
  const { task } = setup<string[]>();
  const request = deferred<string[]>();
  const result = task.run(() => request.promise);
  assert.equal(task.getSnapshot().pending, true);
  assert.equal(task.getSnapshot().data, undefined);
  const error = new Error('permission denied');
  request.reject(error);
  assert.equal(await result, false);
  assert.deepEqual(task.getSnapshot(), { pending: false, error: 'permission denied', errorCause: error, generation: 1 });
});

test('failed same-key refresh retains the previous successful data beside its error', async () => {
  const { task } = setup<string[]>();
  await task.run(async () => ['valid']);
  const request = deferred<string[]>();
  const result = task.run(() => request.promise);
  assert.deepEqual(task.getSnapshot().data, ['valid']);
  request.reject(new Error('refresh failed'));
  await result;
  assert.deepEqual(task.getSnapshot().data, ['valid']);
  assert.equal(task.getSnapshot().error, 'refresh failed');
  assert.equal(task.getSnapshot().pending, false);
  await task.run(async () => []);
  assert.deepEqual(task.getSnapshot().data, []);
  assert.equal(task.getSnapshot().error, null);
});

test('failed reconnect retains only previously accepted same-key data', async () => {
  const { task, reconnect } = setup<string[]>();
  await task.run(async () => ['valid']);
  reconnect();
  task.deactivate();
  task.activate();
  await task.run(async () => { throw new Error('offline backend'); });
  assert.deepEqual(task.getSnapshot().data, ['valid']);
  assert.equal(task.getSnapshot().dataGeneration, 1);
  assert.equal(task.getSnapshot().generation, 2);
  assert.equal(task.getSnapshot().error, 'offline backend');
});

for (const outcome of ['success', 'failure'] as const) {
  test(`out-of-order ${outcome} cannot overwrite a newer result`, async () => {
    const { task } = setup<string>();
    const old = deferred<string>();
    const previous = task.run(() => old.promise);
    await task.run(async () => 'latest');
    if (outcome === 'success') old.resolve('obsolete');
    else old.reject(new Error('obsolete'));
    assert.equal(await previous, false);
    assert.equal(task.getSnapshot().data, 'latest');
    assert.equal(task.getSnapshot().error, null);
    assert.equal(task.getSnapshot().pending, false);
  });

  test(`open-to-open generation changes reject ${outcome} before effects run`, async () => {
    const { task, reconnect } = setup<string>();
    await task.run(async () => 'accepted');
    const old = deferred<string>();
    let successes = 0;
    const previous = task.run(() => old.promise, () => { successes++; });
    reconnect();
    if (outcome === 'success') old.resolve('obsolete');
    else old.reject(new Error('obsolete'));
    assert.equal(await previous, false);
    assert.equal(successes, 0);
    assert.equal(task.getSnapshot().data, 'accepted');
    assert.equal(task.getSnapshot().error, null);
  });

  test(`late ${outcome} cannot clear a new generation's spinner`, async () => {
    const { task, reconnect } = setup<string>();
    const old = deferred<string>();
    const previous = task.run(() => old.promise);
    reconnect();
    const current = deferred<string>();
    const latest = task.run(() => current.promise);
    if (outcome === 'success') old.resolve('obsolete');
    else old.reject(new Error('obsolete'));
    await previous;
    assert.equal(task.getSnapshot().pending, true);
    assert.equal(task.getSnapshot().data, undefined);
    assert.equal(task.getSnapshot().error, null);
    current.resolve('latest');
    await latest;
    assert.equal(task.getSnapshot().data, 'latest');
  });

  test(`route ownership and unmount discard late action ${outcome}`, async () => {
    const old = setup<void>();
    const next = setup<void>();
    const request = deferred<void>();
    let navigations = 0;
    const previous = old.task.run(() => request.promise, () => { navigations++; }, true);
    old.task.deactivate();
    if (outcome === 'success') request.resolve();
    else request.reject(new Error('old session error'));
    assert.equal(await previous, false);
    assert.equal(navigations, 0);
    assert.equal(next.task.getSnapshot().error, null);
    assert.equal(next.task.getSnapshot().data, undefined);
  });
}

test('a new resource owner never exposes another owner even when it has valid data', async () => {
  const first = setup<string[]>();
  await first.task.run(async () => ['private to a']);
  first.task.deactivate();
  const second = setup<string[]>();
  assert.equal(second.task.getSnapshot().data, undefined);
  await second.task.run(async () => { throw new Error('failed b'); });
  assert.equal(second.task.getSnapshot().data, undefined);
});

test('obsolete success cannot replace the retained data or error of a newer failed refresh', async () => {
  const { task } = setup<string>();
  await task.run(async () => 'accepted');
  const request = deferred<string>();
  const old = task.run(() => request.promise);
  await task.run(async () => { throw new Error('latest refresh failed'); });
  request.resolve('obsolete');
  await old;
  assert.equal(task.getSnapshot().data, 'accepted');
  assert.equal(task.getSnapshot().error, 'latest refresh failed');
});

test('exclusive actions guard duplicate clicks immediately and unlock after a real failure', async () => {
  const { task } = setup<void>();
  const request = deferred<void>();
  let calls = 0;
  const action = () => { calls++; return request.promise; };
  const first = task.run(action, undefined, true);
  assert.equal(await task.run(action, undefined, true), false);
  assert.equal(calls, 1);
  request.reject(new Error('not supported'));
  await first;
  assert.equal(task.getSnapshot().error, 'not supported');
  assert.equal(task.getSnapshot().pending, false);
  assert.equal(await task.run(async () => {}, undefined, true), true);
});

test('old action acknowledgements cannot refresh, navigate, or unlock a newer action after reconnect', async () => {
  const { task, reconnect } = setup<void>();
  const old = deferred<void>();
  let refreshes = 0;
  const previous = task.run(() => old.promise, () => { refreshes++; }, true);
  reconnect();
  const next = deferred<void>();
  const current = task.run(() => next.promise, () => { refreshes++; }, true);
  old.resolve();
  assert.equal(await previous, false);
  assert.equal(task.getSnapshot().pending, true);
  assert.equal(refreshes, 0);
  next.resolve();
  assert.equal(await current, true);
  assert.equal(refreshes, 1);
});

test('mutations refresh authoritatively only on acknowledgement without optimistic data', async () => {
  const resource = setup<string[]>();
  const action = setup<void>();
  await resource.task.run(async () => ['enabled']);
  const ack = deferred<void>();
  const listing = deferred<string[]>();
  let refreshed: Promise<boolean> | undefined;
  const pending = action.task.run(() => ack.promise, () => {
    refreshed = resource.task.run(() => listing.promise);
  }, true);
  assert.deepEqual(resource.task.getSnapshot().data, ['enabled']);
  assert.equal(refreshed, undefined);
  ack.resolve();
  await pending;
  assert.equal(resource.task.getSnapshot().pending, true);
  assert.deepEqual(resource.task.getSnapshot().data, ['enabled']);
  listing.resolve(['disabled']);
  await refreshed;
  assert.deepEqual(resource.task.getSnapshot().data, ['disabled']);
});

test('offline and disposed owners do not call actions or accept late errors', async () => {
  const { task, offline } = setup<void>();
  const request = deferred<void>();
  const running = task.run(() => request.promise);
  offline();
  request.reject(new Error('obsolete offline error'));
  assert.equal(await running, false);
  assert.equal(task.getSnapshot().error, null);
  let calls = 0;
  assert.equal(await task.run(() => { calls++; }), false);
  task.deactivate();
  assert.equal(await task.run(() => { calls++; }), false);
  assert.equal(calls, 0);
});

test('dispose and reactivate cannot resurrect an earlier request for the same key', async () => {
  const { task } = setup<string>();
  const request = deferred<string>();
  const old = task.run(() => request.promise);
  task.deactivate();
  task.activate();
  await task.run(async () => 'current');
  request.resolve('old mount');
  assert.equal(await old, false);
  assert.equal(task.getSnapshot().data, 'current');
});

test('ownership is checked again immediately before invoking an action', async () => {
  const { task, reconnect } = setup<void>();
  const unsubscribe = task.subscribe(() => { if (task.getSnapshot().pending) reconnect(); });
  let calls = 0;
  assert.equal(await task.run(() => { calls++; }), false);
  assert.equal(calls, 0);
  unsubscribe();
});

test('an unloaded detail failure survives reconciliation snapshots without automatic retries', async () => {
  const { task, reconnect } = setup<string>();
  let calls = 0;
  await task.run(async () => {
    calls++;
    throw new IntentHttpError('Native session data is unavailable while unloaded', 409, 'SESSION_UNLOADED');
  });
  for (let patch = 0; patch < 10; patch++) {
    assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), false);
  }
  for (let snapshot = 0; snapshot < 3; snapshot++) {
    reconnect();
    task.deactivate();
    task.activate();
    if (canAutoRefreshSessionResource(task.getSnapshot())) await task.run(async () => { calls++; return 'unexpected'; });
    assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), false);
  }
  assert.equal(calls, 1);
  // Explicit resume can refresh even if authoritative loaded remained true.
  assert.equal(await task.run(async () => { calls++; return 'resumed'; }), true);
  assert.equal(calls, 2);
  assert.equal(task.getSnapshot().data, 'resumed');
  assert.equal(task.getSnapshot().errorCause, undefined);
  assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), true);
});

test('disabling a native resource discards in-flight results and permits a fresh read after resume', async () => {
  const { task } = setup<string>();
  const request = deferred<string>();
  const pending = task.run(() => request.promise);
  task.deactivate(true);
  request.resolve('obsolete runtime');
  assert.equal(await pending, false);
  assert.equal(task.getSnapshot().data, undefined);
  assert.equal(await task.run(() => assert.fail('disabled resource must not query')), false);
  task.activate();
  assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), true);
  assert.equal(await task.run(async () => 'resumed runtime'), true);
  assert.equal(task.getSnapshot().data, 'resumed runtime');
});

test('only unloaded failures block automatic detail refresh; disabling clears the failed-read block', async () => {
  const { task } = setup<string>();
  await task.run(async () => { throw new Error('offline'); });
  assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), true);
  await task.run(async () => { throw new IntentHttpError('unloaded', 409, 'SESSION_UNLOADED'); });
  assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), false);
  task.deactivate(true);
  task.activate();
  assert.equal(canAutoRefreshSessionResource(task.getSnapshot()), true);
});

test('an owner that leaves reports its orphaned mutation outcome once, while orphaned reads stay silent', async t => {
  t.mock.method(console, 'error', () => {});
  let now = 10_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const leave of ['stay', 'unmount', 'reconnect'] as const) {
    for (const kind of ['mutation', 'read'] as const) {
      now += 60_000;
      for (const error of getUxErrors()) dismissUxError(error.id);
      const h = setup<void>();
      const held = deferred<void>();
      const result = h.task.run(() => held.promise, undefined, true);
      if (leave === 'unmount') h.task.deactivate();
      if (leave === 'reconnect') h.reconnect();
      const failure = new Error(`${kind} failed`);
      recordOperationFailure(failure, { message: `${leave} ${kind} outcome`, mutation: kind === 'mutation', uncertain: true });
      held.reject(failure);
      await result;
      const expected = leave !== 'stay' && kind === 'mutation' ? [`${leave} ${kind} outcome`] : [];
      assert.deepEqual(getUxErrors().map(error => error.message), expected, `${leave}/${kind}`);
      // A mounted owner shows the failure itself.
      assert.equal(h.task.getSnapshot().error, leave === 'stay' ? `${kind} failed` : null, `${leave}/${kind}`);
    }
  }
});
