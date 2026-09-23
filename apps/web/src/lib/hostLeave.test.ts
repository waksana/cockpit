import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, Component, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Intents } from '@cockpit/protocol';
import { HOST_INTENT_MUTATES, NetClient } from '../net/client';
import { getSessionDraft, retireDraftSession } from './draftSelection';
import { hasHostLeaveRisk, installHostLeaveProtection, registerHostUnsavedChanges, useHostUnsavedChanges } from './hostLeave';
import { getUxErrors } from './errorReporter';

function fixture(t: TestContext) {
  const handlers = new Set<(event: BeforeUnloadEvent) => void>();
  let adds = 0, removes = 0;
  const target = {
    addEventListener(name: string, handler: (event: BeforeUnloadEvent) => void) {
      assert.equal(name, 'beforeunload'); handlers.add(handler); adds++;
    },
    removeEventListener(name: string, handler: (event: BeforeUnloadEvent) => void) {
      assert.equal(name, 'beforeunload'); handlers.delete(handler); removes++;
    },
  } as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  const cleanup = installHostLeaveProtection(target);
  t.after(cleanup);
  return { handlers, cleanup, counts: () => ({ adds, removes }) };
}

function client(t: TestContext) {
  const value = new NetClient({ onEvent() {}, onStateChange() {} });
  t.after(() => value.disconnect());
  return value;
}

test('every typed intent explicitly classifies reads separately from mutations', () => {
  assert.deepEqual(Object.keys(HOST_INTENT_MUTATES).sort(), Object.keys(Intents).sort());
  for (const name of ['session/chat', 'session/resources', 'fs/listDir', 'roles/readiness', 'skills/read'] as const) {
    assert.equal(HOST_INTENT_MUTATES[name], false, name);
  }
});

test('a dispatched mutation survives view unsubscribe and client disconnect, then known acknowledgement releases guard', async t => {
  const view = fixture(t);
  const draft = getSessionDraft('view-unmount');
  const unmountView = draft.subscribe(() => {});
  const net = client(t);
  let respond!: (value: Response) => void;
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const request = net.setModel('view-unmount', 'native-model');
  assert.equal(view.handlers.size, 1);
  unmountView();
  net.disconnect();
  assert.equal(view.handlers.size, 1);
  let prevented = 0;
  const event = { preventDefault() { prevented++; }, returnValue: 'before' } as unknown as BeforeUnloadEvent;
  for (const handler of view.handlers) handler(event);
  assert.equal(prevented, 1);
  assert.equal(event.returnValue, '');
  assert.equal(fetch.mock.callCount(), 1, 'leave must not retry, cancel, or dispatch anything');
  assert.equal(view.handlers.size, 1, 'cancelled leave does not settle the operation');
  respond(Response.json({ ok: true, result: { status: 'applied' } }));
  await request;
  assert.equal(view.handlers.size, 0);
  assert.equal(hasHostLeaveRisk(), false);
  assert.deepEqual(view.counts(), { adds: 1, removes: 1 });
  retireDraftSession('view-unmount');
});

test('passive reads never install leave listeners, including failures', async t => {
  const view = fixture(t);
  t.mock.method(console, 'error', () => {});
  const net = client(t);
  let respond!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const request = net.listRoles();
  assert.equal(view.handlers.size, 0);
  respond(Response.json({ roles: [] }));
  await request;
  const failed = net.listRoles();
  respond(Response.json({ error: 'Unavailable' }, { status: 503 }));
  await assert.rejects(failed);
  assert.equal(view.handlers.size, 0);
  assert.equal(hasHostLeaveRisk(), false);
});

test('resource preparation is protected until its acknowledged success or known rejection', async t => {
  const view = fixture(t);
  const net = client(t);
  let respond!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  for (const result of [
    { sessionId: 'prepare', ok: true, skills: [], mcpServers: [], tools: 'initialized' },
    { sessionId: 'prepare', ok: false, skills: [], mcpServers: [], tools: 'not_attempted', error: 'Synthetic guard rejection' },
  ]) {
    const request = net.intent('session/resources-prepare', { sessionId: 'prepare' });
    assert.equal(view.handlers.size, 1);
    respond(Response.json(result));
    assert.deepEqual(await request, result);
    assert.equal(view.handlers.size, 0);
    assert.equal(hasHostLeaveRisk(), false);
  }
});

test('entry protection survives a React error boundary unmounting all view-owned forms', async t => {
  const entry = fixture(t);
  const document = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', ownerDocument: document,
    namespaceURI: 'http://www.w3.org/1999/xhtml', textContent: '',
  });
  const globals = {
    document, window: Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const restores = Object.entries(globals).map(([key, value]) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    return () => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key);
  });
  let caught = 0;
  const root = createRoot(container as unknown as HTMLElement, { onCaughtError: () => { caught++; } });
  t.after(async () => {
    await act(async () => root.unmount());
    restores.forEach(restore => restore());
  });
  function Form({ fail }: { fail: boolean }) {
    useHostUnsavedChanges(true);
    if (fail) throw new Error('Synthetic rendering failure');
    return null;
  }
  class Boundary extends Component<{ fail: boolean }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? null : createElement(Form, this.props); }
  }
  await act(async () => root.render(createElement(Boundary, { fail: false })));
  const net = client(t);
  let respond!: (value: Response) => void;
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const request = net.cancel('entry-lifetime');
  await act(async () => root.render(createElement(Boundary, { fail: true })));
  net.disconnect();
  assert.equal(caught, 1);
  assert.equal(entry.handlers.size, 1, 'render failure cannot remove the document guard');
  let prevented = 0;
  for (const handler of entry.handlers) handler({
    preventDefault() { prevented++; }, returnValue: '',
  } as unknown as BeforeUnloadEvent);
  assert.equal(prevented, 1);
  assert.equal(fetch.mock.callCount(), 1, 'fallback and attempted leave never replay work');
  respond(Response.json({ ok: true }));
  await request;
  assert.equal(entry.handlers.size, 0, 'known completion releases the guard without remounting App');
  assert.equal(hasHostLeaveRisk(), false, 'unmounted forms no longer contribute dirty state');
});

test('pre-dispatch validation, serialization, and already aborted calls do not claim dispatched work', async t => {
  const view = fixture(t);
  t.mock.method(console, 'error', () => {});
  const net = client(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Must not dispatch'));
  await assert.rejects(net.prompt('id', '', [{ type: 'file', path: '' }]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(net.intent('cancel', { sessionId: 'id' }, { signal: controller.signal }));
  const cyclic = { sessionId: 'id' } as { sessionId: string; extra?: unknown };
  cyclic.extra = cyclic;
  await assert.rejects(net.intent('cancel', cyclic));
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(view.handlers.size, 0);
});

test('concurrent mutations release individually; acknowledged rejection is not invented success or pending work', async t => {
  const view = fixture(t);
  const net = client(t);
  const responses: ((value: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { responses.push(resolve); }));
  const first = net.cancel('one'), second = net.cancel('two');
  responses[0](Response.json({ ok: false }));
  assert.deepEqual(await first, { ok: false });
  assert.equal(view.handlers.size, 1);
  responses[1](Response.json({ ok: true }));
  await second;
  assert.equal(view.handlers.size, 0);
});

test('forms and hidden genuinely unpersisted drafts compose with cleanup without mutating work', t => {
  const view = fixture(t);
  assert.equal(view.handlers.size, 0);
  const first = registerHostUnsavedChanges(), second = registerHostUnsavedChanges();
  assert.equal(view.handlers.size, 1);
  first(); first();
  assert.equal(view.handlers.size, 1);
  const draft = getSessionDraft('hidden-memory');
  draft.edit('Not persisted without storage');
  second();
  assert.equal(view.handlers.size, 1);
  view.cleanup();
  assert.equal(view.handlers.size, 0);
  assert.equal(draft.getSnapshot().text, 'Not persisted without storage');
  const next = fixture(t);
  assert.equal(next.handlers.size, 1);
  draft.edit('');
  assert.equal(next.handlers.size, 0);
  retireDraftSession('hidden-memory');
});

test('aborting after dispatch keeps uncertainty across disconnect and guard remount without replay', async t => {
  const view = fixture(t);
  t.mock.method(console, 'error', () => {});
  const net = client(t);
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped waiting', 'AbortError')));
  }));
  const request = net.intent('cancel', { sessionId: 'unknown' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, /Stopped waiting/);
  net.disconnect();
  assert.equal(view.handlers.size, 1);
  assert.ok(getUxErrors().some(error => error.message.includes('结果未知：已停止等待')));
  view.cleanup();
  assert.equal(view.handlers.size, 0);
  const remounted = fixture(t);
  assert.equal(remounted.handlers.size, 1);
  for (const handler of remounted.handlers) handler({ preventDefault() {}, returnValue: '' } as BeforeUnloadEvent);
  assert.equal(fetch.mock.callCount(), 1);
});

test('unconfirmed resource preparation receipts keep protection and report uncertainty without replay', async t => {
  const view = fixture(t);
  const net = client(t);
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch');
  const base = { sessionId: 'prepare', ok: false, skills: [], mcpServers: [], tools: 'not_attempted' };
  for (const result of [
    { ...base, skills: [{ name: 'synthetic-skill', effect: 'unconfirmed', enabled: null }] },
    { ...base, mcpServers: [{ name: 'synthetic-mcp', effect: 'unconfirmed', enabled: null, status: null, tools: null }] },
    { ...base, tools: 'unconfirmed' },
  ]) {
    fetch.mock.mockImplementation(async () => Response.json(result));
    const calls = fetch.mock.callCount();
    assert.deepEqual(await net.intent('session/resources-prepare', { sessionId: 'prepare' }), result);
    assert.equal(fetch.mock.callCount(), calls + 1);
    assert.equal(view.handlers.size, 1);
    // Identical unowned uncertainty is one deduplicated global notice.
    assert.equal(getUxErrors().filter(error => error.message.includes('session/resources-prepare：结果未知')).length, 1);
  }
});
