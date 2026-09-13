import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { IntentBody, IntentName, IntentResult } from '@cockpit/protocol';
import { CHAT_STREAM_URL, intentUrl } from '../lib/config';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { IntentHttpError, isSessionUnloadedError, SessionUnloadedError } from './client';
import { createCockpitStore } from './store';
import type { NativeAttachment, ChatMessage, ServerEvent, SessionMeta } from './types';
type HistoryFixture = { sessionId: string; messages: ChatMessage[]; hasMore: boolean; latest?: boolean };

type Store = ReturnType<typeof createCockpitStore>;
type State = ReturnType<Store['getState']>;
let useCockpit = createCockpitStore();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function meta(sessionId: string): SessionMeta {
  return {
    sessionId, title: sessionId, cwd: '.', lastActivity: 1,
    status: 'idle', loaded: true, error: null, queue: [], ask: null,
  };
}

function message(id: string, content = id): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1 };
}

function session(id = 'a', store: Store = useCockpit) {
  const result = store.getState().sessions.find((item) => item.sessionId === id);
  assert.ok(result, `Missing session ${id}`);
  return result;
}

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  });
}

let now = 1_000_000;

function setup(t: TestContext, store: Store = (useCockpit = createCockpitStore())) {
  if (typeof document === 'undefined') replaceGlobal(t, 'document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  const requests: {
    url: string;
    init: RequestInit | undefined;
    response: ReturnType<typeof deferred<Response>>;
  }[] = [];
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === CHAT_STREAM_URL
      || (String(input) === intentUrl('session/chat') && JSON.parse(String(init?.body)).direction === 'forward')) {
      // Control tests hold chat reads separately; nativeStore tests inspect their lifecycle.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    const response = deferred<Response>();
    requests.push({ url: String(input), init, response });
    return response.promise;
  });
  now += 60_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    assert.fail(`Unexpected invalid SSE fixture: ${JSON.stringify(args)}`);
  });
  for (const error of getUxErrors()) dismissUxError(error.id);

  const sources: FakeEventSource[] = [];
  class FakeEventSource {
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    constructor() { sources.push(this); }
    close() { this.readyState = FakeEventSource.CLOSED; }
    open() {
      this.readyState = FakeEventSource.OPEN;
      assert.ok(this.onopen);
      this.onopen();
    }
    drop() {
      this.readyState = 0;
      assert.ok(this.onerror);
      this.onerror();
    }
    emit(event: ServerEvent) {
      assert.ok(this.onmessage);
      this.onmessage({ data: JSON.stringify(event) });
    }
  }

  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true, writable: true, value: FakeEventSource,
  });
  const viewers: { store: Store; cleanup: () => void }[] = [];
  t.after(async () => {
    for (const viewer of viewers) viewer.cleanup();
    for (const request of requests) request.response.resolve(Response.json({ ok: true }));
    await setImmediate();
    for (const viewer of viewers) viewer.store.setState(viewer.store.getInitialState());
    for (const error of getUxErrors()) dismissUxError(error.id);
    if (original) Object.defineProperty(globalThis, 'EventSource', original);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  });

  function request(index: number) {
    const result = requests[index];
    assert.ok(result, `Missing POST ${index}`);
    return result;
  }
  function assertPost<K extends IntentName>(index: number, name: K, body: IntentBody<K>) {
    const result = request(index);
    assert.equal(result.url, intentUrl(name));
    let init = result.init;
    if (name === 'session/chat' || name === 'session/get' || name === 'session/resources') {
      assert.ok(init?.signal instanceof AbortSignal, 'native reads must have an abort signal');
      const { signal: _signal, ...rest } = init;
      init = rest;
    }
    const { body: json, ...options } = init ?? {};
    assert.deepEqual(options, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
    assert.equal(typeof json, 'string');
    assert.deepEqual(JSON.parse(json as string), body);
    return result.response;
  }
  async function reply(index: number, body: unknown) {
    request(index).response.resolve(Response.json(body));
    await setImmediate();
  }
  async function history(index: number, page: HistoryFixture) {
    assert.equal(request(index).url, intentUrl('session/chat'));
    const query = JSON.parse(String(request(index).init?.body));
    await reply(index, {
      sessionId: page.sessionId, source: query.source, direction: query.direction, title: page.sessionId, cwd: '.',
      events: page.messages.map(message => ({
        id: `event-${message.id}`, type: `${message.role}.message`, timestamp: message.timestamp,
        data: { messageId: message.id, content: message.content },
      })),
      cursor: `older-${page.messages[0]?.id ?? 'empty'}`, cursorStatus: 'ok', hasMore: page.hasMore,
      ...(query.bootstrap ? { liveCursor: `live-${page.messages.at(-1)?.id ?? 'empty'}` } : {}),
      read: { rpc: query.bootstrap ? 2 : 1, events: page.messages.length },
    });
  }
  function addViewer(next: Store) {
    next.setState(next.getInitialState());
    const sourceIndex = sources.length;
    const disconnect = next.getState().init();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      disconnect();
    };
    viewers.push({ store: next, cleanup });
    assert.equal(sources.length, sourceIndex + 1);
    const source = sources[sourceIndex];
    assert.ok(source);

    function snapshot(
      ids = ['a'],
      extra: Partial<Extract<ServerEvent, { type: 'snapshot' }>> = {},
    ) {
      source.emit({
        type: 'snapshot', agentStatus: 'up', permissionPolicy: 'allow-all',
        models: [], sessions: ids.map(meta), ...extra,
      });
    }
    async function load(id: string, messages: ChatMessage[], hasMore = true) {
      const index = requests.length;
      next.getState().setActiveId(id);
      const loaded = next.getState().sessions.find(session => session.sessionId === id)?.loaded;
      assertPost(index, 'session/chat', { sessionId: id, source: loaded ? 'live' : 'persisted', direction: 'backward',
        max: 32, waitMs: 0, bootstrap: !!loaded, ...(loaded ? { agentScope: 'all' as const } : {}) });
      await history(index, { sessionId: id, messages, hasMore, latest: true });
    }
    function reconnect(ids = ['a']) {
      source.drop();
      assert.equal(next.getState().connState, 'connecting');
      const count = requests.length;
      source.open();
      assert.equal(next.getState().connState, 'open');
      assert.equal(requests.length, count, 'onopen must wait for a fresh snapshot');
      snapshot(ids);
    }
    return { store: next, source, snapshot, load, reconnect, cleanup };
  }
  return {
    ...addViewer(store), sources, requests, request, assertPost, reply, history, addViewer,
  };
}

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

test('native deletion supports unloaded sessions and failures never retry or remove displayed state', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false });
  const deletion = observe(store.getState().deleteSession('a', true));
  h.assertPost(0, 'session/purge', { sessionId: 'a', confirm: true });
  h.request(0).response.resolve(Response.json({ error: 'Native protected work' }, { status: 409 }));
  await assert.rejects(deletion, /Native protected work/);
  await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.equal(session('a', store).sessionId, 'a');
  assert.equal(session('a', store).loaded, false);
  assert.match(session('a', store).error ?? '', /Native protected work/);
});

test('native creation result never invents local session state or sends a hidden message', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open(); h.snapshot([]);
  assert.equal(h.requests.length, 0);
  const creating = store.getState().newSession('/workspace');
  h.assertPost(0, 'session/new', { cwd: '/workspace' });
  await h.reply(0, { sessionId: 'actual-native-id' });
  assert.equal(await creating, 'actual-native-id');
  await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.equal(store.getState().sessions.length, 0, 'native sessions arrive through authoritative control events, not GUI attempts');
});

test('unselected sessions and read-lease patches do not fetch hidden resources or full metadata', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a', 'b']);
  for (const resource of ['plan', 'skills', 'mcp', 'tasks', 'instructions', 'usage', 'models', 'todo'] as const) {
    h.source.emit({ type: 'session/invalidated', sessionId: 'b', resources: [resource] });
  }
  h.source.emit({ type: 'session/patch', sessionId: 'b', activeOperations: 1 });
  h.source.emit({ type: 'session/patch', sessionId: 'b', activeOperations: 0 });
  await setImmediate();
  assert.equal(h.requests.length, 0);
  assert.equal(store.getState().resourceRevisions.b?.tasks, 1);
  h.source.emit({ type: 'session/invalidated', sessionId: 'b', resources: ['schedule'] });
  await setImmediate();
  h.assertPost(0, 'session/resources', { sessionId: 'b', resources: ['schedule'] });
  await h.reply(0, { meta: { sessionId: 'b', loaded: true, scheduleCount: 2 } });
  assert.equal(session('b', store).scheduleCount, 2);
  assert.equal(session('b', store).title, 'b', 'narrow projection must not erase identity');
});

test('late resource changes rerun only their dependency and retain independent fresh fields and decision patches', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model', 'schedule'] });
  await setImmediate();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['schedule'] });
  h.source.emit({ type: 'session/patch', sessionId: 'a', activeOperations: 1, ask: { requestId: 'fresh-ask', question: 'Continue?' } });
  await h.reply(0, { meta: { sessionId: 'a', loaded: true, currentModelId: 'fresh-model', scheduleCount: 1,
    activeOperations: 0, ask: null } });
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['schedule'] });
  assert.equal(session('a', store).currentModelId, 'fresh-model');
  assert.equal(session('a', store).scheduleCount, undefined, 'obsolete schedule count is never published');
  assert.equal(session('a', store).ask?.requestId, 'fresh-ask');
  assert.equal(session('a', store).activeOperations, 1);
  await h.reply(1, { meta: { sessionId: 'a', loaded: true, scheduleCount: 2 } });
  assert.equal(session('a', store).scheduleCount, 2);
  assert.equal(h.requests.length, 2);
});

test('source changes fence narrow requests and clear stale native fields immediately', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a'], { sessions: [{ ...meta('a'), currentModelId: 'old', availableModels: [], scheduleCount: 2 }] });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model'] });
  await setImmediate();
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false, status: 'unloaded', ask: null });
  assert.equal(h.request(0).init?.signal?.aborted, true);
  assert.equal(session('a', store).availableModels, undefined);
  assert.equal(session('a', store).scheduleCount, undefined);
  await h.reply(0, { meta: { sessionId: 'a', loaded: true, currentModelId: 'obsolete' } });
  assert.equal(session('a', store).currentModelId, undefined);
  assert.equal(session('a', store).loaded, false);
});

test('queue invalidations discard old selected reads after navigation without reading the hidden queue', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a', 'b']);
  store.setState({ activeId: 'a' });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['queue'] });
  await setImmediate();
  store.setState({ activeId: 'b' });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['control', 'queue'] });
  await h.reply(0, { meta: { sessionId: 'a', loaded: true, queue: [{ id: 'removed', text: 'obsolete' }] } });
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['control'] });
  await h.reply(1, { meta: { sessionId: 'a', loaded: true, status: 'idle' } });
  assert.equal(session('a', store).queue, undefined);
  store.getState().setActiveId('a');
  await setImmediate();
  assert.ok(h.requests.slice(2).some(request => request.url === intentUrl('session/resources')
    && JSON.parse(String(request.init?.body)).resources.join() === 'queue'));
  assert.equal(session('a', store).queue, undefined);
});
test('native metadata invalidations read only the affected session and discard superseded responses', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a', 'b']);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.assertPost(0, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model', 'mode', 'schedule'] });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await h.reply(0, { meta: { ...meta('a'), currentModelId: 'obsolete' } });
  assert.notEqual(session('a', store).currentModelId, 'obsolete');
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model', 'mode', 'schedule'] });
  await h.reply(1, { meta: { ...meta('a'), currentModelId: 'current' } });
  assert.equal(session('a', store).currentModelId, 'current');
  assert.equal(session('b', store).currentModelId, undefined);
  assert.equal(h.requests.length, 2);
});

test('unloaded native responses clear runtime values without global defaults or implicit resume', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a'], { sessions: [{ ...meta('a'), currentModelId: 'old', currentMode: 'plan', scheduleCount: 2 }] });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  const unloaded = { sessionId: 'a', title: 'a', cwd: '.', lastActivity: 1, status: 'unloaded', loaded: false, error: null, ask: null };
  await h.reply(0, { meta: unloaded });
  assert.equal(session('a', store).loaded, false);
  for (const key of ['currentModelId', 'currentMode', 'scheduleCount', 'queue']) {
    assert.equal(key in session('a', store), false, key);
  }
  assert.equal(h.requests.length, 1);
});

test('closing invalidations wait for the settling event rather than entering teardown', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/patch', sessionId: 'a', closing: true });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  assert.equal(h.requests.length, 0);
  h.source.emit({ type: 'session/patch', sessionId: 'a', closing: false });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.assertPost(0, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model', 'mode', 'schedule'] });
  await h.reply(0, { meta: { ...meta('a'), loaded: false, status: 'unloaded' } });
  assert.equal(session('a', store).loaded, false);
});

test('removed sessions and reconnected snapshots invalidate in-flight native metadata reads', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a', 'b']);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.source.emit({ type: 'session/removed', sessionId: 'a' });
  assert.equal(h.request(0).init?.signal?.aborted, true);
  await h.reply(0, { meta: { ...meta('a'), title: 'must not return' } });
  assert.equal(store.getState().sessions.some(row => row.sessionId === 'a'), false);
  h.source.emit({ type: 'session/invalidated', sessionId: 'b' });
  await setImmediate();
  h.snapshot(['b'], { sessions: [{ ...meta('b'), title: 'new snapshot' }] });
  assert.equal(h.request(1).init?.signal?.aborted, true);
  await h.reply(1, { meta: { ...meta('b'), title: 'old request' } });
  assert.equal(session('b', store).title, 'new snapshot');
});

test('failed native metadata reads surface an error and never silently retry', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.request(0).response.resolve(Response.json({ error: 'Native state unavailable' }, { status: 503 }));
  await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.ok(getUxErrors().some(error => JSON.stringify(error).includes('读取会话状态失败')));
});

test('a failed old metadata request does not discard a newer settling invalidation', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.source.emit({ type: 'session/patch', sessionId: 'a', closing: true });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  h.source.emit({ type: 'session/patch', sessionId: 'a', closing: false });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  h.request(0).response.resolve(Response.json({ error: 'Transition in progress', code: 'SESSION_TRANSITION' }, { status: 409 }));
  await setImmediate();
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model', 'mode', 'schedule'] });
  await h.reply(1, { meta: { ...meta('a'), title: 'after transition' } });
  assert.equal(session('a', store).title, 'after transition');
  assert.equal(h.requests.length, 2);
});

test('native metadata readback preserves same-connection intent and compaction signals until completion or unload', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/patch', sessionId: 'a', intent: 'Synthetic intent', compacting: true });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  await h.reply(0, { meta: meta('a') });
  assert.equal(session('a', store).intent, 'Synthetic intent');
  assert.equal(session('a', store).compacting, true);
  h.source.emit({ type: 'session/patch', sessionId: 'a', compacting: false });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  await h.reply(1, { meta: meta('a') });
  assert.equal(session('a', store).compacting, false);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  await h.reply(2, { meta: { ...meta('a'), loaded: false, status: 'unloaded' } });
  assert.equal(session('a', store).intent, undefined);
  assert.equal(session('a', store).compacting, undefined);
});

test('native getters without an error projection do not erase a live frontend error', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/patch', sessionId: 'a', error: 'Native turn failed' });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  const { error: _error, ...fresh } = meta('a');
  await h.reply(0, { meta: fresh });
  assert.equal(session('a', store).error, 'Native turn failed');
  h.source.emit({ type: 'session/patch', sessionId: 'a', error: null });
  assert.equal(session('a', store).error, null);
});

test('one late mutation failure retains its dispatch source and one global report after navigation', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b'], { sessions: [{ ...meta('a'), title: 'Original A' }, meta('b')] });
  const failure = new Error('held tool update denied');
  const pending = useCockpit.getState().mcpToggleSession('a', 'original-tool', false);
  const rejected = assert.rejects(pending, error => error === failure);
  const response = h.assertPost(0, 'mcp/session-toggle', { sessionId: 'a', name: 'original-tool', on: false });
  h.source.emit({ type: 'session/patch', sessionId: 'a', title: 'New A title' });
  await h.load('b', [message('b')]);
  response.reject(failure);
  await rejected;
  await setImmediate();
  assert.equal(getUxErrors().length, 1);
  assert.match(getUxErrors()[0].message, /Original A.*\(a\).*original-tool.*mcp\/session-toggle.*held tool update denied/);
  assert.doesNotMatch(getUxErrors()[0].message, /New A title/);
  assert.equal(useCockpit.getState().activeId, 'b');
  assert.equal(session('b').error, null);
  assert.match(session('a').error ?? '', /Original A.*original-tool.*held tool update denied/);
  assert.equal(h.requests.length, 2, 'one mutation plus B history; no automatic retry');
});

test('two distinct commands with identical rejection text each produce one global notice', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot();
  const first = useCockpit.getState().mcpToggleSession('a', 'fixture-tool', false);
  const second = useCockpit.getState().mcpToggleSession('a', 'fixture-tool', false);
  const rejected = [assert.rejects(first, /independent failure/), assert.rejects(second, /independent failure/)];
  for (const request of h.requests) request.response.resolve(Response.json({ error: 'independent failure' }, { status: 500 }));
  await Promise.all(rejected);
  await setImmediate();
  assert.equal(getUxErrors().length, 2);
  assert.equal(getUxErrors()[0].message, getUxErrors()[1].message);
  assert.equal(h.requests.length, 2);
});

function expectRejection(promise: Promise<unknown>, matcher?: RegExp) {
  return observe(matcher ? assert.rejects(promise, matcher) : assert.rejects(promise));
}

async function expectOffline(
  h: ReturnType<typeof setup>, send: () => Promise<unknown>, returnsNull = false,
) {
  const before = h.requests.length;
  const pending = observe(send());
  const checked = returnsNull
    ? observe(pending.then((value) => assert.equal(value, null)))
    : expectRejection(pending, /未连接/);
  await setImmediate();
  const unexpected = h.requests.slice(before);
  for (const request of unexpected) request.response.reject(new Error('未连接: unexpected disconnected POST'));
  await checked;
  assert.equal(unexpected.length, 0, 'disconnected operations must not POST');
}

const submissions: {
  name: IntentName;
  body: IntentBody<'prompt' | 'respondAsk' | 'respondPlan' | 'planSupersede' | 'respondElicitation'>;
  send: () => Promise<boolean>;
}[] = [
  {
    name: 'prompt', body: { sessionId: 'a', text: 'keep this draft' },
    send: () => useCockpit.getState().sendPrompt('a', 'keep this draft'),
  },
  {
    name: 'respondAsk', body: { sessionId: 'a', requestId: 'ask', answer: 'custom answer', wasFreeform: true },
    send: () => useCockpit.getState().respondAsk('a', 'ask', 'custom answer', true),
  },
  {
    name: 'respondPlan', body: { sessionId: 'a', requestId: 'plan', action: 'autopilot' },
    send: () => useCockpit.getState().respondPlan('a', 'plan', 'autopilot'),
  },
  {
    name: 'planSupersede', body: { sessionId: 'a', requestId: 'plan', message: 'revised instructions' },
    send: () => useCockpit.getState().planSupersede('a', 'plan', 'revised instructions'),
  },
  {
    name: 'respondElicitation', body: { sessionId: 'a', requestId: 'elicitation', action: 'accept' },
    send: () => useCockpit.getState().respondElicitation('a', 'elicitation', 'accept'),
  },
];

for (const submission of submissions) {
  test(`${submission.name} acknowledges true only after POST and its JSON body resolve`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const before = session();
    let settled = false;
    const pending = submission.send().then((result) => { settled = true; return result; });
    const response = h.assertPost(0, submission.name, submission.body);
    await setImmediate();
    assert.equal(settled, false);
    assert.strictEqual(session(), before, 'sending must not optimistically modify the projection');

    const json = deferred<{ ok: boolean }>();
    const http = Response.json({ ok: true });
    t.mock.method(http, 'json', () => json.promise);
    response.resolve(http);
    await setImmediate();
    assert.equal(settled, false, 'HTTP headers alone are not an acknowledgement');
    json.resolve({ ok: true });
    assert.equal(await pending, true);
    assert.strictEqual(session(), before);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(getUxErrors(), []);
  });

  for (const failure of ['rejected', 'transport', 'HTTP', 'ok:false', 'invalid acknowledgement'] as const) {
    test(`${submission.name} returns false for ${failure}, with local errors and no retry or prompt`, async (t) => {
      const h = setup(t);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      h.source.open();
      h.snapshot(['a', 'b']);
      const other = session('b');
      const before = session();
      const pending = submission.send();
      const response = h.assertPost(0, submission.name, submission.body);
      if (failure === 'rejected') response.reject(new Error('denied'));
      else if (failure === 'transport') response.reject(new TypeError('offline'));
      else if (failure === 'HTTP') response.resolve(Response.json({ error: 'denied' }, { status: 403 }));
      else response.resolve(Response.json({ ok: failure === 'ok:false' ? false : 'true' }));

      assert.equal(await pending, false);
      assert.match(session().error ?? '', /未确认发送/);
      assert.match(session().error ?? '', /草稿已保留/);
      assert.deepEqual(session(), { ...before, error: session().error });
      assert.strictEqual(session('b'), other);
      const diagnostics = getUxErrors();
      assert.equal(diagnostics.length, failure === 'ok:false' ? 0 : 1);
      if (diagnostics.length) assert.ok(diagnostics[0].message.includes(submission.name));
      t.mock.timers.tick(60_000);
      await setImmediate();
      assert.equal(h.requests.length, 1);
      h.assertPost(0, submission.name, submission.body);
    });
  }

  test(`${submission.name} returns false without POST while offline or after cleanup`, async (t) => {
    const h = setup(t);
    h.snapshot();
    assert.equal(await submission.send(), false);
    assert.match(session().error ?? '', /未连接/);
    h.source.open();
    h.source.drop();
    assert.equal(await submission.send(), false);
    h.cleanup();
    assert.equal(await submission.send(), false);
    await setImmediate();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(getUxErrors(), []);
  });
}

test('a late failed send survives cached reentry and an obsolete response for another session', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  await h.load('a', [message('old')]);
  const pending = useCockpit.getState().sendPrompt('a', 'keep caption');
  useCockpit.getState().setActiveId('b');
  useCockpit.getState().setActiveId('a');
  await h.reply(1, { ok: false });
  assert.equal(await pending, false);
  const diagnostic = session().error;
  assert.match(diagnostic ?? '', /草稿已保留/);
  await h.history(2, { sessionId: 'b', messages: [message('obsolete')], hasMore: false });
  assert.equal(session().error, diagnostic);
  assert.deepEqual(session().messages, [message('old')]);
  assert.deepEqual(session('b').messages, []);
});

test('each connecting callback and every snapshot increments generation, including open-to-open snapshots', (t) => {
  const h = setup(t);
  let generation = useCockpit.getState().connectionGeneration;
  assert.ok(Number.isInteger(generation));
  h.source.drop();
  assert.equal(useCockpit.getState().connectionGeneration, ++generation);
  h.source.drop();
  assert.equal(useCockpit.getState().connectionGeneration, ++generation);
  h.source.open();
  assert.equal(useCockpit.getState().connectionGeneration, generation);
  h.snapshot();
  assert.equal(useCockpit.getState().connectionGeneration, ++generation);
  h.snapshot();
  assert.equal(useCockpit.getState().connState, 'open');
  assert.equal(useCockpit.getState().connectionGeneration, generation + 1);
});

test('native title updates target their session without changing another route', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  await h.load('b', [message('b-message')], false);
  const other = session('b');
  h.source.emit({ type: 'session/patch', sessionId: 'a', title: 'Newer manual name' });
  assert.equal(useCockpit.getState().activeId, 'b');
  assert.equal(session().title, 'Newer manual name');
  assert.strictEqual(session('b'), other);
  assert.equal(h.requests.length, 1);
});

interface MutationCase {
  name: IntentName;
  body: IntentBody<IntentName>;
  send: (state: State) => Promise<void>;
  success: unknown;
  sessionId?: string;
  changesHistory?: boolean;
}

const mcpSuccess: IntentResult<'mcp/session-toggle'> = {
  ok: true, applied: true, sessionId: 'a', name: 'fixture-mcp', enabled: true, status: 'connected',
  operation: { id: 'operation', desiredEnabled: true, state: 'succeeded', startedAt: 1, status: 'connected' },
};

const mutations: MutationCase[] = [
  { name: 'cancel', body: { sessionId: 'a' }, send: (s) => s.cancel('a'), success: { ok: true }, sessionId: 'a' },
  {
    name: 'setModel', body: { sessionId: 'a', modelId: 'model', reasoningEffort: 'high', contextTier: 'long_context' },
    send: (s) => s.setModel('a', 'model', { reasoningEffort: 'high', contextTier: 'long_context' }),
    success: { ok: true }, sessionId: 'a',
  },
  { name: 'session/purge', body: { sessionId: 'a', confirm: true }, send: (s) => s.deleteSession('a', true), success: { ok: true }, sessionId: 'a' },
  { name: 'session/unload', body: { sessionId: 'a' }, send: (s) => s.unloadSession('a'), success: { ok: true }, sessionId: 'a' },
  {
    name: 'session/reload', body: { sessionId: 'a' }, send: (s) => s.reloadSession('a'),
    success: { ok: true }, sessionId: 'a', changesHistory: true,
  },
  {
    name: 'session/compact', body: { sessionId: 'a' }, send: (s) => s.compactSession('a'),
    success: { ok: true }, sessionId: 'a', changesHistory: true,
  },
  {
    name: 'session/rewind', body: { sessionId: 'a', toMsgId: 'anchor' }, send: (s) => s.rewindSession('a', 'anchor'),
    success: { ok: true }, sessionId: 'a', changesHistory: true,
  },
  { name: 'setMode', body: { sessionId: 'a', mode: 'plan' }, send: (s) => s.setMode('a', 'plan'), success: { ok: true }, sessionId: 'a' },
  {
    name: 'queue/remove', body: { sessionId: 'a', itemId: 'queued' }, send: (s) => s.removeQueued('a', 'queued'),
    success: { ok: true }, sessionId: 'a',
  },
  { name: 'session/refresh', body: {}, send: (s) => s.refreshList(), success: { ok: true } },
  { name: 'mcp/global-default', body: { name: 'fixture-mcp', on: true }, send: (s) => s.mcpSetDefault('fixture-mcp', true), success: { ok: true } },
  { name: 'mcp/refresh', body: {}, send: (s) => s.mcpRefresh(), success: { ok: true } },
  {
    name: 'skills/global-toggle', body: { name: 'fixture-skill', enabled: false },
    send: (s) => s.skillsSetGlobal('fixture-skill', false), success: { ok: true },
  },
  {
    name: 'mcp/session-toggle', body: { sessionId: 'a', name: 'fixture-mcp', on: true },
    send: (s) => s.mcpToggleSession('a', 'fixture-mcp', true), success: mcpSuccess, sessionId: 'a',
  },
  {
    name: 'skills/session-toggle', body: { sessionId: 'a', name: 'fixture-skill', enabled: false },
    send: (s) => s.skillsToggleSession('a', 'fixture-skill', false), success: { ok: true }, sessionId: 'a',
  },
];

for (const kind of ['MCP', 'Skill'] as const) {
  for (const failure of ['ok:false', 'HTTP', 'rejected'] as const) {
    test(`global ${kind} late ${failure} keeps complete dispatch name and one report after selecting Q`, async t => {
      const h = setup(t);
      h.source.open();
      h.snapshot(['a', 'b']);
      const name = 'P-项目中文长名称/review-source & <tools> "目录"';
      const cwd = '/original/discovery';
      const pending = kind === 'MCP'
        ? useCockpit.getState().mcpSetDefault(name, true)
        : useCockpit.getState().skillsSetGlobal(name, false, cwd);
      const response = h.assertPost(0, kind === 'MCP' ? 'mcp/global-default' : 'skills/global-toggle',
        kind === 'MCP' ? { name, on: true } : { name, enabled: false, cwd });
      useCockpit.setState({ activeId: 'b' });
      const other = session('b');
      const original = new Error('original transport failure');
      const rejected = assert.rejects(pending, error => failure === 'rejected'
        ? error === original
        : error instanceof Error && error.message === (failure === 'HTTP' ? 'permission denied' : '服务器未确认操作'));
      if (failure === 'rejected') response.reject(original);
      else if (failure === 'HTTP') response.resolve(Response.json({ error: 'permission denied' }, { status: 500 }));
      else response.resolve(Response.json({ ok: false }));
      await rejected;
      assert.equal(getUxErrors().length, 1);
      assert.ok(getUxErrors()[0].message.includes(name));
      if (failure === 'ok:false') assert.equal(getUxErrors()[0].message, `设置 Copilot 全局 ${kind} ${name}失败：服务器未确认操作`);
      else assert.ok(getUxErrors()[0].message.startsWith(`${name}：接口 `));
      assert.strictEqual(session('b'), other);
      assert.equal(useCockpit.getState().activeId, 'b');
      assert.equal(h.requests.length, 1);
    });
  }
  test(`global ${kind} separate void negative acknowledgements each report their dispatch name once`, async t => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    for (const name of ['P-文档工具', 'Q-其它工具']) {
      if (kind === 'MCP') void useCockpit.getState().mcpSetDefault(name, true);
      else void useCockpit.getState().skillsSetGlobal(name, false);
    }
    for (let i = 0; i < 2; i++) h.assertPost(i, kind === 'MCP' ? 'mcp/global-default' : 'skills/global-toggle',
      kind === 'MCP' ? { name: i === 0 ? 'P-文档工具' : 'Q-其它工具', on: true }
        : { name: i === 0 ? 'P-文档工具' : 'Q-其它工具', enabled: false }).resolve(Response.json({ ok: false }));
    await setImmediate();
    assert.equal(getUxErrors().length, 2);
    assert.ok(getUxErrors().some(e => e.message.includes('P-文档工具')));
    assert.ok(getUxErrors().some(e => e.message.includes('Q-其它工具')));
    assert.equal(h.requests.length, 2);
  });
}

for (const reject of [false, true]) {
  test(`interrupt keeps session ownership after navigation with late ${reject ? 'failure' : 'false ACK'}`, async t => {
    const h = setup(t);
    h.source.open();
    h.snapshot(['a', 'b']);
    const beforeA = session('a');
    const beforeB = session('b');
    const pending = useCockpit.getState().interrupt('a');
    const rejected = reject ? assert.rejects(pending, /uncertain/) : null;
    const response = h.assertPost(0, 'session/interrupt', { sessionId: 'a' });
    useCockpit.setState({ activeId: 'b' });
    if (reject) response.reject(new Error('uncertain'));
    else response.resolve(Response.json({ ok: true, interrupted: false }));
    if (rejected) await rejected;
    else assert.deepEqual(await pending, { ok: true, interrupted: false });
    assert.deepEqual(session('a'), beforeA);
    assert.deepEqual(session('b'), beforeB);
    assert.equal(h.requests.length, 1);
  });
}

test('interrupt never resumes an unloaded session or sends while disconnected', async t => {
  const h = setup(t);
  await assert.rejects(useCockpit.getState().interrupt('a'), /未连接/);
  h.source.open();
  h.snapshot(['a'], { sessions: [{ ...meta('a'), loaded: false, status: 'unloaded' }] });
  await assert.rejects(useCockpit.getState().interrupt('a'), SessionUnloadedError);
  assert.equal(h.requests.length, 0);
});

for (const mutation of mutations) {
  test(`${mutation.name} returns Promise<void> and waits for JSON acknowledgement without optimistic domain changes`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot(['a', 'b']);
    const before = session();
    const other = session('b');
    const pending: Promise<void> = mutation.send(useCockpit.getState());
    assert.ok(pending instanceof Promise);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const response = h.assertPost(0, mutation.name, mutation.body);
    await setImmediate();
    assert.equal(settled, false);
    const json = deferred<unknown>();
    const http = Response.json({});
    t.mock.method(http, 'json', () => json.promise);
    response.resolve(http);
    await setImmediate();
    assert.equal(settled, false);
    json.resolve(mutation.success);
    assert.equal(await pending, undefined);
    assert.equal(session().title, before.title);
    assert.equal(session().status, before.status);
    assert.equal(session().loaded, before.loaded);
    assert.equal(session().currentModelId, before.currentModelId);
    assert.equal(session().currentMode, before.currentMode);
    assert.deepEqual(session().queue, before.queue);
    assert.deepEqual(session().messages, before.messages);
    assert.strictEqual(session('b'), other);
    assert.equal(useCockpit.getState().activeId, null);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(getUxErrors(), []);
  });

  for (const failure of ['rejected', 'transport', 'HTTP', 'ok:false', 'invalid acknowledgement'] as const) {
    test(`${mutation.name} rejects its original promise on ${failure} and reports local diagnostics`, async (t) => {
      const h = setup(t);
      h.source.open();
      h.snapshot(['a', 'b']);
      const before = session();
      const other = session('b');
      const pending = mutation.send(useCockpit.getState());
      assert.ok(pending instanceof Promise);
      const rejected = expectRejection(pending);
      const response = h.assertPost(0, mutation.name, mutation.body);
      if (failure === 'rejected') response.reject(new Error('denied'));
      else if (failure === 'transport') response.reject(new TypeError('offline'));
      else if (failure === 'HTTP') response.resolve(Response.json({ error: 'denied' }, { status: 403 }));
      else response.resolve(Response.json({ ...mutation.success as object, ok: failure === 'ok:false' ? false : 'true' }));
      await rejected;
      await setImmediate();
      assert.ok(getUxErrors().length > 0);
      if (mutation.sessionId) assert.ok(session().error);
      assert.deepEqual(session().messages, before.messages);
      assert.equal(session().title, before.title);
      assert.equal(session().loadingHistory, false);
      assert.strictEqual(session('b'), other);
      assert.equal(h.requests.length, 1);
    });
  }

  test(`${mutation.name} remains safe when void-called and its unobserved original promise rejects`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    void mutation.send(useCockpit.getState());
    h.assertPost(0, mutation.name, mutation.body).reject(new Error('void-call denied'));
    await setImmediate();
    await setImmediate();
    assert.ok(getUxErrors().some((error) => error.message.includes('void-call denied')));
    if (mutation.sessionId) assert.match(session().error ?? '', /void-call denied/);
    assert.equal(h.requests.length, 1);
  });

  test(`${mutation.name} rejects rather than succeeding while uninitialized, connecting, dropped or cleaned up`, async (t) => {
    const h = setup(t);
    const fresh = createCockpitStore();
    await expectOffline(h, () => mutation.send(fresh.getState()));
    h.snapshot();
    await expectOffline(h, () => mutation.send(useCockpit.getState()));
    h.source.open();
    h.source.drop();
    await expectOffline(h, () => mutation.send(useCockpit.getState()));
    h.cleanup();
    await expectOffline(h, () => mutation.send(useCockpit.getState()));
    assert.equal(h.requests.length, 0);
  });
}

test('MCP toggle ok:true with applied:false still rejects and surfaces the operation error', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot();
  const pending = useCockpit.getState().mcpToggleSession('a', 'fixture-mcp', true);
  const rejected = expectRejection(pending, /not applied/);
  await h.reply(0, { ...mcpSuccess, applied: false, error: 'not applied' });
  await rejected;
  assert.match(session().error ?? '', /not applied/);
  assert.ok(getUxErrors().some((error) => error.message.includes('not applied')));
});

interface ResourceCase {
  label: string;
  name: IntentName;
  body: IntentBody<IntentName>;
  read: (state: State) => Promise<unknown>;
  response: unknown;
  expected: unknown;
}

const plan: IntentResult<'session/plan'> = {
  planMarkdown: 'fixture plan', todos: [{ id: 'todo', title: 'Read fixture', status: 'pending' }],
};
const panels: IntentResult<'session/panels'> = {
  skills: [], mcpServers: [], tasks: [], instructionSources: [], schedules: [],
};
const schedule: IntentResult<'schedule/list'>['entries'][number] = {
  id: 7, prompt: 'fixture reminder', recurring: true, nextRunAt: 1234, intervalMs: 60_000,
};
const globalMcp: IntentResult<'mcp/global'>['servers'] = [
  { name: 'fixture-mcp', detail: 'fixture command', defaultOn: true },
];
const sessionMcp: IntentResult<'mcp/session'>['servers'] = [
  { name: 'fixture-mcp', detail: 'fixture command', status: 'connected', enabled: true },
];
const globalSkills: IntentResult<'skills/global'>['skills'] = [{ name: 'fixture-skill', description: 'fixture', enabled: false }];
const sessionSkills: IntentResult<'skills/session'>['skills'] = [{ name: 'fixture-skill', enabled: true }];
const skill: IntentResult<'skills/read'> = { name: 'fixture-skill', body: 'fixture body', enabled: false };
const directory: IntentResult<'fs/listDir'> = { path: '/fixture', parent: '/', entries: [] };
const resources: ResourceCase[] = [
  { label: 'getPlan', name: 'session/plan', body: { sessionId: 'a' }, read: (s) => s.getPlan('a'), response: plan, expected: plan },
  { label: 'getPanels', name: 'session/panels', body: { sessionId: 'a' }, read: (s) => s.getPanels('a'), response: panels, expected: panels },
  { label: 'scheduleList', name: 'schedule/list', body: { sessionId: 'a' }, read: (s) => s.scheduleList('a'), response: { entries: [schedule] }, expected: [schedule] },
  {
    label: 'scheduleAdd', name: 'schedule/add', body: { prompt: 'fixture reminder', interval: '1m', sessionId: 'a' },
    read: (s) => s.scheduleAdd('a', { prompt: 'fixture reminder', interval: '1m' }),
    response: { ok: true, entry: schedule }, expected: { ok: true, entry: schedule },
  },
  { label: 'scheduleStop', name: 'schedule/stop', body: { sessionId: 'a', id: 7 }, read: (s) => s.scheduleStop('a', 7), response: { ok: true }, expected: { ok: true } },
  { label: 'mcpGlobal', name: 'mcp/global', body: {}, read: (s) => s.mcpGlobal(), response: { servers: globalMcp }, expected: globalMcp },
  { label: 'mcpSession', name: 'mcp/session', body: { sessionId: 'a' }, read: (s) => s.mcpSession('a'), response: { loaded: true, servers: sessionMcp }, expected: sessionMcp },
  { label: 'skillsGlobal()', name: 'skills/global', body: {}, read: (s) => s.skillsGlobal(), response: { skills: globalSkills }, expected: globalSkills },
  { label: 'skillsGlobal(cwd)', name: 'skills/global', body: { cwd: './fixture' }, read: (s) => s.skillsGlobal('./fixture'), response: { skills: globalSkills }, expected: globalSkills },
  { label: 'skillsRead', name: 'skills/read', body: { name: 'fixture-skill' }, read: (s) => s.skillsRead('fixture-skill'), response: skill, expected: skill },
  { label: 'skillsRead(cwd)', name: 'skills/read', body: { name: 'fixture-skill', cwd: './fixture' }, read: (s) => s.skillsRead('fixture-skill', './fixture'), response: skill, expected: skill },
  { label: 'skillsSession', name: 'skills/session', body: { sessionId: 'a' }, read: (s) => s.skillsSession('a'), response: { skills: sessionSkills }, expected: sessionSkills },
  { label: 'listDir()', name: 'fs/listDir', body: {}, read: (s) => s.listDir(), response: directory, expected: directory },
  { label: 'listDir(path)', name: 'fs/listDir', body: { path: '/fixture' }, read: (s) => s.listDir('/fixture'), response: directory, expected: directory },
];

const nativeResources = resources.filter((r) =>
  ['session/plan', 'session/panels', 'mcp/session', 'skills/session', 'schedule/list'].includes(r.name));
const unloadedMessage = 'Native session data is unavailable while unloaded; explicitly resume the session first.';
const unloadedResponse = () => Response.json({
  code: 'SESSION_UNLOADED', message: unloadedMessage,
}, { status: 409 });

test('scheduleList keeps self-paced and ordinary timing metadata through the Web client and store', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a']);
  const entries = [
    { id: 1, prompt: 'model controlled', recurring: true, selfPaced: true, nextRunAt: 123 },
    { ...schedule, selfPaced: false },
    { id: 3, prompt: 'once', recurring: false, at: 123, nextRunAt: 123 },
  ];
  const listing = useCockpit.getState().scheduleList('a');
  h.assertPost(0, 'schedule/list', { sessionId: 'a' }).resolve(Response.json({ entries }));
  assert.deepEqual(await listing, entries);
  assert.equal(h.requests.length, 1);
});

for (const resource of nativeResources) {
  for (const state of ['unloaded', 'missing loaded', 'missing session'] as const) {
    test(`${resource.label} rejects ${state} locally without POST, diagnostics or invented state`, async (t) => {
      const h = setup(t);
      h.source.open();
      h.snapshot([], { sessions: state === 'missing session' ? [] : [{ ...meta('a'), loaded: false }] });
      if (state === 'missing loaded') {
        const row = { ...session() };
        Reflect.deleteProperty(row, 'loaded');
        useCockpit.setState({ sessions: [row] });
      }
      const before = useCockpit.getState().sessions;
      await assert.rejects(resource.read(useCockpit.getState()), (error: unknown) => {
        assert.ok(error instanceof SessionUnloadedError);
        assert.equal(isSessionUnloadedError(error), true);
        assert.match(error.message, /会话.*未加载.*请先.*恢复/);
        assert.equal(error instanceof IntentHttpError, false, 'local guards must not fabricate an HTTP conflict');
        return true;
      });
      assert.strictEqual(useCockpit.getState().sessions, before);
      assert.equal(h.requests.length, 0);
      assert.deepEqual(getUxErrors(), []);
    });
  }

  test(`${resource.label} reconciles a real unloaded race once without guessing loaded or retrying`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const before = session();
    const checked = observe(assert.rejects(resource.read(useCockpit.getState()), (error: unknown) => {
      assert.ok(error instanceof IntentHttpError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'SESSION_UNLOADED');
      assert.equal(error.message, unloadedMessage);
      return true;
    }));
    h.assertPost(0, resource.name, resource.body).resolve(unloadedResponse());
    await checked;
    h.assertPost(1, 'session/refresh', {});
    assert.strictEqual(session(), before);
    assert.equal(session().loaded, true);
    await h.reply(1, { ok: true });
    assert.strictEqual(session(), before, 'refresh ACK alone is not authoritative metadata');
    h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false });
    assert.equal(session().loaded, false);
    await assert.rejects(resource.read(useCockpit.getState()), SessionUnloadedError);
    assert.equal(h.requests.length, 2, 'only the detail read and passive refresh may POST');
    assert.deepEqual(getUxErrors(), []);
  });
}

test('concurrent unloaded races across sessions share one refresh even after its ACK', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  const before = useCockpit.getState().sessions;
  const reads = [
    expectRejection(useCockpit.getState().getPlan('a'), /Native session data/),
    expectRejection(useCockpit.getState().getPanels('b'), /Native session data/),
    expectRejection(useCockpit.getState().skillsSession('a'), /Native session data/),
    expectRejection(useCockpit.getState().scheduleList('b'), /Native session data/),
  ];
  h.assertPost(0, 'session/plan', { sessionId: 'a' }).resolve(unloadedResponse());
  await reads[0];
  h.assertPost(4, 'session/refresh', {});
  h.assertPost(1, 'session/panels', { sessionId: 'b' }).resolve(unloadedResponse());
  await reads[1];
  assert.equal(h.requests.length, 5);
  const duringRefresh = expectRejection(useCockpit.getState().getPlan('b'), /Native session data/);
  await h.reply(4, { ok: true });
  h.assertPost(2, 'skills/session', { sessionId: 'a' }).resolve(unloadedResponse());
  h.assertPost(3, 'schedule/list', { sessionId: 'b' }).resolve(unloadedResponse());
  h.assertPost(5, 'session/plan', { sessionId: 'b' }).resolve(unloadedResponse());
  await Promise.all([...reads, duringRefresh]);
  assert.equal(h.requests.length, 6, 'late failures from overlapping reads must not refresh again');
  assert.strictEqual(useCockpit.getState().sessions, before);

  const later = expectRejection(useCockpit.getState().getPlan('a'), /Native session data/);
  h.assertPost(6, 'session/plan', { sessionId: 'a' }).resolve(unloadedResponse());
  await later;
  h.assertPost(7, 'session/refresh', {});
  await h.reply(7, { ok: true });
  assert.equal(h.requests.length, 8, 'a later independent race can reconcile again');
  assert.strictEqual(useCockpit.getState().sessions, before);
  assert.deepEqual(getUxErrors(), []);
});

for (const obsolete of ['snapshot', 'reconnect', 'replacement client', 'cleanup'] as const) {
  test(`an unloaded response from before ${obsolete} cannot refresh the current connection`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const checked = expectRejection(useCockpit.getState().getPlan('a'), /Native session data/);
    if (obsolete === 'snapshot') h.snapshot();
    else if (obsolete === 'reconnect') h.reconnect();
    else if (obsolete === 'cleanup') h.cleanup();
    else {
      const cleanup = useCockpit.getState().init();
      t.after(cleanup);
      h.sources[1].open();
      h.sources[1].emit({
        type: 'snapshot', agentStatus: 'up', permissionPolicy: 'allow-all', models: [], sessions: [meta('a')],
      });
    }
    const before = useCockpit.getState().sessions;
    h.assertPost(0, 'session/plan', { sessionId: 'a' }).resolve(unloadedResponse());
    await checked;
    assert.equal(h.requests.length, 1);
    assert.strictEqual(useCockpit.getState().sessions, before);
    assert.deepEqual(getUxErrors(), []);
  });
}

test('failed passive reconciliation preserves the unloaded rejection and authoritative loaded state', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot();
  const before = session();
  const checked = expectRejection(useCockpit.getState().getPanels('a'), /Native session data/);
  h.assertPost(0, 'session/panels', { sessionId: 'a' }).resolve(unloadedResponse());
  await checked;
  h.assertPost(1, 'session/refresh', {}).resolve(Response.json({ error: 'refresh denied' }, { status: 403 }));
  await setImmediate();
  assert.strictEqual(session(), before);
  assert.equal(h.requests.length, 2);
  assert.ok(getUxErrors().every((error) => !error.message.includes(unloadedMessage)));
});

for (const { status, code } of [
  { status: 409, code: undefined },
  { status: 409, code: 'OTHER_CONFLICT' },
  { status: 403, code: 'SESSION_UNLOADED' },
]) {
  test(`native HTTP ${status}/${code} does not passively refresh based on an unloaded message`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const before = session();
    const checked = expectRejection(useCockpit.getState().getPlan('a'), /Native session data/);
    h.assertPost(0, 'session/plan', { sessionId: 'a' }).resolve(Response.json({
      message: unloadedMessage, code,
    }, { status }));
    await checked;
    assert.strictEqual(session(), before);
    assert.equal(h.requests.length, 1);
    assert.equal(getUxErrors().length, 1);
  });
}

test('unloaded history stays passive and MCP is gated without runtime loading', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot([], { sessions: ['a', 'b'].map((id) => ({ ...meta(id), loaded: false })) });
  await h.load('a', [message('a-history')], false);
  useCockpit.getState().setActiveId('a');
  assert.equal(h.requests.length, 1, 'unchanged history selection must not fetch again');
  await h.load('b', [message('b-history')], false);
  useCockpit.getState().setActiveId('a');
  assert.equal(h.requests.length, 2, 'the browser retains already loaded unloaded-session pages');

  await assert.rejects(useCockpit.getState().mcpSession('a'), SessionUnloadedError);
  assert.equal(h.requests.length, 2);
  const refresh = useCockpit.getState().refreshList();
  h.assertPost(2, 'session/refresh', {}).resolve(Response.json({ ok: true }));
  await refresh;
  assert.equal(useCockpit.getState().activeId, 'a');
  assert.deepEqual(session().messages, [message('a-history')]);
  assert.ok(useCockpit.getState().sessions.every((row) => row.loaded === false));
  assert.equal(h.requests.length, 3);
  assert.deepEqual(getUxErrors(), []);
});

test('MCP loaded:false race requests passive metadata reconciliation instead of a false empty result', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot();
  const before = session();
  const checked = observe(assert.rejects(useCockpit.getState().mcpSession('a'), SessionUnloadedError));
  h.assertPost(0, 'mcp/session', { sessionId: 'a' }).resolve(Response.json({ loaded: false, servers: [] }));
  await checked;
  h.assertPost(1, 'session/refresh', {});
  assert.strictEqual(session(), before);
  await h.reply(1, { ok: true });
  assert.equal(session().loaded, true, 'only server metadata may update loaded');
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false });
  await assert.rejects(useCockpit.getState().mcpSession('a'), SessionUnloadedError);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(getUxErrors(), []);
});

test('global MCP and Skills remain readable and mutable without any session or optimistic selection state', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot([]);
  const before = useCockpit.getState().sessions;
  const mcp = useCockpit.getState().mcpGlobal();
  const skills = useCockpit.getState().skillsGlobal();
  const detail = useCockpit.getState().skillsRead('fixture-skill');
  const toggle = useCockpit.getState().skillsSetGlobal('fixture-skill', true);
  h.assertPost(0, 'mcp/global', {}).resolve(Response.json({ servers: globalMcp }));
  h.assertPost(1, 'skills/global', {}).resolve(Response.json({ skills: globalSkills }));
  h.assertPost(2, 'skills/read', { name: 'fixture-skill' }).resolve(Response.json(skill));
  h.assertPost(3, 'skills/global-toggle', { name: 'fixture-skill', enabled: true }).resolve(Response.json({ ok: true }));
  assert.deepEqual(await mcp, globalMcp);
  assert.deepEqual(await skills, globalSkills);
  assert.deepEqual(await detail, skill);
  await toggle;
  assert.strictEqual(useCockpit.getState().sessions, before);
  assert.equal(useCockpit.getState().activeId, null);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(getUxErrors(), []);
});

test('explicit reload remains available while unloaded and only metadata enables native detail reads', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot([], { sessions: [{ ...meta('a'), loaded: false }] });
  const reload = useCockpit.getState().reloadSession('a');
  h.assertPost(0, 'session/reload', { sessionId: 'a' }).resolve(Response.json({ ok: true }));
  await reload;
  assert.equal(session().loaded, false);
  await assert.rejects(useCockpit.getState().getPlan('a'), SessionUnloadedError);
  assert.equal(h.requests.length, 1);
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: true });
  const detail = useCockpit.getState().getPlan('a');
  h.assertPost(1, 'session/plan', { sessionId: 'a' }).resolve(Response.json(plan));
  assert.deepEqual(await detail, plan);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(getUxErrors(), []);
});

for (const resource of resources) {
  test(`${resource.label} returns the HTTP resource without changing the session projection`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const before = session();
    const pending = observe(resource.read(useCockpit.getState()));
    assert.ok(pending instanceof Promise);
    h.assertPost(0, resource.name, resource.body).resolve(Response.json(resource.response));
    assert.deepEqual(await pending, resource.expected);
    assert.strictEqual(session(), before);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(getUxErrors(), []);
  });

  test(`${resource.label} rejects disconnected reads or mutations instead of returning empty data or success`, async (t) => {
    const h = setup(t);
    const fresh = createCockpitStore();
    await expectOffline(h, () => resource.read(fresh.getState()));
    h.snapshot();
    await expectOffline(h, () => resource.read(useCockpit.getState()));
    h.source.open();
    h.source.drop();
    await expectOffline(h, () => resource.read(useCockpit.getState()));
    h.cleanup();
    await expectOffline(h, () => resource.read(useCockpit.getState()));
    assert.equal(h.requests.length, 0);
  });

  for (const failure of ['transport', 'HTTP', 'invalid JSON'] as const) {
    test(`${resource.label} propagates ${failure} instead of silently fabricating a resource`, async (t) => {
      const h = setup(t);
      h.source.open();
      h.snapshot();
      const before = session();
      const pending = resource.read(useCockpit.getState());
      const rejected = expectRejection(pending);
      const response = h.assertPost(0, resource.name, resource.body);
      if (failure === 'transport') response.reject(new TypeError('offline'));
      else if (failure === 'HTTP') response.resolve(Response.json({ error: 'resource denied' }, { status: 403 }));
      else response.resolve(new Response('not JSON', { headers: { 'content-type': 'application/json' } }));
      await rejected;
      if (resource.name === 'schedule/add' || resource.name === 'schedule/stop') {
        assert.ok(session().error);
        assert.deepEqual(session(), { ...before, error: session().error });
      } else {
        assert.strictEqual(session(), before);
      }
      assert.equal(h.requests.length, 1);
    });
  }
}

for (const resource of resources.filter((r) => r.name === 'schedule/add' || r.name === 'schedule/stop')) {
  test(`${resource.label} remains safe when void-called and exposes rejected acknowledgements`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    void resource.read(useCockpit.getState());
    await h.reply(0, { ok: false });
    assert.match(session().error ?? '', resource.name === 'schedule/add' ? /未能添加定时任务/ : /未能停止定时任务/);
    assert.equal(getUxErrors().length, 1);
    h.source.drop();
    void resource.read(useCockpit.getState());
    await setImmediate();
    assert.match(session().error ?? '', /未连接/);
  });
}

for (const reason of [undefined, '', ' \t ', '模拟：本会话定时任务数量已达上限，请停止一项后再添加。']) {
  test(`scheduleAdd preserves negative acknowledgement reason or operation fallback: ${JSON.stringify(reason)}`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot(['a', 'b']);
    const other = session('b');
    const before = session();
    const expected = reason?.trim() ? reason : '未能添加定时任务，请核对后再试。';
    const pending = useCockpit.getState().scheduleAdd('a', { prompt: 'reminder', interval: '1s' });
    const rejected = assert.rejects(pending, { message: expected });
    await h.reply(0, { ok: false, ...(reason === undefined ? {} : { error: reason }) });
    await rejected;
    assert.equal(h.requests.length, 1);
    assert.equal(getUxErrors().length, 1);
    assert.ok(getUxErrors()[0].message.includes(`会话 a (a)：计划任务操作失败：${expected}`));
    assert.deepEqual(session(), { ...before, error: session().error });
    assert.strictEqual(session('b'), other);
  });
}

test('scheduleStop rejects false with its own fallback and independent failures are not merged', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  for (let i = 0; i < 2; i++) {
    const rejected = assert.rejects(useCockpit.getState().scheduleStop('a', 7), {
      message: '未能停止定时任务，请刷新列表后核对。',
    });
    h.assertPost(i, 'schedule/stop', { sessionId: 'a', id: 7 }).resolve(Response.json({ ok: false }));
    await rejected;
  }
  assert.equal(h.requests.length, 2);
  assert.equal(getUxErrors().length, 2);
  assert.notEqual(getUxErrors()[0].id, getUxErrors()[1].id);
  assert.ok(getUxErrors().every(error => error.message.includes('会话 a (a)')));
  assert.equal(session('b').error, null);
});

for (const failure of ['500', 'null-error'] as const) {
  test(`scheduleAdd transport ${failure} keeps one diagnostic and does not use negative ACK fallback`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const pending = useCockpit.getState().scheduleAdd('a', { prompt: 'reminder', interval: '1s' });
    const rejected = assert.rejects(pending, failure === '500' ? /模拟暂时不可用/ : /error/);
    h.assertPost(0, 'schedule/add', { sessionId: 'a', prompt: 'reminder', interval: '1s' })
      .resolve(Response.json({ error: failure === '500' ? '模拟暂时不可用' : null, ok: false }, { status: failure === '500' ? 500 : 200 }));
    await rejected;
    await setImmediate();
    assert.equal(getUxErrors().length, 1);
    assert.doesNotMatch(getUxErrors()[0].message, /未能添加定时任务/);
    assert.equal(h.requests.length, 1);
  });
}

test('attached prompt failures keep the original false acknowledgement and local diagnostic contract', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  const attachments: NativeAttachment[] = [{ type: 'file', path: '/native/fixture.txt' }];
  const before = session();
  const other = session('b');
  const pending = useCockpit.getState().sendPrompt('a', 'keep draft', attachments);
  h.assertPost(0, 'prompt', { sessionId: 'a', text: 'keep draft', attachments }).reject(new Error('attachment denied'));
  assert.equal(await pending, false);
  assert.match(session().error ?? '', /未确认发送/);
  assert.match(session().error ?? '', /草稿已保留/);
  assert.deepEqual(session(), { ...before, error: session().error });
  assert.strictEqual(session('b'), other);
  assert.equal(getUxErrors().length, 1);
  assert.match(getUxErrors()[0].message, /prompt/);
  assert.equal(h.requests.length, 1);
});

for (const addedBeforeReply of [false, true]) {
  test(`forkSession returns new ID without sending, loading or selecting it (SSE first: ${addedBeforeReply})`, async t => {
    const h = setup(t);
    h.source.open();
    h.snapshot(['a']);
    const pending = useCockpit.getState().forkSession('a');
    h.assertPost(0, 'session/fork', { sessionId: 'a' });
    if (addedBeforeReply) h.source.emit({ type: 'session/added', session: { ...meta('child'), loaded: false, status: 'unloaded' } });
    h.request(0).response.resolve(Response.json({ sessionId: 'child' }));
    assert.equal(await pending, 'child');
    if (!addedBeforeReply) h.source.emit({ type: 'session/added', session: { ...meta('child'), loaded: false, status: 'unloaded' } });
    assert.equal(useCockpit.getState().activeId, null);
    assert.equal(session('child').loaded, false);
    assert.equal(h.requests.length, 1);
  });

  test(`newSession returns its SID but never selects it (added SSE before reply: ${addedBeforeReply})`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot(['a', 'b']);
    await h.load('a', [message('a')], false);
    await h.load('b', [message('b')], false);
    useCockpit.getState().setActiveId('a');
    const pending: Promise<string> = useCockpit.getState().newSession('./fixture');
    h.assertPost(2, 'session/new', { cwd: './fixture' });
    let settled = false;
    void pending.then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(useCockpit.getState().activeId, 'a');
    if (addedBeforeReply) h.source.emit({ type: 'session/added', session: meta('created') });
    useCockpit.getState().setActiveId('b');
    h.request(2).response.resolve(Response.json({ sessionId: 'created' }));
    assert.equal(await pending, 'created');
    assert.equal(useCockpit.getState().activeId, 'b');
    if (!addedBeforeReply) h.source.emit({ type: 'session/added', session: meta('created') });
    assert.equal(useCockpit.getState().activeId, 'b');
    assert.deepEqual(session('created').messages, []);
    assert.equal(session('created').materialized, false);
    assert.equal(h.requests.length, 3, 'cached route selections and creation never reread history');
  });
}

test('forkSession propagates uncertain delivery once without retry or changing selection', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a']);
  const pending = useCockpit.getState().forkSession('a');
  const failure = new Error('delivery uncertain; inspect session list');
  h.assertPost(0, 'session/fork', { sessionId: 'a' }).reject(failure);
  await assert.rejects(pending, error => error === failure);
  assert.equal(h.requests.length, 1);
  assert.equal(getUxErrors().length, 1);
});

test('newSession rejects original failures and disconnected attempts without changing the selected session or double reporting', async (t) => {
  const h = setup(t);
  h.snapshot();
  useCockpit.getState().setActiveId('a');
  await expectOffline(h, () => useCockpit.getState().newSession('.'));
  assert.equal(h.requests.length, 0);
  h.source.open();
  h.assertPost(0, 'session/chat', { sessionId: 'a', source: 'live', direction: 'backward',
    max: 32, waitMs: 0, bootstrap: true, agentScope: 'all' });
  await h.history(0, { sessionId: 'a', messages: [], latest: true, hasMore: false });
  const pending = useCockpit.getState().newSession('.');
  const failure = new Error('creation denied');
  const errorsBefore = getUxErrors().length;
  h.assertPost(1, 'session/new', { cwd: '.' }).reject(failure);
  await assert.rejects(pending, error => error === failure);
  assert.equal(getUxErrors().length, errorsBefore + 1);
  assert.match(getUxErrors().at(-1)!.message, /接口 session\/new.*creation denied/);
  assert.equal(useCockpit.getState().activeId, 'a');
  h.source.drop();
  await expectOffline(h, () => useCockpit.getState().newSession('.'));
  h.cleanup();
  await expectOffline(h, () => useCockpit.getState().newSession('.'));
  assert.equal(h.requests.length, 2);
});

test('newSession HTTP failure stays rejected with its actionable reason and one report for each independent attempt', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot();
  for (let i = 0; i < 2; i++) {
    const pending = useCockpit.getState().newSession('/P');
    h.assertPost(i, 'session/new', { cwd: '/P' }).resolve(Response.json({ error: 'P is not accessible; choose another directory' }, { status: 500 }));
    await assert.rejects(pending, /P is not accessible; choose another directory/);
    assert.equal(getUxErrors().length, i + 1);
  }
  assert.equal(h.requests.length, 2);
});

test('void newSession failures are observed without hiding rejection or retrying', async t => {
  const h = setup(t);
  void useCockpit.getState().newSession('/P');
  await setImmediate();
  assert.equal(getUxErrors().length, 1);
  assert.match(getUxErrors()[0].message, /新建会话失败.*未连接/);
  assert.equal(h.requests.length, 0);
  h.source.open();
  h.snapshot();
  void useCockpit.getState().newSession('/P');
  h.assertPost(0, 'session/new', { cwd: '/P' }).resolve(Response.json({ error: 'denied' }, { status: 500 }));
  await setImmediate();
  assert.equal(getUxErrors().length, 2);
  assert.equal(h.requests.length, 1);
});
