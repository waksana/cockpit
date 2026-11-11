import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModuleDiagnosticHistory, ModuleInventory } from '@cockpit/protocol';
import { ModuleDiagnostics } from './moduleDiagnostics';

const error = {
  id: 'fixture', stage: 'runtime', code: 'OFFLINE', error: 'Offline',
  firstObservedAt: '2026-11-11T00:00:00.000Z', lastObservedAt: '2026-11-11T00:00:10.000Z', count: 2,
};
const errorHistory = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', semantics: 'historical', currentHealth: 'unknown', limit: 100, evicted: 3,
};

test('bootstrap and inventory preserve the same observations and reject invalid evidence', () => {
  const history = { errors: [error], errorHistory };
  assert.deepEqual(ModuleDiagnosticHistory.parse(history), history);
  assert.deepEqual(ModuleInventory.parse({ ...history, active: [], modules: [] }), { ...history, active: [] });
  for (const patch of [{ count: 0 }, { count: 1.1 }, { firstObservedAt: 'yesterday' }, { lastObservedAt: 'invalid' }]) {
    assert.throws(() => ModuleDiagnosticHistory.parse({ ...history, errors: [{ ...error, ...patch }] }));
  }
  assert.throws(() => ModuleDiagnosticHistory.parse({ ...history, errorHistory: { ...errorHistory, currentHealth: 'healthy' } }));
});

test('dismissal is local, stable through reconnect, and a new observation can be shown again', () => {
  const store = new ModuleDiagnostics();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.replace({ errors: [error], errorHistory });
  store.dismiss();
  const dismissed = store.getSnapshot();
  store.replace({ errors: [error], errorHistory, modules: [] });
  assert.equal(store.getSnapshot(), dismissed);
  assert.equal(dismissed.errors.length, 1);
  assert.equal(notifications, 2);
  store.replace({ errors: [{ ...error, count: 3 }], errorHistory });
  assert.equal(store.getSnapshot().dismissed, false);
  assert.equal(store.getSnapshot().errors[0].count, 3);
  store.dismiss();
  store.replace({ errors: [error], errorHistory: { ...errorHistory, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
  assert.equal(store.getSnapshot().dismissed, false, 'a new process is a different history, not recovery');
  unsubscribe();
});

test('older histories do not invent times, codes, counts or recovery', () => {
  const store = new ModuleDiagnostics();
  store.replace({ errors: [{ id: 'legacy', stage: 'activation', error: 'Failed' }] });
  assert.deepEqual(store.getSnapshot(), {
    errors: [{ id: 'legacy', stage: 'activation', error: 'Failed' }], dismissed: false,
  });
  assert.throws(() => store.replace({ errors: [{ id: 'legacy', stage: 'request', error: 'Request failed' }] }));
  assert.equal(store.getSnapshot().errors.length, 1, 'invalid refresh does not erase the previous observation');
});
