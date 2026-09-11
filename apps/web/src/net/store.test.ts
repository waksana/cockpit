import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createECDH } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { IntentBody, IntentName, IntentResult } from '@cockpit/protocol';
import { CHAT_STREAM_URL, intentUrl } from '../lib/config';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { IntentHttpError, isSessionUnloadedError, SessionUnloadedError } from './client';
import { createCockpitStore } from './store';
import { createSessionDrafts } from '../lib/attachmentSend';
import type { Attachment, ChatMessage, ServerEvent, SessionMeta, UploadedFile } from './types';
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
    if (name.startsWith('push/') || name === 'session/chat' || name === 'session/get' || name === 'session/resources') {
      assert.ok(init?.signal instanceof AbortSignal, 'push requests must have an abort deadline');
      const { signal, ...rest } = init;
      if (name.startsWith('push/')) assert.equal(signal.aborted, false);
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
  const modules = [{ moduleId: 'assistant' as const, roleId: 'assistant' }];
  const creating = store.getState().newSession('/workspace', modules);
  h.assertPost(0, 'session/new', { cwd: '/workspace', modules });
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
  h.source.emit({ type: 'session/patch', sessionId: 'a', error: 'Native turn failed', autoNameError: 'Naming failed' });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  const { error: _error, ...fresh } = meta('a');
  await h.reply(0, { meta: fresh });
  assert.equal(session('a', store).error, 'Native turn failed');
  assert.equal(session('a', store).autoNameError, 'Naming failed');
  h.source.emit({ type: 'session/patch', sessionId: 'a', error: null, autoNameError: null });
  assert.equal(session('a', store).error, null);
  assert.equal(session('a', store).autoNameError, null);
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

test('native naming metadata leaves unread attention, drafts and materialized messages unchanged', async (t) => {
  const storage = new Map<string, string>();
  replaceGlobal(t, 'localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  const h = setup(t);
  h.source.open();
  h.snapshot(['a'], { sessions: [{ ...meta('a'), attention: 'ready', attnId: 4, seenId: 2 }], unreadCount: 1 });
  await h.load('a', [message('completed')], false);
  const drafts = createSessionDrafts();
  const draft = drafts('a');
  draft.edit('Composer draft');
  const draftBefore = draft.getSnapshot();
  const storedBefore = new Map(storage);
  const before = session();
  const unread = useCockpit.getState().unreadCount;
  h.source.emit({ type: 'session/patch', sessionId: 'a', autoNaming: true });
  assert.equal(session().status, 'idle');
  h.source.emit({ type: 'session/patch', sessionId: 'a', autoNaming: false, autoNameError: 'Native query unavailable' });
  assert.equal(session().error, null);
  h.source.emit({ type: 'session/patch', sessionId: 'a', title: 'Native title', autoNameError: null });
  assert.equal(session().title, 'Native title');
  assert.strictEqual(session().messages, before.messages);
  assert.equal(session().attention, before.attention);
  assert.equal(session().attnId, before.attnId);
  assert.equal(session().seenId, before.seenId);
  assert.equal(useCockpit.getState().unreadCount, unread);
  assert.strictEqual(draft.getSnapshot(), draftBefore);
  assert.deepEqual(storage, storedBefore);
  assert.equal(h.requests.length, 1);
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
    name: 'session/pin', body: { sessionId: 'a', pinned: true }, send: (s) => s.pinSession('a', true),
    success: { ok: true, pinned: true }, sessionId: 'a',
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
    assert.equal(session().pinned, before.pinned);
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

for (const kind of ['image', 'file'] as const) {
  test(`sendPrompt forwards optional ${kind} attachment metadata, not UploadedFile server paths`, async (t) => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const before = session();
    const attachment: Attachment = {
      kind, name: kind === 'image' ? 'fixture.png' : 'fixture.txt',
      url: '/uploads/fixture', size: 12, mime: kind === 'image' ? 'image/png' : 'text/plain',
    };
    const uploaded: UploadedFile = {
      ...attachment, size: 12, mime: attachment.mime!, path: '/fixture/uploads/fixture', storedName: 'fixture',
    };
    const pending: Promise<boolean> = useCockpit.getState().sendPrompt('a', 'inspect attachment', uploaded);
    const response = h.assertPost(0, 'prompt', { sessionId: 'a', text: 'inspect attachment', attachment });
    let settled = false;
    void pending.then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    assert.strictEqual(session(), before);
    response.resolve(Response.json({ ok: true }));
    assert.equal(await pending, true);
    assert.strictEqual(session(), before);
    assert.equal(uploaded.path, '/fixture/uploads/fixture');
    assert.equal(h.requests.length, 1);
    assert.deepEqual(getUxErrors(), []);
  });
}

test('attached prompt failures keep the original false acknowledgement and local diagnostic contract', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  const attachment: Attachment = { kind: 'file', name: 'fixture.txt', url: '/uploads/fixture.txt' };
  const before = session();
  const other = session('b');
  const pending = useCockpit.getState().sendPrompt('a', 'keep draft', attachment);
  h.assertPost(0, 'prompt', { sessionId: 'a', text: 'keep draft', attachment }).reject(new Error('attachment denied'));
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

const applicationServerKey = new Uint8Array(createECDH('prime256v1').generateKeys());
const vapidPublicKey = Buffer.from(applicationServerKey).toString('base64url');
const subscription: IntentBody<'push/subscribe'>['subscription'] = {
  endpoint: 'https://push.invalid/fixture', expirationTime: null,
  keys: { p256dh: vapidPublicKey, auth: Buffer.alloc(16, 7).toString('base64url') },
};

function pushStatus(registered: boolean): IntentResult<'push/status'> {
  return { configured: true, registered, publicKey: vapidPublicKey, subscriptionCount: registered ? 1 : 0 };
}

function browser(t: TestContext, permission: NotificationPermission = 'granted', push = false) {
  let harness: ReturnType<typeof setup> | undefined;
  t.after(() => harness?.cleanup());
  const notifications: FakeNotification[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = t.mock.fn(async () => {
      FakeNotification.permission = 'granted';
      return 'granted' as const;
    });
    onclick: (() => void) | null = null;
    close = t.mock.fn();
    readonly title: string;
    readonly options?: NotificationOptions;
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      notifications.push(this);
    }
  }
  const localSubscription = {
    endpoint: subscription.endpoint,
    expirationTime: null,
    options: { applicationServerKey: applicationServerKey.slice().buffer, userVisibleOnly: true },
    getKey: (name: PushEncryptionKeyName) => Uint8Array.from(Buffer.from(subscription.keys[name], 'base64url')).buffer,
    toJSON: () => subscription,
    unsubscribe: t.mock.fn(async () => { local.subscription = null; return true; }),
  } satisfies PushSubscription;
  const local = { subscription: push ? localSubscription as PushSubscription : null, registered: push };
  const osNotifications: { tag: string; data: unknown; close: () => void }[] = [];
  const registration = {
    active: { state: 'activated' as const }, installing: null, waiting: null,
    pushManager: {
      getSubscription: t.mock.fn(async () => local.subscription),
      subscribe: t.mock.fn(async (_options: PushSubscriptionOptionsInit) => {
        local.subscription = localSubscription;
        return localSubscription;
      }),
    },
    getNotifications: t.mock.fn(async () => osNotifications),
    showNotification: t.mock.fn(async (_title: string, _options?: NotificationOptions) => {}),
  };
  const serviceWorker = {
    register: t.mock.fn(async (_url: string, _options?: RegistrationOptions) => {
      local.registered = true;
      return registration;
    }),
    getRegistration: t.mock.fn(async (_scope?: string) => local.registered ? registration : undefined),
    get ready(): Promise<ServiceWorkerRegistration> { return assert.fail('passive lookups must not wait on serviceWorker.ready'); },
  };
  const navigatorMock = { standalone: true, userActivation: { isActive: true }, serviceWorker };
  const location = {
    protocol: 'https:',
    get href() { return 'https://cockpit.invalid/session/a'; },
    set href(_value: string) { assert.fail('notifications must not navigate'); },
    assign: t.mock.fn(() => assert.fail('notifications must not navigate')),
    replace: t.mock.fn(() => assert.fail('notifications must not navigate')),
  };
  const windowMock = Object.assign(new EventTarget(), {
    Notification: FakeNotification, navigator: navigatorMock, isSecureContext: true, PushManager: class {},
    matchMedia: () => ({ matches: true }), focus: t.mock.fn(), location,
    history: {
      pushState: t.mock.fn(() => assert.fail('notifications must not navigate')),
      replaceState: t.mock.fn(() => assert.fail('notifications must not navigate')),
    },
  });
  const documentMock = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  replaceGlobal(t, 'window', windowMock);
  replaceGlobal(t, 'document', documentMock);
  replaceGlobal(t, 'navigator', navigatorMock);
  replaceGlobal(t, 'Notification', FakeNotification);
  return {
    window: windowMock, document: documentMock, notifications, Notification: FakeNotification,
    local, localSubscription, registration, serviceWorker, osNotifications,
    setup: (store: Store = createCockpitStore()) => {
      harness = setup(t, store);
      return harness;
    },
  };
}

test('browser notification click dispatches cockpit:open-session with SID and never selects or navigates', async (t) => {
  const b = browser(t);
  const h = b.setup();
  h.source.open();
  h.snapshot(['a', 'b']);
  b.document.visibilityState = 'visible';
  await h.load('a', [message('active')], false);
  b.document.visibilityState = 'hidden';
  h.assertPost(1, 'push/status', {});
  await h.reply(1, pushStatus(false));
  const events: Event[] = [];
  b.window.addEventListener('cockpit:open-session', (event) => events.push(event));
  h.source.emit({
    type: 'session/notify', sessionId: 'b', title: 'Fixture session', attention: 'choice', body: 'Needs input',
  });
  await setImmediate();
  assert.equal(b.notifications.length, 1);
  const notification = b.notifications[0];
  assert.equal(notification.title, 'Fixture session');
  assert.equal(notification.options?.body, 'Needs input');
  assert.equal(notification.options?.tag, 'b');
  assert.ok(notification.onclick);
  notification.onclick();
  assert.equal(events.length, 1);
  assert.ok(events[0] instanceof CustomEvent);
  assert.deepEqual(events[0].detail, { sessionId: 'b' });
  assert.equal(b.window.focus.mock.callCount(), 1);
  assert.equal(notification.close.mock.callCount(), 1);
  assert.equal(h.store.getState().activeId, 'a');
  assert.equal(h.requests.length, 2);
  h.source.emit({ type: 'session/notify', sessionId: 'a', title: 'Active', attention: 'ready', body: 'Done' });
  await setImmediate();
  assert.equal(b.notifications.length, 2, 'a hidden active session still produces a page notification');
  assert.equal(b.notifications[1].options?.tag, 'a');
  b.document.visibilityState = 'visible';
  h.source.emit({ type: 'session/notify', sessionId: 'b', title: 'Visible', attention: 'ready', body: 'Done' });
  await setImmediate();
  assert.equal(b.notifications.length, 2, 'a visible tab suppresses page notifications');
  assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
  assert.equal(b.serviceWorker.register.mock.callCount(), 0);
  assert.equal(b.registration.pushManager.subscribe.mock.callCount(), 0);
  assert.deepEqual(getUxErrors(), []);
});

test('notification permission alone is not notification readiness and snapshots never ask permission', async (t) => {
  const b = browser(t, 'granted', true);
  const h = b.setup();
  assert.equal(h.store.getState().notifPermission, 'granted');
  assert.equal(h.store.getState().notifReady, false);
  h.source.open();
  h.snapshot();
  assert.equal(h.store.getState().notifReady, false);
  assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
  await setImmediate();
  h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
  await h.reply(0, { configured: false, registered: false, publicKey: null, subscriptionCount: 0 });
  assert.equal(h.store.getState().notifReady, false);
  assert.equal(h.store.getState().notifications.configured, false);
  assert.equal(h.store.getState().notifications.busy, false);
  assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
  assert.equal(b.registration.pushManager.subscribe.mock.callCount(), 0);
  assert.equal(b.serviceWorker.register.mock.callCount(), 0);
  assert.equal(h.requests.length, 1);
});

for (const permission of ['default', 'denied'] as const) {
  test(`passive notification status never prompts or arms push with ${permission} permission`, async (t) => {
    const b = browser(t, permission, true);
    const h = b.setup();
    h.source.open();
    h.snapshot(['a'], { vapidPublicKey });
    await setImmediate();
    h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(0, pushStatus(true));
    assert.equal(h.store.getState().notifReady, false);
    assert.equal(h.store.getState().notifPermission, permission);
    assert.equal(h.store.getState().notifications.registered, true);
    assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
    assert.equal(b.registration.pushManager.subscribe.mock.callCount(), 0);
    assert.equal(b.serviceWorker.register.mock.callCount(), 0);
    assert.equal(h.requests.length, 1);
  });
}

test('passive connect reuses a matching registered key and ready push suppresses page fallback', async (t) => {
  const b = browser(t, 'granted', true);
  const h = b.setup();
  h.source.open();
  h.snapshot(['a', 'b']);
  await setImmediate();
  h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
  assert.equal(h.store.getState().notifReady, false);
  await h.reply(0, pushStatus(true));
  assert.equal(h.store.getState().notifReady, true);
  assert.equal(h.store.getState().notifications.ready, true);
  assert.equal(h.store.getState().notifications.registered, true);
  assert.equal(h.store.getState().notifications.error, null);
  b.document.visibilityState = 'visible';
  await h.load('a', [], false);
  b.document.visibilityState = 'hidden';
  for (const sessionId of ['a', 'b']) {
    h.source.emit({ type: 'session/notify', sessionId, title: sessionId, attention: 'ready', body: 'Done' });
  }
  await setImmediate();
  assert.equal(b.document.visibilityState, 'hidden');
  assert.equal(b.notifications.length, 0);
  assert.equal(b.registration.showNotification.mock.callCount(), 0);
  assert.equal(b.serviceWorker.register.mock.callCount(), 0);
  assert.equal(b.registration.pushManager.subscribe.mock.callCount(), 0);
  assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(getUxErrors(), []);
});

for (const failure of ['ok:false', 'invalid acknowledgement', 'HTTP', 'transport'] as const) {
  test(`push subscription ${failure} cannot set notifReady even with granted permission`, async (t) => {
    const b = browser(t, 'default', true);
    const h = b.setup();
    h.source.open();
    h.snapshot(['a'], { vapidPublicKey });
    await setImmediate();
    h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(0, pushStatus(false));
    assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
    assert.equal(h.requests.length, 1);
    const pending = h.store.getState().enableNotifications();
    assert.equal(b.Notification.requestPermission.mock.callCount(), 1, 'permission is requested in the click stack');
    await setImmediate();
    assert.equal(b.Notification.requestPermission.mock.callCount(), 1);
    assert.equal(h.store.getState().notifPermission, 'granted');
    assert.equal(h.store.getState().notifReady, false);
    h.assertPost(1, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(1, pushStatus(false));
    const response = h.assertPost(2, 'push/subscribe', { subscription });
    const rawError = `${subscription.endpoint}?auth=private-push-token`;
    if (failure === 'transport') response.reject(new TypeError(rawError));
    else if (failure === 'HTTP') response.resolve(Response.json({ error: rawError }, { status: 403 }));
    else response.resolve(Response.json({ ok: failure === 'ok:false' ? false : 'true' }));
    assert.equal(await pending, undefined, 'controller errors resolve into settings state');
    assert.equal(h.store.getState().notifReady, false);
    assert.equal(h.store.getState().notifications.ready, false);
    assert.equal(h.store.getState().notifications.busy, false);
    assert.match(h.store.getState().notifications.error!, /服务端未确认订阅注册/);
    assert.doesNotMatch(JSON.stringify(h.store.getState().notifications), /push\.invalid|private-push-token/);
    assert.deepEqual(getUxErrors(), [], 'push failures must not create raw global UI errors');
    assert.equal(b.serviceWorker.register.mock.callCount(), 0);
    assert.equal(b.registration.pushManager.subscribe.mock.callCount(), 0);
    assert.equal(h.requests.length, 3);
  });
}

test('notifReady waits for subscribe ACK and registered status, then resets immediately on connecting', async (t) => {
  const b = browser(t, 'granted', true);
  const h = b.setup();
  h.source.open();
  h.snapshot(['a'], { vapidPublicKey });
  await setImmediate();
  h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
  await h.reply(0, pushStatus(false));
  const response = h.assertPost(1, 'push/subscribe', { subscription });
  assert.equal(h.store.getState().notifReady, false);
  const json = deferred<{ ok: boolean }>();
  const http = Response.json({});
  t.mock.method(http, 'json', () => json.promise);
  response.resolve(http);
  await setImmediate();
  assert.equal(h.store.getState().notifReady, false);
  json.resolve({ ok: true });
  await setImmediate();
  assert.equal(h.store.getState().notifReady, false, 'ACK is not proof the endpoint is registered');
  h.assertPost(2, 'push/status', { endpoint: subscription.endpoint });
  await h.reply(2, pushStatus(true));
  assert.equal(h.store.getState().notifReady, true);
  h.source.drop();
  assert.equal(h.store.getState().notifReady, false);
  h.source.open();
  h.snapshot(['a'], { vapidPublicKey });
  await setImmediate();
  h.assertPost(3, 'push/status', { endpoint: subscription.endpoint });
  assert.equal(h.store.getState().notifReady, false);
  await h.reply(3, pushStatus(true));
  assert.equal(h.store.getState().notifReady, true);
  assert.equal(h.store.getState().notifications.ready, true);
  assert.equal(b.Notification.requestPermission.mock.callCount(), 0);
  assert.equal(b.registration.pushManager.subscribe.mock.callCount(), 0);
  assert.equal(b.serviceWorker.register.mock.callCount(), 0);
  assert.equal(h.requests.length, 4);
});

for (const registered of [false, undefined]) {
  test(`successful push ACK without registered:true (${registered}) remains unready`, async (t) => {
    const b = browser(t, 'granted', true);
    const h = b.setup();
    h.source.open();
    h.snapshot();
    await setImmediate();
    h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(0, pushStatus(false));
    h.assertPost(1, 'push/subscribe', { subscription });
    await h.reply(1, { ok: true });
    h.assertPost(2, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(2, { ...pushStatus(false), registered });
    assert.equal(h.store.getState().notifReady, false);
    assert.equal(h.store.getState().notifications.busy, false);
    assert.match(h.store.getState().notifications.error!, /服务端未确认订阅注册/);
    assert.deepEqual(getUxErrors(), []);
    assert.equal(h.requests.length, 3);
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`a superseded push ${outcome} cannot set readiness or override the current registration`, async (t) => {
    const b = browser(t, 'granted', true);
    const h = b.setup();
    h.source.open();
    h.snapshot(['a'], { vapidPublicKey });
    await setImmediate();
    h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(0, pushStatus(false));
    h.assertPost(1, 'push/subscribe', { subscription });
    h.source.drop();
    assert.equal(h.store.getState().notifReady, false);
    h.source.open();
    h.snapshot(['a'], { vapidPublicKey });
    await setImmediate();
    assert.equal(h.store.getState().notifReady, false);
    if (outcome === 'success') {
      await h.reply(1, { ok: true });
    } else {
      h.request(1).response.reject(new Error('obsolete push failure'));
      await setImmediate();
    }
    assert.equal(h.store.getState().notifReady, false, 'an obsolete completion cannot confirm the new connection');
    assert.equal(h.store.getState().notifications.error, null);
    h.assertPost(2, 'push/status', { endpoint: subscription.endpoint });
    await h.reply(2, pushStatus(true));
    assert.equal(h.store.getState().notifReady, true);
    assert.equal(h.store.getState().notifications.registered, true);
    assert.equal(h.store.getState().notifications.error, null);
    assert.deepEqual(getUxErrors(), []);
    assert.equal(h.requests.length, 3, 'the obsolete operation must not verify or register again');
    h.cleanup();
    assert.equal(h.store.getState().notifReady, false);
  });
}

test('foreground acknowledges only the observed attnId and delayed ACKs cannot clear newer or unrelated notifications', async (t) => {
  const b = browser(t, 'granted', true);
  const h = b.setup();
  const note = (sessionId: string, attnId: number) => ({
    tag: sessionId,
    data: { type: 'notification', kind: 'ready', sessionId, attnId },
    close: t.mock.fn(),
  });
  const old = note('a', 4);
  const newer = note('a', 5);
  const other = note('b', 8);
  const unknown = note('not-in-snapshot', 1);
  b.osNotifications.push(old, newer, other, unknown);
  h.source.open();
  h.snapshot([], {
    sessions: [
      { ...meta('a'), attention: 'ready', attnId: 4, seenId: 3 },
      { ...meta('b'), attention: 'choice', attnId: 8, seenId: 7 },
    ],
    unreadCount: 7, inboxRevision: 20,
  });
  await setImmediate();
  h.assertPost(0, 'push/status', { endpoint: subscription.endpoint });
  await h.reply(0, pushStatus(true));
  b.document.visibilityState = 'visible';
  await h.load('a', [message('active')], false);
  b.document.visibilityState = 'hidden';
  h.store.getState().observeAttention('a', 4, true);
  assert.equal(h.requests.length, 2, 'selecting a hidden session does not acknowledge it');

  b.document.visibilityState = 'visible';
  b.document.dispatchEvent(new Event('visibilitychange'));
  b.document.dispatchEvent(new Event('visibilitychange'));
  b.window.dispatchEvent(new Event('online'));
  await setImmediate();
  h.assertPost(2, 'inbox/seen', { sessionId: 'a', attnId: 4 });
  h.assertPost(3, 'push/status', { endpoint: subscription.endpoint });
  assert.equal(h.requests.length, 4, 'repeated foreground events coalesce the same observed attention');
  for (const notification of [old, newer, other, unknown]) {
    assert.equal(notification.close.mock.callCount(), 0, 'foreground alone never clears OS notifications');
  }
  await h.reply(3, pushStatus(true));

  h.source.emit({ type: 'session/patch', sessionId: 'a', attention: 'ready', attnId: 5 });
  assert.equal(h.requests.length, 4, 'new attention is not read until the view actually renders it');
  h.store.getState().observeAttention('a', 5, true);
  h.assertPost(4, 'inbox/seen', { sessionId: 'a', attnId: 5 });
  await h.reply(2, { ok: true });
  assert.equal(session('a', h.store).attnId, 5);
  assert.equal(session('a', h.store).attention, 'ready');
  assert.equal(session('a', h.store).seenId, 3, 'HTTP ACK is not an authoritative seen patch');
  assert.equal(h.store.getState().unreadCount, 7);
  b.window.dispatchEvent(new Event('online'));
  assert.equal(h.requests.length, 5, 'the old completion must not remove the newer in-flight seen guard');

  h.source.emit({ type: 'session/patch', sessionId: 'a', attention: null, seenId: 4 });
  await setImmediate();
  assert.equal(session('a', h.store).attention, 'ready');
  assert.equal(session('a', h.store).attnId, 5);
  assert.equal(session('a', h.store).seenId, 4);
  assert.equal(h.store.getState().unreadCount, 7);
  assert.ok(old.close.mock.callCount() > 0);
  assert.equal(newer.close.mock.callCount(), 0);
  assert.equal(other.close.mock.callCount(), 0);
  assert.equal(unknown.close.mock.callCount(), 0);

  await h.reply(4, { ok: true });
  assert.equal(session('a', h.store).attention, 'ready');
  assert.equal(session('a', h.store).seenId, 4);
  h.source.emit({ type: 'session/patch', sessionId: 'a', attention: null, attnId: 5, seenId: 5 });
  await setImmediate();
  assert.equal(h.store.getState().unreadCount, 6);
  assert.equal(session('a', h.store).attention, null);
  assert.equal(session('b', h.store).attention, 'choice');
  assert.equal(session('b', h.store).seenId, 7);
  assert.ok(newer.close.mock.callCount() > 0);
  assert.equal(other.close.mock.callCount(), 0);
  assert.equal(unknown.close.mock.callCount(), 0);
  assert.deepEqual(getUxErrors(), []);
  assert.equal(h.requests.length, 5);
});

test('active foreground chat does not acknowledge unread replies before visible fresh history', async (t) => {
  const b = browser(t, 'denied', false);
  const h = b.setup();
  b.document.visibilityState = 'visible';
  h.source.open();
  h.snapshot([], { sessions: [{ ...meta('a'), attention: 'ready', attnId: 4, seenId: 3 }] });
  h.store.getState().setActiveId('a');
  assert.ok(h.requests.every((request) => request.url !== intentUrl('inbox/seen')));
  h.store.getState().observeAttention('a', 4, true);
  assert.ok(h.requests.every((request) => request.url !== intentUrl('inbox/seen')), 'unloaded history cannot be read');
  const historyIndex = h.requests.findIndex((request) => request.url === intentUrl('session/chat'));
  await h.history(historyIndex, { sessionId: 'a', messages: [message('latest')], hasMore: false, latest: true });
  h.store.getState().observeAttention('a', 4, false);
  b.document.dispatchEvent(new Event('visibilitychange'));
  assert.ok(h.requests.every((request) => request.url !== intentUrl('inbox/seen')), 'reading older content is not reading the latest reply');
  h.store.getState().observeAttention('a', 4, true);
  assert.equal(h.requests.at(-1)?.url, intentUrl('inbox/seen'));
});

test('snapshot-derived unread counts exclude seen choices without clearing their required decisions', (t) => {
  const h = setup(t, createCockpitStore());
  h.source.open();
  h.snapshot([], {
    sessions: [
      { ...meta('seen-choice'), attention: 'choice', attnId: 4, seenId: 4 },
      { ...meta('unread-choice'), attention: 'choice', attnId: 5, seenId: 4 },
      { ...meta('seen-ready'), attention: 'ready', attnId: 3, seenId: 3 },
      { ...meta('legacy-choice'), attention: 'choice' },
    ],
  });
  assert.equal(h.store.getState().unreadCount, 1);
  assert.equal(session('seen-choice', h.store).attention, 'choice');
  h.source.emit({ type: 'session/patch', sessionId: 'unread-choice', seenId: 5 });
  assert.equal(h.store.getState().unreadCount, 0);
  assert.equal(session('unread-choice', h.store).attention, 'choice');
  h.source.emit({ type: 'session/patch', sessionId: 'unread-choice', seenId: 4, title: 'Still needs a decision' });
  assert.equal(session('unread-choice', h.store).seenId, 5);
  assert.equal(session('unread-choice', h.store).title, 'Still needs a decision');
  assert.equal(h.store.getState().unreadCount, 0);
  assert.equal(h.requests.length, 0);
});

test('authoritative snapshot totals survive partial patches and adjust only by changed unread rows', (t) => {
  const h = setup(t, createCockpitStore());
  h.source.open();
  const sessions: SessionMeta[] = [
    { ...meta('a'), attention: null, attnId: 1, seenId: 1 },
    { ...meta('b'), attention: 'choice', attnId: 3, seenId: 3 },
  ];
  h.snapshot([], { sessions, unreadCount: 8, inboxRevision: 40 });
  assert.equal(h.store.getState().unreadCount, 8);
  h.source.emit({ type: 'session/patch', sessionId: 'a', title: 'Renamed', lastActivity: 5 });
  h.source.emit({ type: 'session/patch', sessionId: 'b', seenId: 1 });
  assert.equal(h.store.getState().unreadCount, 8);
  assert.equal(session('b', h.store).seenId, 3);
  assert.equal(session('b', h.store).attention, 'choice');

  for (let repeat = 0; repeat < 2; repeat++) {
    h.source.emit({ type: 'session/patch', sessionId: 'a', attention: 'ready', attnId: 2 });
    assert.equal(h.store.getState().unreadCount, 9);
  }
  h.source.emit({ type: 'session/patch', sessionId: 'a', nativeProcessing: true });
  assert.equal(h.store.getState().unreadCount, 9, 'native activity is not an unread source');
  h.source.emit({ type: 'session/patch', sessionId: 'a', attention: null, seenId: 2 });
  assert.equal(h.store.getState().unreadCount, 8);
  for (let repeat = 0; repeat < 2; repeat++) {
    h.source.emit({ type: 'session/added', session: { ...meta('c'), attention: 'ready', attnId: 1, seenId: 0 } });
    assert.equal(h.store.getState().unreadCount, 9);
  }
  h.source.emit({ type: 'session/removed', sessionId: 'c' });
  assert.equal(h.store.getState().unreadCount, 8);
  h.snapshot([], { sessions, unreadCount: 40, inboxRevision: 41 });
  assert.equal(h.store.getState().unreadCount, 40, 'a fresh server total replaces the previous projection');
  assert.equal(h.store.getState().inboxRevision, 41);
  assert.equal(h.requests.length, 0);
});

for (const includeCount of [true, false]) {
  test(`notify before its metadata patch is counted once (${includeCount ? 'authoritative' : 'derived'} total)`, (t) => {
    const h = setup(t, createCockpitStore());
    h.source.open();
    h.snapshot([], {
      sessions: [{ ...meta('a'), attention: null, attnId: 1, seenId: 1 }],
      unreadCount: 5, inboxRevision: 10,
    });
    const notification: Extract<ServerEvent, { type: 'session/notify' }> = {
      type: 'session/notify', sessionId: 'a', title: 'Ready', attention: 'ready', body: 'Done',
      attnId: 2, inboxRevision: 11, ...(includeCount ? { unreadCount: 6 } : {}),
    };
    h.source.emit(notification);
    assert.equal(h.store.getState().unreadCount, 6);
    assert.equal(h.store.getState().inboxRevision, 11);
    assert.equal(session('a', h.store).attention, 'ready');
    assert.equal(session('a', h.store).attnId, 2);
    h.source.emit({ type: 'session/patch', sessionId: 'a', attention: 'ready', attnId: 2 });
    h.source.emit({ type: 'session/patch', sessionId: 'a', title: 'Renamed' });
    h.source.emit(notification);
    assert.equal(h.store.getState().unreadCount, 6);

    h.source.emit({ ...notification, attnId: 3, inboxRevision: 9, unreadCount: 99 });
    h.source.emit({ ...notification, attnId: 3, inboxRevision: undefined, unreadCount: 99 });
    h.source.emit({ ...notification, attnId: 1, inboxRevision: 12, unreadCount: 99 });
    assert.equal(h.store.getState().unreadCount, 6);
    assert.equal(h.store.getState().inboxRevision, 11);
    assert.equal(session('a', h.store).attnId, 2);

    h.source.emit({ type: 'session/patch', sessionId: 'a', attention: null, seenId: 2 });
    assert.equal(h.store.getState().unreadCount, 5);
    h.source.emit({ ...notification, inboxRevision: 12, unreadCount: 99 });
    assert.equal(h.store.getState().unreadCount, 5, 'a notification already seen cannot restore a stale total');
    assert.equal(session('a', h.store).attention, null);
    assert.equal(h.requests.length, 0);
  });
}
