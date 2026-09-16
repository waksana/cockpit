import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { NativeChatEvent, NativeChatPage, NativeChatRead, ServerEvent, SessionMeta } from '@cockpit/protocol';
import { createCockpitStore } from './store';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { createSessionDrafts } from '../lib/textDraft';
import { NativeWindow } from './nativeWindow';

function replace(t: TestContext, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
}
const meta = (sessionId: string, loaded = true): SessionMeta => ({
  sessionId, title: sessionId, cwd: '/fixture', status: loaded ? 'idle' : 'unloaded',
  loaded, lastActivity: 1, queue: [], ask: null, error: null,
});
const message = (id: string, content = id): NativeChatEvent => ({
  id: `event-${id}`, type: 'assistant.message', data: { messageId: id, content }, timestamp: 1,
});
const ephemeral = (type: string, id: string, deltaContent?: string): NativeChatEvent => ({
  id: `${type}-${id}-${deltaContent ?? ''}`, type, ephemeral: true,
  data: { messageId: id, ...(deltaContent !== undefined ? { deltaContent } : {}) }, timestamp: 1,
});

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  replace(t, 'document', document);
  const local = new Map<string, string>();
  replace(t, 'localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  const sources: Source[] = [];
  class Source {
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { sources.push(this); }
    close() { this.readyState = Source.CLOSED; }
    open() { this.readyState = Source.OPEN; this.onopen?.(); }
    drop() { this.readyState = 0; this.onerror?.(); }
    emit(event: ServerEvent) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  replace(t, 'EventSource', Source);
  const requests: {
    path: string; body: NativeChatRead; signal?: AbortSignal | null;
    init?: RequestInit; stream?: ReadableStreamDefaultController<Uint8Array>; ended?: boolean;
    resolve: (response: Response) => void; reject: (error: Error) => void;
  }[] = [];
  t.mock.method(globalThis, 'fetch', (input, init) => new Promise<Response>((resolve, reject) => {
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal, init, resolve, reject });
  }));
  const store = createCockpitStore();
  const cleanup = store.getState().init();
  const source = sources[0];
  t.after(async () => {
    cleanup();
    for (const request of requests) {
      request.reject(new DOMException('Aborted', 'AbortError'));
      if (request.stream && !request.ended) {
        request.ended = true;
        request.stream.error(new DOMException('Aborted', 'AbortError'));
      }
    }
    await setImmediate();
    for (const error of getUxErrors()) dismissUxError(error.id);
  });
  const snapshot = (sessions = [meta('a'), meta('b')]) => source.emit({
    type: 'snapshot', agentStatus: 'up', permissionPolicy: 'allow-all', models: [], sessions,
  });
  const state = (id = 'a') => store.getState().sessions.find(session => session.sessionId === id)!;
  const ids = (id = 'a') => state(id).messages.map(message => message.id);
  const tick = async () => { t.mock.timers.tick(0); await setImmediate(); };
  const frame = async (index: number, event: unknown) => {
    const request = requests[index];
    assert.ok(request.path.endsWith('/chat/stream'));
    if (!request.stream) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { request.stream = controller; },
      });
      request.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
      request.signal?.addEventListener('abort', () => {
        if (!request.ended) {
          request.ended = true;
          request.stream!.error(new DOMException('Aborted', 'AbortError'));
        }
      }, { once: true });
    }
    request.stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    await setImmediate();
  };
  const endStream = async (index: number, error?: Error) => {
    const request = requests[index];
    assert.ok(request.stream);
    request.ended = true;
    if (error) request.stream.error(error);
    else request.stream.close();
    await setImmediate();
  };
  const reply = async (index: number, events: NativeChatEvent[], extra: Partial<NativeChatPage> = {}) => {
    const request = requests[index];
    assert.ok(request, `Missing request ${index}`);
    const streaming = request.path.endsWith('/chat/stream');
    assert.ok(streaming || request.path.endsWith('/session/chat'));
    const { body } = request;
    const page = {
      sessionId: body.sessionId, source: streaming ? 'live' : body.source, direction: streaming ? 'forward' : body.direction,
      events, cursor: `cursor-${index}`, cursorStatus: 'ok', hasMore: false,
      ...(body.bootstrap ? { liveCursor: 'tail-before-page' } : {}),
      read: { rpc: body.bootstrap ? 2 : 1, events: events.length }, ...extra,
    };
    if (streaming) return frame(index, { type: 'page', page });
    request.resolve(Response.json(page));
    await setImmediate();
  };
  const start = async () => {
    source.open(); snapshot(); store.getState().setActiveId('a');
    await reply(0, [message('A')], { hasMore: true });
    await reply(1, []);
    await tick();
  };
  return { store, source, document, requests, snapshot, state, ids, reply, frame, endStream, tick, start };
}

test('native chat starts only after selection, open and snapshot, then keeps one all-agent SSE connection', async t => {
  const h = setup(t);
  h.store.getState().setActiveId('a');
  h.source.open();
  assert.equal(h.requests.length, 0);
  h.snapshot();
  assert.deepEqual(h.requests[0].body, {
    sessionId: 'a', source: 'live', direction: 'backward', max: 200, waitMs: 0, bootstrap: true, agentScope: 'all',
  });

  await h.reply(0, [message('A')], { hasMore: true });
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].path.endsWith('/chat/stream'));
  assert.deepEqual(h.requests[1].body, { sessionId: 'a', cursor: 'tail-before-page', max: 64, agentScope: 'all' });
  assert.equal(h.requests[1].init?.method, 'POST');
  assert.equal(h.requests[1].init?.credentials, 'include');
  await h.reply(1, []);
  await h.tick();
  await h.reply(1, [message('B')], { cursor: 'next-page' });
  await h.tick();
  assert.equal(h.requests.length, 2, 'catchup and live frames need neither HTTP page reads nor ACKs');
  assert.deepEqual(h.ids(), ['A', 'B']);
  assert.equal('autoNameSession' in h.store.getState(), false);
  assert.equal('renameSession' in h.store.getState(), false);
});

test('older reads coalesce repeated triggers, and exhaustion suppresses all later triggers', async t => {
  const h = setup(t);
  await h.start();
  for (let i = 0; i < 20; i++) h.store.getState().loadMore('a');
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].body.max, 200);
  await h.reply(2, [message('older')], { hasMore: false });
  for (let i = 0; i < 20; i++) h.store.getState().loadMore('a');
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.ids(), ['older', 'A']);
});

for (const loaded of [false, true]) {
  test(`native-sized history pages preserve cursor continuation and publication (loaded=${loaded})`, async t => {
    const h = setup(t);
    h.source.open(); h.snapshot([meta('a', loaded)]);
    h.store.getState().setActiveId('a');
    assert.equal(h.requests[0].body.max, 200);
    assert.equal(h.requests[0].body.source, loaded ? 'live' : 'persisted');
    const latest = Array.from({ length: 200 }, (_, i) => message(`m${100 + i}`));
    await h.reply(0, latest, { cursor: 'opaque-native-older-boundary', hasMore: true });
    assert.deepEqual(h.ids(), latest.map(e => e.data.messageId), 'publish the native page without splitting into smaller UI batches');
    if (loaded) {
      assert.equal(h.requests[1].body.max, 64, 'live SSE batching is unchanged');
      await h.reply(1, []);
    }
    const next = h.requests.length;
    for (let i = 0; i < 10; i++) h.store.getState().loadMore('a');
    assert.equal(h.requests.length, next + 1);
    assert.equal(h.requests[next].body.max, 200);
    assert.equal(h.requests[next].body.cursor, 'opaque-native-older-boundary');
    const older = Array.from({ length: 100 }, (_, i) => message(`m${i}`));
    await h.reply(next, older, { cursor: 'native-beginning', hasMore: false });
    assert.deepEqual(h.ids(), Array.from({ length: 300 }, (_, i) => `m${i}`));
    h.store.getState().loadMore('a');
    assert.equal(h.requests.length, next + 1, 'native exhaustion stops subsequent paging');
  });
}

test('child execution labels use only existing initial, older and reconnect pages without extra requests', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  const owner: NativeChatEvent = { id: 'owner', type: 'assistant.message', data: {
    messageId: 'owner', toolRequests: [{ name: 'task', toolCallId: 'spawn' }],
  } };
  const started: NativeChatEvent = { id: 'started', type: 'subagent.started', agentId: 'child', data: { toolCallId: 'spawn' } };
  const completed: NativeChatEvent = { id: 'completed', type: 'subagent.completed', data: { toolCallId: 'spawn' } };
  await h.reply(0, [owner, started, completed], { hasMore: true });
  await h.reply(1, []);
  const card = () => h.state().messages.find(message => message.subagent)!;
  assert.equal(card().subagent?.status, 'completed');
  assert.equal(h.requests.length, 2);
  h.store.getState().loadMore('a');
  await h.reply(2, [message('older')]);
  assert.equal(h.requests.length, 3);
  assert.equal(card().subagent?.status, 'completed');
  await h.reply(1, [{ id: 'turn', type: 'assistant.turn_start', agentId: 'child', data: { turnId: '0' } }]);
  assert.equal(card().subagent?.status, 'activity');
  await h.reply(1, [
    { ...ephemeral('assistant.message_start', 'child-partial'), agentId: 'child' },
    { ...ephemeral('assistant.message_delta', 'child-partial', 'prefix'), agentId: 'child' },
  ], { cursor: 'before-gap' });
  await h.endStream(1);
  assert.equal(h.state().partialHistory, true);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.requests[3].body, { sessionId: 'a', cursor: 'before-gap', max: 64, agentScope: 'all' });
  await h.reply(3, [
    { ...message('child-partial', 'Full child reply'), agentId: 'child' },
    { id: 'cancelled', type: 'subagent.completed', data: { toolCallId: 'spawn', cancelled: true } },
  ]);
  assert.equal(card().subagent?.status, 'cancelled');
  assert.equal(h.state().partialHistory, false);
  await h.reply(3, [started, completed]);
  assert.equal(card().subagent?.status, 'cancelled', 'old duplicate lifecycle cannot regress cancellation');
  assert.equal(h.requests.length, 4, 'exactly initial history, stream, requested older page, reconnect stream');
  assert.equal(h.requests.filter(request => request.path.endsWith('/session/chat')).length, 2);
  assert.ok(h.requests.every(request => /\/(?:session\/chat|chat\/stream)$/.test(request.path)));
});

test('hiding a reading window cancels its older read and rejects further preload signals', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  h.document.visibilityState = 'hidden';
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.requests[2].signal?.aborted, true);
  for (let i = 0; i < 10; i++) h.store.getState().loadMore('a');
  assert.equal(h.requests.length, 3);
  await h.reply(2, [message('obsolete')]);
  assert.deepEqual(h.ids(), ['A']);
});

test('older history failures survive metadata refresh and retry the existing older cursor, not the live cursor', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  h.requests[2].reject(new Error('older read offline'));
  await setImmediate();
  assert.equal(h.state().historyError, 'older read offline');
  h.snapshot();
  await setImmediate();
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 2);
  assert.equal(h.state().historyError, 'older read offline');
  const liveBeforeRetry = h.requests.findLast(request => request.path.endsWith('/chat/stream'))!;
  h.store.getState().retryHistory('a');
  const retry = h.requests.length - 1;
  assert.equal(h.requests[retry].body.direction, 'backward');
  assert.equal(h.requests[retry].body.cursor, h.requests[2].body.cursor);
  assert.equal(liveBeforeRetry.signal?.aborted, false);
  await h.reply(retry, [message('older')]);
  assert.equal(h.state().historyError, undefined);
  assert.deepEqual(h.ids(), ['older', 'A']);
});

test('initial result-only history stays bounded and follows the original live tail without an owner scan', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  const result: NativeChatEvent = {
    id: 'tool-result', type: 'tool.execution_complete', timestamp: 1,
    data: { toolCallId: 'tool', success: true, result: { content: 'result' } },
  };
  await h.reply(0, [result, message('B')], { hasMore: true });
  assert.equal(h.state().loadingHistory, false);
  assert.equal(h.state().incompleteBoundary, false);
  assert.deepEqual(h.ids(), ['tool-tool', 'B']);
  assert.equal(h.state().messages[0].toolCalls?.[0].output, 'result');
  assert.equal(h.state().messages[0].toolCalls?.[0].title, '缺少工具开始记录');
  assert.ok(h.requests[1].path.endsWith('/chat/stream'));
  assert.equal(h.requests[1].body.cursor, 'tail-before-page');
});

test('switching sessions during boundary completion aborts the remaining history work', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  await h.reply(0, [{ id: 'result', type: 'tool.execution_complete', data: { toolCallId: 'tool' }, timestamp: 1 }],
    { hasMore: true });
  h.store.getState().setActiveId('b');
  assert.equal(h.requests[1].signal?.aborted, true);
  await h.reply(1, [message('obsolete')], { hasMore: true });
  await h.reply(2, [message('current')]);
  assert.deepEqual(h.ids('b'), ['current']);
  assert.equal(h.requests.filter(request => request.body.sessionId === 'a').length, 2);
});

test('older history and the latest native update interleave without dropping rows or clearing the older loader', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  assert.equal(h.requests[2].body.cursor, 'cursor-0');
  assert.equal(h.requests[2].body.direction, 'backward');
  await h.reply(1, [message('B')]);
  assert.equal(h.state().loadingHistory, true);
  await h.reply(2, [message('older')]);
  assert.deepEqual(h.ids(), ['older', 'A', 'B']);
  assert.equal(h.state().loadingHistory, false);
  assert.equal('unreadCount' in h.store.getState(), false, 'native reading does not introduce an inbox');
});

test('all browser reading windows and drafts survive navigation without a three-window cap', async t => {
  const h = setup(t);
  const draft = createSessionDrafts();
  h.source.open(); h.snapshot(['a', 'b', 'c', 'd', 'e'].map(id => meta(id, false)));
  for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) {
    h.store.getState().setActiveId(id);
    await h.reply(index, [message(id)]);
  }
  draft('a').edit('unsent');
  h.store.getState().setActiveId(null);
  h.store.getState().setActiveId('a');
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.ids(), ['a']);
  assert.equal(draft('a').getSnapshot().text, 'unsent');
});

for (const failure of [false, true]) {
  test(`switching sessions aborts the old initial read and discards its late ${failure ? 'failure' : 'success'}`, async t => {
    const h = setup(t);
    h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
    h.store.getState().setActiveId('b');
    assert.equal(h.requests[0].signal?.aborted, true);
    if (failure) { h.requests[0].reject(new Error('late old failure')); await setImmediate(); }
    else await h.reply(0, [message('obsolete')]);
    await h.reply(1, [message('current')]);
    assert.deepEqual(h.ids('a'), []);
    assert.deepEqual(h.ids('b'), ['current']);
    assert.equal(h.state('b').error, null);
  });
}

for (const pause of ['stream-switch', 'stream-hide', 'pending-switch', 'pending-hide', 'transport', 'eof'] as const) {
  test(`${pause} preserves partial C and waits for a complete durable replacement`, async t => {
    const h = setup(t);
    await h.start();
    await h.reply(1, [ephemeral('assistant.message_start', 'C'), ephemeral('assistant.message_delta', 'C', 'prefix')]);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix');
    if (pause.startsWith('pending')) {
      await h.endStream(1);
      t.mock.timers.tick(1000); await setImmediate();
    }
    if (pause.endsWith('switch')) h.store.getState().setActiveId(null);
    else if (pause.endsWith('hide')) {
      h.document.visibilityState = 'hidden';
      h.document.dispatchEvent(new Event('visibilitychange'));
    } else await h.endStream(1, pause === 'transport' ? new TypeError('offline') : undefined);
    assert.equal(h.state().partialHistory, true);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix');
    if (pause.endsWith('switch')) h.store.getState().setActiveId('a');
    else if (pause.endsWith('hide')) {
      h.document.visibilityState = 'visible';
      h.document.dispatchEvent(new Event('visibilitychange'));
    } else { t.mock.timers.tick(1000); await setImmediate(); }
    const resumed = h.requests.length - 1;
    assert.ok(h.requests[resumed].path.endsWith('/chat/stream'));
    assert.equal(h.requests[resumed].body.cursor, 'cursor-1');
    assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
    await h.reply(resumed, []);
    await h.tick();
    await h.reply(resumed, [ephemeral('assistant.message_delta', 'C', 'suffix')]);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix');
    await h.tick();
    await h.reply(resumed, [message('C', 'prefix + missed part + suffix')]);
    assert.deepEqual(h.ids(), ['A', 'C']);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix + missed part + suffix');
    assert.equal(h.state().partialHistory, false);
  });
}

test('native cursor expiry preserves the screen and requires an explicit fresh-page retry', async t => {
  const h = setup(t);
  await h.start();
  await h.reply(1, [message('must-not-apply')], { cursorStatus: 'expired' });
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.state().historyStale, true);
  await h.tick();
  assert.equal(h.requests.length, 2);
  h.store.getState().retryHistory('a');
  assert.equal(h.requests[2].body.direction, 'backward');
  assert.equal(h.requests[2].body.cursor, undefined);
  await h.reply(2, [message('fresh')]);
  assert.deepEqual(h.ids(), ['fresh']);
});

for (const reason of ['expired', 'rewind'] as const) {
  test(`explicit resync after ${reason} preserves all child history and future lifecycle updates`, async t => {
    const h = setup(t);
    await h.start();
    if (reason === 'expired') await h.reply(1, [], { cursorStatus: 'expired' });
    else h.source.emit({ type: 'chat/invalidated', sessionId: 'a', reason: 'rewind' });
    h.store.getState().retryHistory('a');
    assert.equal(h.requests[2].body.agentScope, 'all');
    await h.reply(2, [
      { id: 'task-owner', type: 'assistant.message', data: {
        toolRequests: [{ toolCallId: 'spawn', name: 'task', arguments: { description: 'Owned child' } }],
      } },
      { id: 'child-started', type: 'subagent.started', data: { toolCallId: 'spawn', agentId: 'child' } },
      { ...message('child-before'), agentId: 'child' },
      { id: 'child-done', type: 'subagent.completed', data: { toolCallId: 'spawn' } },
    ]);
    const child = () => h.state().messages.find(message => message.subagent)!;
    assert.deepEqual(child().subMessages?.map(message => message.id), ['child-before']);
    assert.equal(child().subagent?.status, 'completed');
    await h.reply(3, []);
    await h.reply(3, [
      { ...message('child-after'), agentId: 'child' },
      { id: 'child-failed', type: 'subagent.failed', data: { toolCallId: 'spawn', error: 'Synthetic failure' } },
    ]);
    assert.deepEqual(child().subMessages?.map(message => message.id), ['child-before', 'child-after']);
    assert.equal(child().subagent?.status, 'failed');
    assert.equal(child().subagent?.error, 'Synthetic failure');
    assert.equal(h.requests.length, 4, 'child resync has no independent reader');
  });
}

test('metadata-only native availability changes switch chat sources without replaying the window', async t => {
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  assert.ok(h.requests[2].path.endsWith('/session/resources'));
  h.requests[2].resolve(Response.json({ meta: meta('a', false) }));
  await setImmediate();
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.requests[3].body.source, 'persisted');
  assert.equal(h.requests[3].body.cursor, 'cursor-1');
  await h.reply(3, [message('B')]);
  await h.tick();
  assert.equal(h.requests.length, 4);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.requests[4].resolve(Response.json({ meta: meta('a') }));
  await setImmediate();
  assert.ok(h.requests[5].path.endsWith('/chat/stream'));
  assert.equal(h.requests[5].body.cursor, 'cursor-3');
  assert.deepEqual(h.ids(), ['A', 'B']);
});

test('ordinary metadata invalidation does not interrupt a matching live chat request', async t => {
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.requests[2].resolve(Response.json({ meta: { ...meta('a'), title: 'fresh native title' } }));
  await setImmediate();
  assert.equal(h.state().title, 'fresh native title');
  assert.equal(h.requests[1].signal?.aborted, false);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.ids(), ['A']);
});

test('unload continues a known forward cursor passively, then reload resumes live without retransmitting the window', async t => {
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false, status: 'unloaded' });
  assert.equal(h.requests[1].signal?.aborted, true);
  const passive = h.requests[2];
  assert.equal(passive.body.source, 'persisted');
  assert.equal(passive.body.cursor, 'cursor-1');
  assert.equal(passive.body.agentScope, undefined);
  assert.equal(passive.body.waitMs, 0);
  await h.reply(2, [message('B')], { hasMore: true });
  await h.tick();
  assert.equal(h.requests[3].body.source, 'persisted');
  assert.equal(h.requests[3].body.cursor, 'cursor-2');
  await h.reply(3, []);
  await h.tick();
  assert.equal(h.requests.length, 4, 'an unloaded caught-up source is not continuously polled');
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: true, status: 'idle' });
  assert.ok(h.requests[4].path.endsWith('/chat/stream'));
  assert.equal(h.requests[4].body.cursor, 'cursor-3');
  assert.deepEqual(h.ids(), ['A', 'B']);
});

test('browser reconnect keeps loaded older rows and resumes from its last native cursor', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  await h.reply(2, [message('older')]);
  h.source.drop();
  assert.equal(h.requests[1].signal?.aborted, true);
  h.source.open();
  assert.equal(h.requests.length, 3);
  h.snapshot();
  assert.ok(h.requests[3].path.endsWith('/chat/stream'));
  assert.equal(h.requests[3].body.cursor, 'cursor-1');
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 2);
  await h.reply(3, [message('B')]);
  assert.deepEqual(h.ids(), ['older', 'A', 'B']);
});

for (const success of [false, true]) {
  test(`explicit load ${success ? 'success' : 'failure'} never interrupts or resets an already loaded chat`, async t => {
    const h = setup(t);
    await h.start();
    const pending = h.store.getState().loadSession('a');
    void pending.catch(() => {});
    assert.equal(h.state().historyStale, false);
    assert.equal(h.requests[1].signal?.aborted, false);
    assert.ok(h.requests[2].path.endsWith('/session/load'));
    assert.deepEqual(h.requests[2].body, { sessionId: 'a' });
    h.requests[2].resolve(Response.json(success ? { ok: true, sessionId: 'a' } : { error: 'native load failed' }, { status: success ? 200 : 400 }));
    if (success) await pending; else await assert.rejects(pending, /native load failed/);
    await setImmediate();
    assert.deepEqual(h.ids(), ['A']);
    assert.equal(h.state().historyStale, false);
    assert.equal(h.requests[1].signal?.aborted, false);
    assert.equal(h.requests.length, 3);
    await h.reply(1, [message('B')]);
    assert.deepEqual(h.ids(), ['A', 'B']);
    assert.equal(h.requests.length, 3, 'load must never close/reload the chat or implicitly read history');
  });
}

test('an external rewind invalidation before a retained mutation ACK is not replaced by a fresh window', async t => {
  const h = setup(t);
  await h.start();
  const pending = h.store.getState().loadSession('a');
  h.source.emit({ type: 'chat/invalidated', sessionId: 'a', reason: 'rewind' });
  assert.equal(h.requests[1].signal?.aborted, true);
  h.requests[2].resolve(Response.json({ ok: true, sessionId: 'a' }));
  await pending;
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.state().historyStale, true);
  await h.tick();
  assert.equal(h.requests.length, 3);
});

test('external rewind cancels concurrent older and live reads and rejects late history before explicit resync', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  h.source.emit({ type: 'chat/invalidated', sessionId: 'a', reason: 'rewind' });
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.requests[2].signal?.aborted, true);
  assert.equal(h.state().historyStale, true);
  await h.reply(2, [message('obsolete')]);
  await h.tick();
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.requests.length, 3);
  h.store.getState().retryHistory('a');
  assert.equal(h.requests[3].body.direction, 'backward');
  assert.equal(h.requests[3].body.cursor, undefined);
  await h.reply(3, [message('after-rewind')]);
  assert.deepEqual(h.ids(), ['after-rewind']);
  assert.equal(h.state().historyStale, false);
});

for (const success of [true, false]) {
  test(`external native compaction (${success}) and legacy invalidation leave older/live reads and their cursors intact`, async t => {
    const h = setup(t);
    await h.start();
    h.store.getState().loadMore('a');
    h.source.emit({ type: 'session/patch', sessionId: 'a', compacting: true });
    assert.equal(h.state().compacting, true);
    assert.equal(h.requests[1].signal?.aborted, false);
    assert.equal(h.requests[2].signal?.aborted, false);
    h.source.emit({ type: 'chat/invalidated', sessionId: 'a', reason: 'compaction' });
    assert.equal(h.state().historyStale, false);
    assert.equal(h.state().loadingHistory, true);
    h.source.emit({ type: 'session/patch', sessionId: 'a', compacting: false, error: success ? null : 'compaction failed' });
    await h.reply(2, [message('older')], { hasMore: true });
    await h.reply(1, [message('B')]);
    await h.tick();
    assert.deepEqual(h.ids(), ['older', 'A', 'B']);
    assert.equal(h.state().historyStale, false);
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[1].signal?.aborted, false);
    if (success) assert.equal(h.state().error, null);
    else assert.equal(h.state().error, 'compaction failed');
    assert.equal(h.state().compacting, false);
    assert.doesNotMatch(h.state().error ?? '', /原生历史已变更|重新同步/);
  });
}

test('automatic compaction signals do not cancel initial history or mark it stale', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  h.source.emit({ type: 'chat/invalidated', sessionId: 'a', reason: 'compaction' });
  assert.equal(h.requests[0].signal?.aborted, false);
  assert.equal(h.state().loadingHistory, true);
  await h.reply(0, [message('A')]);
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.state().historyStale, false);
  assert.equal(h.state().error, null);
  assert.equal(h.requests[1].body.cursor, 'tail-before-page');
});

test('empty stream pages and repeated durable or ephemeral frames preserve message identity', async t => {
  const h = setup(t);
  await h.start();
  const original = h.state().messages;
  await h.reply(1, [], { cursor: 'empty-page' });
  assert.equal(h.state().messages, original);
  await h.reply(1, [message('A')], { cursor: 'duplicate-page' });
  assert.equal(h.state().messages, original);
  const partial = [ephemeral('assistant.message_start', 'B'), ephemeral('assistant.message_delta', 'B', 'prefix')];
  await h.reply(1, partial);
  const streaming = h.state().messages;
  await h.reply(1, partial);
  assert.equal(h.state().messages, streaming);
  assert.equal(h.state().messages.at(-1)?.content, 'prefix');
  await h.reply(1, [message('B', 'complete')]);
  const complete = h.state().messages;
  await h.reply(1, [message('B', 'complete')]);
  assert.equal(h.state().messages, complete);
  assert.deepEqual(h.ids(), ['A', 'B']);
  assert.equal(h.requests.length, 2);
});

test('empty and duplicate stream pages advance the shared cursor without publishing store updates', async t => {
  const h = setup(t);
  await h.start();
  const original = h.store.getState();
  let updates = 0;
  const unsubscribe = h.store.subscribe(() => { updates++; });
  t.after(unsubscribe);
  await h.reply(1, [], { cursor: 'empty-advance' });
  await h.reply(1, [message('A')], { cursor: 'duplicate-advance' });
  await h.reply(1, [], { cursor: 'latest-empty-advance' });
  assert.equal(updates, 0);
  assert.equal(h.store.getState(), original);
  assert.equal(h.requests.length, 2);
  unsubscribe();
  await h.endStream(1);
  t.mock.timers.tick(1000); await setImmediate();
  assert.deepEqual(h.requests[2].body, {
    sessionId: 'a', cursor: 'latest-empty-advance', max: 64, agentScope: 'all',
  });
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
});

test('durable catchup overlaps bootstrap in append order and drains over a single stream', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  await h.reply(0, [message('A')], { hasMore: true });
  await h.reply(1, [message('outside-window')], { hasMore: true, cursor: 'catchup-1' });
  assert.deepEqual(h.ids(), ['A']);
  await h.reply(1, [message('A'), message('B')], { hasMore: true, cursor: 'catchup-2' });
  assert.deepEqual(h.ids(), ['A']);
  await h.reply(1, [], { cursor: 'catchup-end' });
  assert.deepEqual(h.ids(), ['A', 'B']);
  await h.reply(1, [message('C')], { cursor: 'live-C' });
  assert.deepEqual(h.ids(), ['A', 'B', 'C']);
  assert.equal(h.requests.length, 2);
  await h.endStream(1);
  t.mock.timers.tick(999); await setImmediate();
  assert.equal(h.requests.length, 2);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(h.requests[2].body.cursor, 'live-C');
  assert.ok(h.requests[2].path.endsWith('/chat/stream'));
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
});

test('an empty native tail sentinel is sent as a required stream cursor, without a second bootstrap', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  await h.reply(0, [], { cursor: '', liveCursor: '' });
  assert.equal(h.requests[1].body.cursor, '');
  assert.ok(h.requests[1].path.endsWith('/chat/stream'));
  await h.reply(1, [], { cursor: '' });
  await h.endStream(1);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(h.requests[2].body.cursor, '');
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
});

test('a failed stream fetch reconnects from the original native tail without rereading history', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  await h.reply(0, [message('A')]);
  h.requests[1].reject(new TypeError('Failed to fetch'));
  await setImmediate();
  t.mock.timers.tick(999); await setImmediate();
  assert.equal(h.requests.length, 2);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(h.requests[2].body.cursor, 'tail-before-page');
  assert.ok(h.requests[2].path.endsWith('/chat/stream'));
  await h.reply(2, [message('A'), message('B')]);
  assert.deepEqual(h.ids(), ['A', 'B']);
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
});

for (const failure of [false, true]) {
  test(`a superseded stream fetch cannot publish a late ${failure ? 'failure' : 'page'}`, async t => {
    const h = setup(t);
    h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
    await h.reply(0, [message('A')]);
    h.store.getState().setActiveId('b');
    assert.equal(h.requests[1].signal?.aborted, true);
    if (failure) {
      h.requests[1].reject(new TypeError('late failure'));
      await setImmediate();
    } else await h.reply(1, [message('obsolete')]);
    await h.reply(2, [message('B')]);
    await h.reply(3, []);
    t.mock.timers.tick(1000); await setImmediate();
    assert.deepEqual(h.ids('a'), ['A']);
    assert.deepEqual(h.ids('b'), ['B']);
    assert.equal(h.state('b').error, null);
    assert.equal(h.requests.length, 4);
  });
}

for (const extra of [{ sessionId: 'b' }, { source: 'persisted' as const }, { direction: 'backward' as const }]) {
  test(`stream pages cannot cross the owning request boundary: ${JSON.stringify(extra)}`, async t => {
    const h = setup(t);
    await h.start();
    await h.reply(1, [message('wrong-owner')], extra);
    assert.deepEqual(h.ids(), ['A']);
    assert.deepEqual(h.ids('b'), []);
    assert.match(h.state().error ?? '', /不匹配/);
    t.mock.timers.tick(1000); await setImmediate();
    assert.equal(h.requests.length, 2);
  });
}

test('an application error SSE frame retains the window and does not transport-retry', async t => {
  const h = setup(t);
  await h.start();
  await h.frame(1, { type: 'error', error: 'native read failed' });
  assert.deepEqual(h.ids(), ['A']);
  assert.match(h.state().error ?? '', /native read failed/);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(h.requests.length, 2);
});

test('a malformed SSE frame fails closed instead of applying an unvalidated page or retrying forever', async t => {
  const h = setup(t);
  await h.start();
  await h.frame(1, { type: 'page', page: {
    sessionId: 'a', source: 'live', direction: 'forward', events: [message('unvalidated')],
    cursor: 'malformed', cursorStatus: 'ok', hasMore: false,
  } });
  assert.deepEqual(h.ids(), ['A']);
  assert.match(h.state().error ?? '', /聊天同步暂停/);
  t.mock.timers.tick(5000); await setImmediate();
  assert.equal(h.requests.length, 2);
});

test('unloaded initial history never implicitly starts a live stream or resumes the session', async t => {
  const h = setup(t);
  h.source.open(); h.snapshot([meta('a', false)]); h.store.getState().setActiveId('a');
  await h.reply(0, [message('A')]);
  t.mock.timers.tick(5000); await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.source, 'persisted');
  assert.equal(h.requests[0].body.bootstrap, false);
  assert.equal(h.state().loaded, false);
});

test('one all-agent history and stream materializes and updates collapsed children without child requests', async t => {
  const h = setup(t);
  const owned = (event: NativeChatEvent): NativeChatEvent => ({ ...event, agentId: 'child' });
  const children = () => h.state().messages.find(message => message.subagent?.toolCallId === 'child-task')!.subMessages!;
  h.source.open(); h.snapshot(); h.store.getState().setActiveId('a');
  await h.reply(0, [{ ...message('A'), data: {
    messageId: 'A', content: 'Delegate', toolRequests: [{ toolCallId: 'child-task', name: 'task' }],
  } }, {
    id: 'child-start', type: 'subagent.started', timestamp: 1,
    data: { toolCallId: 'child-task', agentId: 'child', agentDisplayName: 'helper' },
  }, owned(message('child-history'))], { hasMore: true });
  assert.deepEqual(children().map(message => message.id), ['child-history']);
  await h.reply(1, []);
  await h.reply(1, [
    owned(ephemeral('assistant.message_start', 'child-live')),
    owned(ephemeral('assistant.message_delta', 'child-live', 'prefix')),
  ], { cursor: 'child-prefix' });
  assert.equal(children().at(-1)?.content, 'prefix');
  await h.reply(1, [owned(ephemeral('assistant.message_delta', 'child-live', ' suffix'))], { cursor: 'child-suffix' });
  assert.equal(children().at(-1)?.content, 'prefix suffix');
  await h.reply(1, [owned(message('child-live', 'complete child')), message('root-live')], { cursor: 'shared-cursor' });
  assert.deepEqual(children().map(message => message.id), ['child-history', 'child-live']);
  assert.equal(children().at(-1)?.content, 'complete child');
  assert.ok(h.ids().includes('root-live'));
  assert.equal(h.ids().includes('child-live'), false, 'child content stays nested in its owner');
  await h.tick();
  assert.equal(h.requests.length, 2);
  for (const request of h.requests) {
    assert.equal(request.body.agentScope, 'all');
    assert.equal(request.body.agentIds, undefined);
  }
  await h.endStream(1);
  t.mock.timers.tick(1000); await setImmediate();
  assert.deepEqual(h.requests[2].body, { sessionId: 'a', cursor: 'shared-cursor', max: 64, agentScope: 'all' });
  await h.reply(2, [owned(message('child-live', 'complete child')), owned(message('child-next'))]);
  assert.deepEqual(children().map(message => message.id), ['child-history', 'child-live', 'child-next']);
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
  assert.equal(h.requests.length, 3);
});

test('authoritative deletion cancels history and stream without allowing stale replies to recreate the session', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  h.source.emit({ type: 'session/removed', sessionId: 'a' });
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.requests[2].signal?.aborted, true);
  await h.reply(2, [message('obsolete')]);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(h.state(), undefined);
  assert.equal(h.requests.length, 3);
});

function observeWindowRelease(t: TestContext) {
  const calls = new Map<NativeWindow, number>();
  const disconnect = NativeWindow.prototype.disconnect;
  t.mock.method(NativeWindow.prototype, 'disconnect', function (this: NativeWindow) {
    calls.set(this, (calls.get(this) ?? 0) + 1);
    return disconnect.call(this);
  });
  return calls;
}

test('complete reconnect snapshots release absent windows but preserve surviving nested history and drafts', async t => {
  const calls = observeWindowRelease(t);
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['plan'] });
  h.store.getState().setActiveId('b');
  const deletedWindow = [...calls.keys()][0];
  assert.ok(deletedWindow);
  await h.reply(2, [
    { ...message('B'), data: { messageId: 'B', content: 'Delegate', toolRequests: [{ toolCallId: 'task', name: 'task' }] } },
    { id: 'started', type: 'subagent.started', data: { toolCallId: 'task', agentId: 'child' } },
    { ...message('child-history'), agentId: 'child' },
  ]);
  await h.reply(3, [], { cursor: 'b-latest' });
  const messages = h.state('b').messages;
  const nested = messages.find(value => value.subagent)!.subMessages;
  const drafts = createSessionDrafts();
  drafts('b').edit('Keep the surviving draft');
  const draft = drafts('b').getSnapshot();
  h.source.drop(); h.source.open();
  h.snapshot([meta('b')]);
  assert.equal(h.state('a'), undefined);
  assert.equal(h.store.getState().resourceRevisions.a, undefined);
  assert.equal(h.state('b').messages, messages);
  assert.equal(h.state('b').messages.find(value => value.subagent)!.subMessages, nested);
  assert.equal(drafts('b').getSnapshot(), draft);
  assert.equal(h.requests[4].body.cursor, 'b-latest');
  assert.equal(h.requests[4].body.agentScope, 'all');
  const count = calls.get(deletedWindow);
  h.snapshot([meta('b')]);
  assert.equal(calls.get(deletedWindow), count, 'later snapshots cannot revisit an orphaned NativeWindow');
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 2);
});

test('an empty authoritative snapshot releases an active window and rejects its late older response', async t => {
  const calls = observeWindowRelease(t);
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  h.snapshot([]);
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.requests[2].signal?.aborted, true);
  assert.equal(h.store.getState().activeId, 'a', 'the URL still owns selection and renders NotFound');
  await h.reply(2, [message('late-private-window')]);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['plan'] });
  assert.equal(h.state('a'), undefined);
  assert.equal(h.store.getState().resourceRevisions.a, undefined);
  const before = [...calls.values()];
  h.snapshot([]);
  assert.deepEqual([...calls.values()], before, 'no retained window remains after complete absence');
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(h.requests.length, 3);
});

test('partial metadata, added rows, temporary failures and unload preserve existing reading windows', async t => {
  const calls = observeWindowRelease(t);
  const h = setup(t);
  await h.start();
  const messages = h.state().messages;
  h.source.emit({ type: 'session/added', session: meta('c') });
  assert.equal(h.state().messages, messages, 'a single added row is not a complete list');
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model'] });
  await setImmediate();
  h.requests[2].resolve(Response.json({ meta: { sessionId: 'a', loaded: true, currentModelId: 'current' } }));
  await setImmediate();
  assert.equal(h.state().messages, messages);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model'] });
  await setImmediate();
  h.requests[3].resolve(Response.json({ error: 'temporary native read failure' }, { status: 503 }));
  await setImmediate();
  assert.equal(h.state().messages, messages);
  h.store.getState().setActiveId(null);
  const retained = [...calls.keys()][0];
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false, status: 'unloaded' });
  h.snapshot([meta('a', false), meta('b'), meta('c')]);
  assert.equal(h.state().messages, messages);
  const count = calls.get(retained)!;
  h.snapshot([meta('a', false), meta('b'), meta('c')]);
  assert.equal(calls.get(retained), count + 1, 'an unloaded but present session keeps its window');
  h.store.getState().setActiveId('a');
  assert.equal(h.requests[4].body.direction, 'forward');
  assert.equal(h.requests[4].body.source, 'persisted');
  assert.equal(h.requests[4].body.cursor, 'cursor-1');
  assert.equal(h.requests.filter(request => request.body.direction === 'backward').length, 1);
});

test('authoritative meta:null releases the target window, pending readers and dirty metadata follow-ups', async t => {
  const calls = observeWindowRelease(t);
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['identity'] });
  await setImmediate();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model'] });
  h.requests[3].resolve(Response.json({ meta: null }));
  await setImmediate();
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.requests[2].signal?.aborted, true);
  assert.equal(h.requests[3].signal?.aborted, true);
  assert.equal(h.state(), undefined);
  assert.equal(h.store.getState().resourceRevisions.a, undefined);
  await h.reply(2, [message('late')]);
  const before = [...calls.values()];
  h.snapshot([meta('b')]);
  assert.deepEqual([...calls.values()], before);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(h.requests.length, 4, 'absence does not trigger another dirty metadata or history read');
});
