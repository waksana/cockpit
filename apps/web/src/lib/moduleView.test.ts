import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModuleRuntime } from './moduleRuntime';
import { observeModuleView } from './moduleView';
import { createCockpitStore } from '../net/store';

test('one view bridge projects focus, connection and visibility and releases all subscriptions on remount', t => {
  const store = createCockpitStore();
  const runtime = new ModuleRuntime();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const invalidations: string[] = [];
  t.mock.method(runtime, 'invalidate', id => { invalidations.push(id); });
  const listeners = new Set<(id: string) => void>();
  store.setState({ activeId: 'first', connState: 'open', onModuleInvalidated: listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  } });
  for (let cycle = 0; cycle < 2; cycle++) {
    const cleanup = observeModuleView(runtime, store, visibility);
    assert.equal(listeners.size, 1);
    assert.deepEqual(runtime.getViewSnapshot(), { sessionId: store.getState().activeId, visible: true, connected: true });
    const before = runtime.getViewSnapshot();
    store.setState({ globalModels: [] });
    assert.equal(runtime.getViewSnapshot(), before, 'unrelated store updates do not notify module views');
    store.setState({ activeId: 'second', connState: 'connecting' });
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(runtime.getViewSnapshot(), { sessionId: 'second', visible: false, connected: false });
    store.setState({ activeId: null });
    for (const listener of listeners) listener('fixture');
    assert.equal(invalidations.length, cycle + 1);
    cleanup();
    assert.equal(listeners.size, 0);
    const released = runtime.getViewSnapshot();
    store.setState({ activeId: 'next', connState: 'open' });
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    assert.equal(runtime.getViewSnapshot(), released);
    assert.deepEqual(released, { sessionId: null, visible: false, connected: false });
  }
});
