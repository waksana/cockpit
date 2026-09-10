import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { NativeChatEvent, NativeChatPage, NativeChatRead, ServerEvent, SessionMeta } from '@cockpit/protocol';
import { createCockpitStore } from './store';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { createSessionDrafts } from '../lib/attachmentSend';

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
    resolve: (response: Response) => void; reject: (error: Error) => void;
  }[] = [];
  t.mock.method(globalThis, 'fetch', (input, init) => new Promise<Response>((resolve, reject) => {
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal, resolve, reject });
  }));
  const store = createCockpitStore();
  const cleanup = store.getState().init();
  const source = sources[0];
  t.after(async () => {
    cleanup();
    for (const request of requests) request.reject(new DOMException('Aborted', 'AbortError'));
    await setImmediate();
    for (const error of getUxErrors()) dismissUxError(error.id);
  });
  const snapshot = (sessions = [meta('a'), meta('b')]) => source.emit({
    type: 'snapshot', agentStatus: 'up', permissionPolicy: 'allow-all', models: [], sessions,
  });
  const state = (id = 'a') => store.getState().sessions.find(session => session.sessionId === id)!;
  const ids = (id = 'a') => state(id).messages.map(message => message.id);
  const tick = async () => { t.mock.timers.tick(0); await setImmediate(); };
  const reply = async (index: number, events: NativeChatEvent[], extra: Partial<NativeChatPage> = {}) => {
    const request = requests[index];
    assert.ok(request, `Missing request ${index}`);
    assert.ok(request.path.endsWith('/session/chat'));
    const { body } = request;
    request.resolve(Response.json({
      sessionId: body.sessionId, source: body.source, direction: body.direction,
      events, cursor: `cursor-${index}`, cursorStatus: 'ok', hasMore: false,
      ...(body.bootstrap ? { liveCursor: 'tail-before-page' } : {}),
      read: { rpc: body.bootstrap ? 2 : 1, events: events.length }, ...extra,
    }));
    await setImmediate();
  };
  const start = async () => {
    source.open(); snapshot(); store.getState().setActiveId('a');
    await reply(0, [message('A')], { hasMore: true });
    await reply(1, []);
    await tick();
  };
  return { store, source, document, requests, snapshot, state, ids, reply, tick, start };
}

test('native chat starts only after selection, open and snapshot, with one bounded page then forward polling', async t => {
  const h = setup(t);
  h.store.getState().setActiveId('a');
  h.source.open();
  assert.equal(h.requests.length, 0);
  h.snapshot();
  assert.deepEqual(h.requests[0].body, {
    sessionId: 'a', source: 'live', direction: 'backward', max: 8, waitMs: 0, bootstrap: true, agentScope: 'primary',
  });
  await h.reply(0, [message('A')], { hasMore: true });
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.cursor, 'tail-before-page');
  assert.equal(h.requests[1].body.includeEphemeral, false);
  assert.equal(h.requests[1].body.waitMs, 0);
  await h.reply(1, []);
  await h.tick();
  assert.equal(h.requests[2].body.cursor, 'cursor-1');
  assert.equal(h.requests[2].body.includeEphemeral, true);
  assert.equal(h.requests[2].body.waitMs, 1000);
  assert.equal('autoNameSession' in h.store.getState(), false);
  assert.equal('renameSession' in h.store.getState(), false);
});

test('older history and the latest native update interleave without dropping rows or clearing the older loader', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  assert.equal(h.requests[3].body.cursor, 'cursor-0');
  assert.equal(h.requests[3].body.direction, 'backward');
  await h.reply(2, [message('B')]);
  assert.equal(h.state().loadingHistory, true);
  await h.reply(3, [message('older')]);
  assert.deepEqual(h.ids(), ['older', 'A', 'B']);
  assert.equal(h.state().loadingHistory, false);
  assert.equal(h.store.getState().unreadCount, 0, 'chat payloads do not invent attention');
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

for (const pause of ['between-polls-switch', 'between-polls-hide', 'pending-switch', 'pending-hide', 'transport'] as const) {
  test(`${pause} preserves partial C and waits for a complete durable replacement`, async t => {
    const h = setup(t);
    await h.start();
    await h.reply(2, [ephemeral('assistant.message_start', 'C'), ephemeral('assistant.message_delta', 'C', 'prefix')]);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix');
    if (pause.startsWith('pending') || pause === 'transport') await h.tick();
    if (pause.endsWith('switch')) h.store.getState().setActiveId(null);
    else if (pause.endsWith('hide')) {
      h.document.visibilityState = 'hidden';
      h.document.dispatchEvent(new Event('visibilitychange'));
    } else { h.requests[3].reject(new TypeError('offline')); await setImmediate(); }
    assert.equal(h.state().partialHistory, true);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix');
    if (pause.endsWith('switch')) h.store.getState().setActiveId('a');
    else if (pause.endsWith('hide')) {
      h.document.visibilityState = 'visible';
      h.document.dispatchEvent(new Event('visibilitychange'));
    } else { t.mock.timers.tick(1000); await setImmediate(); }
    const resumed = h.requests.length - 1;
    assert.equal(h.requests[resumed].body.includeEphemeral, false);
    await h.reply(resumed, []);
    await h.tick();
    await h.reply(resumed + 1, [ephemeral('assistant.message_delta', 'C', 'suffix')]);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix');
    await h.tick();
    await h.reply(resumed + 2, [message('C', 'prefix + missed part + suffix')]);
    assert.deepEqual(h.ids(), ['A', 'C']);
    assert.equal(h.state().messages.at(-1)?.content, 'prefix + missed part + suffix');
    assert.equal(h.state().partialHistory, false);
  });
}

test('native cursor expiry preserves the screen and requires an explicit fresh-page retry', async t => {
  const h = setup(t);
  await h.start();
  await h.reply(2, [message('must-not-apply')], { cursorStatus: 'expired' });
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.state().historyStale, true);
  await h.tick();
  assert.equal(h.requests.length, 3);
  h.store.getState().retryHistory('a');
  assert.equal(h.requests[3].body.direction, 'backward');
  assert.equal(h.requests[3].body.cursor, undefined);
  await h.reply(3, [message('fresh')]);
  assert.deepEqual(h.ids(), ['fresh']);
});

test('metadata-only native availability changes switch chat sources without replaying the window', async t => {
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  assert.ok(h.requests[3].path.endsWith('/session/get'));
  h.requests[3].resolve(Response.json({ meta: meta('a', false) }));
  await setImmediate();
  assert.equal(h.requests[2].signal?.aborted, true);
  assert.equal(h.requests[4].body.source, 'persisted');
  assert.equal(h.requests[4].body.cursor, 'cursor-1');
  await h.reply(4, [message('B')]);
  await h.tick();
  assert.equal(h.requests.length, 5);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.requests[5].resolve(Response.json({ meta: meta('a') }));
  await setImmediate();
  assert.equal(h.requests[6].body.source, 'live');
  assert.equal(h.requests[6].body.cursor, 'cursor-4');
  assert.deepEqual(h.ids(), ['A', 'B']);
});

test('ordinary metadata invalidation does not interrupt a matching live chat request', async t => {
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await setImmediate();
  h.requests[3].resolve(Response.json({ meta: { ...meta('a'), title: 'fresh native title' } }));
  await setImmediate();
  assert.equal(h.state().title, 'fresh native title');
  assert.equal(h.requests[2].signal?.aborted, false);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.ids(), ['A']);
});

test('unload continues a known forward cursor passively, then reload resumes live without retransmitting the window', async t => {
  const h = setup(t);
  await h.start();
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false, status: 'unloaded' });
  assert.equal(h.requests[2].signal?.aborted, true);
  const passive = h.requests[3];
  assert.equal(passive.body.source, 'persisted');
  assert.equal(passive.body.cursor, 'cursor-1');
  assert.equal(passive.body.agentScope, undefined);
  assert.equal(passive.body.waitMs, 0);
  await h.reply(3, [message('B')]);
  await h.tick();
  assert.equal(h.requests.length, 4, 'an unloaded caught-up source is not continuously polled');
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: true, status: 'idle' });
  assert.equal(h.requests[4].body.source, 'live');
  assert.equal(h.requests[4].body.cursor, 'cursor-3');
  assert.equal(h.requests[4].body.direction, 'forward');
  assert.deepEqual(h.ids(), ['A', 'B']);
});

test('browser reconnect keeps loaded older rows and resumes from its last native cursor', async t => {
  const h = setup(t);
  await h.start();
  h.store.getState().loadMore('a');
  await h.reply(3, [message('older')]);
  h.source.drop();
  assert.equal(h.requests[2].signal?.aborted, true);
  h.source.open();
  assert.equal(h.requests.length, 4);
  h.snapshot();
  assert.equal(h.requests[4].body.direction, 'forward');
  assert.equal(h.requests[4].body.cursor, 'cursor-1');
  await h.reply(4, [message('B')]);
  assert.deepEqual(h.ids(), ['older', 'A', 'B']);
});

for (const success of [false, true]) {
  test(`rewind ${success ? 'success invalidates explicitly' : 'failure resumes the same window'} without a speculative reset`, async t => {
    const h = setup(t);
    await h.start();
    const pending = h.store.getState().rewindSession('a', 'user-boundary');
    void pending.catch(() => {});
    assert.equal(h.state().historyStale, false);
    assert.equal(h.requests[2].signal?.aborted, true);
    h.requests[3].resolve(Response.json(success ? { ok: true } : { error: 'rollback unsupported' }, { status: success ? 200 : 400 }));
    if (success) await pending; else await assert.rejects(pending, /rollback unsupported/);
    await setImmediate();
    assert.deepEqual(h.ids(), ['A']);
    assert.equal(h.state().historyStale, success);
    if (success) {
      assert.equal(h.requests.length, 4);
      assert.match(h.state().error ?? '', /重新同步/);
    } else {
      assert.equal(h.requests[4].body.direction, 'forward');
      assert.equal(h.requests[4].body.cursor, 'cursor-1');
    }
  });
}

test('an authoritative invalidation before the mutation ACK is not replaced by a fresh window', async t => {
  const h = setup(t);
  await h.start();
  const pending = h.store.getState().compactSession('a');
  h.source.emit({ type: 'chat/invalidated', sessionId: 'a', reason: 'compaction' });
  h.requests[3].resolve(Response.json({ ok: true }));
  await pending;
  assert.deepEqual(h.ids(), ['A']);
  assert.equal(h.state().historyStale, true);
  await h.tick();
  assert.equal(h.requests.length, 4);
});
