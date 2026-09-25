import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModuleRuntime } from './moduleRuntime';
import { observeModuleView } from './moduleView';
import { createCockpitStore } from '../net/store';
import type { ModuleEventPayload } from '@cockpit/module-api/frontend';
import { EMPTY_CHAT_WINDOW } from './moduleChatWindow';
import { metaToSession } from '../net/sessionWindow';

test('one view bridge projects focus, connection and visibility and releases all subscriptions on remount', t => {
  const store = createCockpitStore();
  const runtime = new ModuleRuntime();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const invalidations: string[] = [];
  t.mock.method(runtime, 'invalidate', (id: string) => { invalidations.push(id); });
  const listeners = new Set<(id: string) => void>();
  const eventListeners = new Set<(id: string, payload: ModuleEventPayload) => void>();
  const events: unknown[] = [];
  t.mock.method(runtime, 'receiveEvent', (id: string, payload: ModuleEventPayload) => { events.push({ id, payload }); });
  store.setState({ activeId: 'first', connState: 'open', onModuleInvalidated: listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, onModuleEvent: listener => {
    eventListeners.add(listener);
    return () => { eventListeners.delete(listener); };
  } });
  for (let cycle = 0; cycle < 2; cycle++) {
    const cleanup = observeModuleView(runtime, store, visibility);
    assert.equal(listeners.size, 1);
    assert.equal(eventListeners.size, 1);
    for (const listener of eventListeners) listener('fixture', { kind: 'payload' });
    assert.deepEqual(events[cycle], { id: 'fixture', payload: { kind: 'payload' } });
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
    cleanup();
    assert.equal(listeners.size, 0);
    assert.equal(eventListeners.size, 0);
    const released = runtime.getViewSnapshot();
    store.setState({ activeId: 'next', connState: 'open' });
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    assert.equal(runtime.getViewSnapshot(), released);
    assert.deepEqual(released, { sessionId: null, visible: false, connected: false });
  }
});

test('the view bridge follows only the active loaded window, including deltas, disconnect and disposal', t => {
  const store = createCockpitStore();
  const runtime = new ModuleRuntime();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const first = {
    ...metaToSession({ sessionId: 'first', title: 'First', cwd: '/synthetic/first', status: 'idle',
      loaded: true, lastActivity: 100, ask: null }),
    materialized: true,
    messages: [{ id: 'row', origin: { sessionId: 'first', messageId: 'native' },
      role: 'assistant' as const, content: 'Initial', timestamp: 100, streaming: true }],
  };
  const second = { ...first, sessionId: 'second', messages: [], materialized: false, loadingHistory: true };
  store.setState({ activeId: 'first', sessions: [first, second], connState: 'open' });
  const cleanup = observeModuleView(runtime, store, visibility);
  t.after(cleanup);
  const initial = runtime.getChatWindowSnapshot();
  assert.equal(initial.messages[0].text, 'Initial');
  assert.equal(initial.messages[0].complete, false);
  store.setState({ globalModels: [] });
  assert.equal(runtime.getChatWindowSnapshot(), initial);
  store.setState({ sessions: [{ ...first, messages: [{ ...first.messages[0], content: 'Finished', streaming: false }] }, second] });
  assert.equal(runtime.getChatWindowSnapshot().messages[0].text, 'Finished');
  assert.equal(runtime.getChatWindowSnapshot().messages[0].complete, true);
  store.setState({ connState: 'connecting' });
  assert.equal(runtime.getChatWindowSnapshot().status, 'stale');
  store.setState({ activeId: 'second', connState: 'open' });
  assert.equal(runtime.getChatWindowSnapshot().sessionId, 'second');
  assert.equal(runtime.getChatWindowSnapshot().status, 'loading');
  assert.deepEqual(runtime.getChatWindowSnapshot().messages, []);
  cleanup();
  assert.equal(runtime.getChatWindowSnapshot(), EMPTY_CHAT_WINDOW);
  store.setState({ activeId: 'first' });
  assert.equal(runtime.getChatWindowSnapshot(), EMPTY_CHAT_WINDOW);
});
