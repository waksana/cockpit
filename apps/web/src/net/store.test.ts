import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { IntentBody, IntentName, IntentResult } from '@cockpit/protocol';
import { CHAT_STREAM_URL, intentUrl } from '../lib/config';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { DraftCache, getDraftSession } from '../lib/draftSelection';
import { ModuleRuntime } from '../lib/moduleRuntime';
import type { DraftPurpose, DraftSchemaHandle, ModuleFrontendContext } from '@cockpit/module-api';
import { appendFixture, fixtureItem, fixtureSchema, type FixtureData } from '../test/draftFixture';
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

async function capturedFixture(t: TestContext, purpose: DraftPurpose = { kind: 'prompt' }) {
  const h = setup(t);
  h.source.open();
  const native: SessionMeta = { ...meta('captured'),
    ...(purpose.kind === 'ask' ? { ask: { requestId: purpose.requestId, question: 'Question', choices: [], allowFreeform: true } } : {}),
    ...(purpose.kind === 'plan' ? { planRequest: { requestId: purpose.requestId, summary: 'Plan' } } : {}),
  };
  h.snapshot([], { sessions: [native, meta('elsewhere')] });
  const cache = new DraftCache();
  const session = cache.session('captured');
  cache.observe(useCockpit.getState().sessions, true);
  t.after(useCockpit.subscribe(state => cache.observe(state.sessions, state.snapshotReady && state.connState === 'open')));
  const source = session.candidate(purpose);
  let context!: ModuleFrontendContext, field!: DraftSchemaHandle<FixtureData>;
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'speech', name: 'Speech', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/speech/${digest}/api`, entry: `/_modules/assets/speech/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (value: ModuleFrontendContext) => {
      context = value;
      field = value.state.registerDraft(fixtureSchema());
      return { apiVersion: 2, writes: ['text'], sends: ['draft'] };
    } }),
    report: () => {},
    draftSubmission: {
      check: draft => useCockpit.getState().canSendDraft(draft.reference),
      send: request => useCockpit.getState().sendDraft(request),
    },
  });
  await runtime.start();
  t.after(() => runtime.stop());
  runtime.prepareDraft(source, false);
  const draft = context.state.bindDraft(source.reference);
  draft.editText('Provisional');
  return { h, runtime, cache, source, native, draft, field };
}

test('captured prompt sends its original full draft through native enqueue while another session and ask are active', async t => {
  const f = await capturedFixture(t);
  const field = f.field.forDraft(f.source.reference)!;
  appendFixture(field, fixtureItem('attachment'));
  const release = f.draft.block('Transcribing');
  const intent = f.draft.captureSend();
  const ask = { requestId: 'later', question: 'Question', choices: ['A'], allowFreeform: true };
  f.h.source.emit({ type: 'session/patch', sessionId: 'captured', ask });
  // No active-window callback is involved; target is immutable even if the UI is hidden.
  useCockpit.setState({ activeId: 'elsewhere' });
  f.runtime.updateView({ sessionId: 'elsewhere', visible: false, connected: true });
  release();
  assert.equal(f.draft.editTextIfRevision('Completed', 1), true);
  const sending = intent.send(2);
  await Promise.resolve();
  f.h.assertPost(0, 'prompt', { sessionId: 'captured', text: 'Completed', attachments: [fixtureItem('attachment').value] });
  // Omitted mode is the existing native enqueue default, never immediate or an ask reply.
  await f.h.reply(0, { ok: true });
  assert.deepEqual(await sending, { status: 'acknowledged' });
  assert.deepEqual(session('captured').ask, ask);
  assert.equal(field.getSnapshot().items.length, 0);
  assert.equal(f.h.requests.length, 1);
});

for (const kind of ['ask', 'plan'] as const) {
  test(`captured ${kind} preserves its original live request route across navigation`, async t => {
    const f = await capturedFixture(t, { kind, requestId: 'original' });
    const intent = f.draft.captureSend();
    useCockpit.setState({ activeId: 'elsewhere' });
    const sending = intent.send(1);
    await Promise.resolve();
    if (kind === 'ask') f.h.assertPost(0, 'respondAsk', { sessionId: 'captured', requestId: 'original', answer: 'Provisional', wasFreeform: true });
    else f.h.assertPost(0, 'planSupersede', { sessionId: 'captured', requestId: 'original', message: 'Provisional' });
    await f.h.reply(0, { ok: true });
    assert.deepEqual(await sending, { status: 'acknowledged' });
    assert.equal(f.h.requests.length, 1);
  });
}

test('retired and reused asks never receive a captured answer or reroute it into the prompt', async t => {
  const f = await capturedFixture(t, { kind: 'ask', requestId: 'original' });
  const intent = f.draft.captureSend();
  f.h.source.emit({ type: 'session/patch', sessionId: 'captured', ask: null });
  f.h.source.emit({ type: 'session/patch', sessionId: 'captured', ask: f.native.ask });
  assert.deepEqual(await intent.send(1), { status: 'blocked', reason: 'retired' });
  assert.equal(f.h.requests.length, 0);
  assert.equal(f.cache.session('captured').prompt.getSnapshot().text, '');
});

for (const gate of ['disconnect', 'snapshot', 'read-only', 'freeform', 'unloaded', 'deleted', 'compacting'] as const) {
  test(`native captured-send gate rejects ${gate} without transport dispatch`, async t => {
    const f = await capturedFixture(t, { kind: 'ask', requestId: 'original' });
    const intent = f.draft.captureSend();
    if (gate === 'disconnect') f.h.source.drop();
    if (gate === 'snapshot') useCockpit.setState({ snapshotReady: false });
    if (gate === 'read-only') f.runtime.prepareDraft(f.source, true);
    if (gate === 'freeform') f.h.source.emit({ type: 'session/patch', sessionId: 'captured', ask: { ...f.native.ask!, allowFreeform: false } });
    if (gate === 'unloaded') f.h.source.emit({ type: 'session/patch', sessionId: 'captured', loaded: false, ask: null });
    if (gate === 'deleted') f.h.source.emit({ type: 'session/removed', sessionId: 'captured' });
    if (gate === 'compacting') f.h.source.emit({ type: 'session/patch', sessionId: 'captured', compacting: true });
    assert.deepEqual(await intent.send(1), { status: 'blocked',
      reason: gate === 'deleted' ? 'retired' : gate === 'freeform' ? 'unsupported' : gate === 'read-only' ? 'read-only' : 'unavailable' });
    assert.equal(f.h.requests.length, 0);
  });
}

test('malformed native ACK remains unconfirmed and duplicate captured calls never issue a second POST', async t => {
  const f = await capturedFixture(t);
  const intent = f.draft.captureSend(), sending = intent.send(1);
  await Promise.resolve();
  await f.h.reply(0, { status: 'accepted' });
  assert.deepEqual(await sending, { status: 'unconfirmed', reason: 'native-unconfirmed' });
  assert.equal(intent.send(1), sending);
  assert.equal(f.h.requests.length, 1);
  assert.equal(f.draft.getSnapshot().text, 'Provisional');
  assert.equal(f.draft.getSnapshot().unconfirmed, true);
});

test('native store authority retires cached drafts on confirmed absence but not disconnect or unload', t => {
  const h = setup(t);
  const cache = new DraftCache();
  const session = cache.session('a');
  t.after(useCockpit.subscribe(state => cache.observe(state.sessions, state.snapshotReady && state.connState === 'open')));
  h.source.open();
  assert.equal(session.prompt.getSnapshot().retired, false, 'open alone is not a complete snapshot');
  h.snapshot(['a'], { sessions: [{ ...meta('a'), ask: { requestId: 'decision', question: 'Question', choices: [] } }] });
  const answer = session.candidate({ kind: 'ask', requestId: 'decision' });
  const captured = answer.getSnapshot();
  assert.deepEqual(captured.askContext, { question: 'Question', choices: [] });
  h.source.emit({ type: 'session/patch', sessionId: 'a',
    ask: { requestId: 'decision', question: 'Updated question', choices: ['Choice'] } });
  assert.deepEqual(answer.getSnapshot().askContext, { question: 'Updated question', choices: ['Choice'] });
  assert.deepEqual(captured.askContext, { question: 'Question', choices: [] });
  h.source.drop();
  assert.equal(answer.getSnapshot().askContext, undefined);
  h.source.open();
  assert.equal(answer.getSnapshot().askContext, undefined, 'reconnect is not native confirmation');
  assert.equal(answer.getSnapshot().retired, false);
  h.snapshot(['a'], { sessions: [{ ...meta('a'), loaded: false, ask: null }] });
  assert.equal(answer.getSnapshot().retired, false, 'unloaded metadata does not prove decision completion');
  assert.equal(answer.getSnapshot().askContext, undefined);
  assert.equal(session.prompt.getSnapshot().retired, false);
  h.snapshot([]);
  assert.equal(answer.getSnapshot().retired, true);
  assert.equal(session.prompt.getSnapshot().retired, true);
  const unseen = cache.session('cached-before-observation');
  h.snapshot([]);
  assert.equal(unseen.prompt.getSnapshot().retired, true);
});

test('explicit native removal retires captured drafts even before the first complete snapshot', t => {
  const h = setup(t);
  const session = getDraftSession('explicit-delete-before-snapshot');
  session.synchronize({ ask: { requestId: 'decision' } });
  const answer = session.candidate({ kind: 'ask', requestId: 'decision' });
  h.source.open();
  assert.equal(useCockpit.getState().snapshotReady, false);
  h.source.emit({ type: 'session/removed', sessionId: session.prompt.sessionId });
  assert.equal(session.prompt.getSnapshot().retired, true);
  assert.equal(answer.getSnapshot().retired, true);
});

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
    if (name === 'session/chat' || name === 'session/resources') {
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
        max: 200, waitMs: 0, bootstrap: !!loaded, ...(loaded ? { agentScope: 'all' as const } : {}) });
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

test('module invalidations reuse control SSE without persistent state or extra reads', t => {
  const h = setup(t);
  h.source.open();
  h.snapshot([]);
  const state = h.store.getState();
  const received: string[] = [];
  const unsubscribe = state.onModuleInvalidated(id => { received.push(id); });
  h.source.emit({ type: 'module/invalidated', moduleId: 'fixture' });
  assert.deepEqual(received, ['fixture']);
  assert.equal(h.store.getState(), state);
  assert.equal(h.sources.length, 1);
  assert.equal(h.requests.length, 0);
  unsubscribe();
  h.source.emit({ type: 'module/invalidated', moduleId: 'fixture' });
  assert.deepEqual(received, ['fixture']);
});

test('module event SSE is immutable, transient and never mutates native metadata or starts reads', t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a']);
  const state = h.store.getState();
  const received: unknown[] = [];
  const bad = state.onModuleEvent((_id, payload) => { (payload as { values: unknown[] }).values.push('changed'); });
  const unsubscribe = state.onModuleEvent((id, payload) => { received.push({ id, payload }); });
  const payload = { type: 'session/removed', sessionId: 'a', values: [1] };
  h.source.emit({ type: 'module/event', moduleId: 'fixture', payload });
  assert.deepEqual(received, [{ id: 'fixture', payload }]);
  assert.equal(getUxErrors().length, 1, 'listener failure does not block another consumer');
  assert.equal(h.store.getState(), state);
  assert.equal(h.store.getState().sessions, state.sessions);
  assert.equal(h.store.getState().resourceRevisions, state.resourceRevisions);
  assert.equal(h.sources.length, 1);
  assert.equal(h.requests.length, 0);
  bad();
  unsubscribe();
  unsubscribe();
  h.source.emit({ type: 'module/event', moduleId: 'fixture', payload: null });
  assert.equal(received.length, 1);
  const late = state.onModuleEvent(() => assert.fail('No event replay'));
  late();
});

test('validated native status events need no unused browser state or additional requests', t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a'], { models: [{ modelId: 'fixture-model', name: 'Fixture model' }] });
  const state = h.store.getState();
  assert.equal(state.snapshotReady, true);
  assert.equal(state.sessions[0].sessionId, 'a');
  assert.deepEqual(state.globalModels, [{ modelId: 'fixture-model', name: 'Fixture model' }]);
  assert.equal('agentStatus' in state, false);
  assert.equal('permissionPolicy' in state, false);
  for (const status of ['starting', 'up', 'stopping', 'failed'] as const) {
    h.source.emit({ type: 'agent/status', status });
    assert.equal(h.store.getState(), state);
  }
  assert.equal(h.requests.length, 0);
});

test('absence becomes authoritative only after a complete snapshot in the current connection', t => {
  const fixture = setup(t);
  assert.equal(useCockpit.getState().snapshotReady, false);
  fixture.source.open();
  assert.equal(useCockpit.getState().connState, 'open');
  assert.equal(useCockpit.getState().snapshotReady, false, 'first open is not a session list');
  fixture.snapshot(['a']);
  assert.equal(useCockpit.getState().snapshotReady, true);
  const retained = session('a');
  const generation = useCockpit.getState().connectionGeneration;
  fixture.source.drop();
  assert.equal(useCockpit.getState().snapshotReady, false);
  assert.ok(useCockpit.getState().connectionGeneration > generation);
  fixture.source.open();
  assert.equal(useCockpit.getState().snapshotReady, false, 'reopen still awaits the new snapshot');
  assert.deepEqual(session('a'), retained, 'retain the previous display during reconnect');
  const observations: State[] = [];
  const stop = useCockpit.subscribe(state => observations.push(state));
  fixture.snapshot([]);
  stop();
  assert.equal(useCockpit.getState().snapshotReady, true);
  assert.deepEqual(useCockpit.getState().sessions, []);
  assert.ok(observations.every(state => !state.snapshotReady || state.sessions.length === 0),
    'readiness and complete list must publish together');
});

test('removed session pages have no dedicated Web store actions or readers', () => {
  const state = createCockpitStore().getState();
  for (const name of [
    'forkSession', 'getPlan', 'getPanels', 'getPanel', 'getUsage',
    'scheduleList', 'scheduleAdd', 'scheduleStop', 'compactSession',
    'rewindSession', 'unloadSession', 'reloadSession', 'setMode',
  ]) assert.equal(name in state, false, name);
});

test('native deletion supports unloaded sessions and failures never retry or remove displayed state', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false });
  const deletion = observe(store.getState().deleteSession('a'));
  h.assertPost(0, 'session/delete', { sessionId: 'a' });
  h.request(0).response.resolve(Response.json({ error: 'Native protected work' }, { status: 409 }));
  await assert.rejects(deletion, /Native protected work/);
  await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.equal(session('a', store).sessionId, 'a');
  assert.equal(session('a', store).loaded, false);
  assert.match(session('a', store).error ?? '', /Native protected work/);
});

test('late load and delete failures cannot resurrect an authoritatively removed session', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  const loading = useCockpit.getState().loadSession('a');
  const deleting = useCockpit.getState().deleteSession('a');
  const rejected = [assert.rejects(loading, /load interrupted/), assert.rejects(deleting, /delete interrupted/)];
  h.source.emit({ type: 'session/removed', sessionId: 'a' });
  const before = useCockpit.getState().sessions;
  h.assertPost(0, 'session/load', { sessionId: 'a' }).reject(new Error('load interrupted'));
  h.assertPost(1, 'session/delete', { sessionId: 'a' }).reject(new Error('delete interrupted'));
  await Promise.all(rejected);
  await setImmediate();
  assert.strictEqual(useCockpit.getState().sessions, before);
  assert.deepEqual(before.map(row => row.sessionId), ['b']);
  assert.equal(session('b').error, null);
  assert.equal(getUxErrors().length, 2);
  assert.equal(h.requests.length, 2);
});

for (const boundary of ['snapshot', 'reconnect', 'cleanup'] as const) {
  test(`late load failure after ${boundary} rejects without changing the current session projection`, async t => {
    const h = setup(t);
    h.source.open();
    h.snapshot();
    const loading = useCockpit.getState().loadSession('a');
    const rejected = assert.rejects(loading, /uncertain load/);
    if (boundary === 'snapshot') h.snapshot();
    else if (boundary === 'reconnect') h.reconnect();
    else h.cleanup();
    const before = session();
    h.assertPost(0, 'session/load', { sessionId: 'a' }).reject(new Error('uncertain load'));
    await rejected;
    await setImmediate();
    assert.strictEqual(session(), before);
    assert.equal(session().error, null);
    assert.equal(getUxErrors().length, 1);
    assert.equal(h.requests.length, 1);
  });
}

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

for (const currentMode of [undefined, null, 'interactive', 'plan', 'autopilot'] as const) {
  test(`opening and sending to an existing ${currentMode ?? 'unknown'} session never changes its native mode`, async t => {
    const store = createCockpitStore();
    const h = setup(t, store);
    h.source.open();
    h.snapshot(['a'], { sessions: [{ ...meta('a'), currentMode }] });
    await h.load('a', [message('previous')], false);
    h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['mode'] });
    await setImmediate();
    assert.equal(h.requests.length, 1, 'hidden mode changes require no dedicated resource read');
    assert.equal(session('a', store).currentMode, currentMode);
    const sending = store.getState().sendDraft({ intent: 'prompt', body: { sessionId: 'a', text: 'Continue this session' } });
    h.assertPost(1, 'prompt', { sessionId: 'a', text: 'Continue this session' });
    await h.reply(1, { ok: true });
    assert.equal(await sending, true);
    assert.equal(h.requests.length, 2, 'sending must not insert a mode mutation');
    assert.equal(session('a', store).currentMode, currentMode);
  });
}

test('unselected sessions and read-lease patches do not fetch hidden resources or full metadata', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a', 'b']);
  for (const resource of ['plan', 'skills', 'mcp', 'tasks', 'instructions', 'usage', 'models', 'todo', 'schedule', 'mode'] as const) {
    h.source.emit({ type: 'session/invalidated', sessionId: 'b', resources: [resource] });
  }
  h.source.emit({ type: 'session/patch', sessionId: 'b', activeOperations: 1 });
  h.source.emit({ type: 'session/patch', sessionId: 'b', activeOperations: 0 });
  await setImmediate();
  assert.equal(h.requests.length, 0);
  assert.equal(store.getState().resourceRevisions.b?.tasks, 1);
  assert.equal(store.getState().resourceRevisions.b?.schedule, 1);
  h.source.emit({ type: 'session/invalidated', sessionId: 'b', resources: ['model'] });
  await setImmediate();
  h.assertPost(0, 'session/resources', { sessionId: 'b', resources: ['model'] });
  await h.reply(0, { meta: { sessionId: 'b', loaded: true, currentModelId: 'fresh-model' } });
  assert.equal(session('b', store).currentModelId, 'fresh-model');
  assert.equal(session('b', store).title, 'b', 'narrow projection must not erase identity');
});

test('late resource changes rerun only their dependency and retain independent fresh fields and decision patches', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  h.snapshot(['a']);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['identity', 'model'] });
  await setImmediate();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model'] });
  h.source.emit({ type: 'session/patch', sessionId: 'a', activeOperations: 1, ask: { requestId: 'fresh-ask', question: 'Continue?' } });
  await h.reply(0, { meta: { sessionId: 'a', loaded: true, title: 'Fresh title', currentModelId: 'obsolete',
    activeOperations: 0, ask: null } });
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['model'] });
  assert.equal(session('a', store).title, 'Fresh title');
  assert.equal(session('a', store).currentModelId, undefined, 'obsolete model is never published');
  assert.equal(session('a', store).ask?.requestId, 'fresh-ask');
  assert.equal(session('a', store).activeOperations, 1);
  await h.reply(1, { meta: { sessionId: 'a', loaded: true, currentModelId: 'fresh-model' } });
  assert.equal(session('a', store).currentModelId, 'fresh-model');
  assert.equal(h.requests.length, 2);
});

test('source changes fence narrow requests and clear stale native fields immediately', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  const roles = [{ moduleId: 'fixture', roleId: 'reviewer', moduleName: 'Fixture', name: 'Reviewer' }];
  h.snapshot(['a'], { sessions: [{ ...meta('a'), currentModelId: 'old', availableModels: [], scheduleCount: 2,
    roles, appliedRoles: [], rolesNeedReload: true }] });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['model'] });
  await setImmediate();
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: false, status: 'unloaded', ask: null });
  assert.equal(h.request(0).init?.signal?.aborted, true);
  assert.equal(session('a', store).availableModels, undefined);
  assert.equal(session('a', store).scheduleCount, undefined);
  assert.deepEqual(session('a', store).roles, roles);
  assert.deepEqual(session('a', store).appliedRoles, []);
  assert.equal(session('a', store).rolesNeedReload, false);
  await h.reply(0, { meta: { sessionId: 'a', loaded: true, currentModelId: 'obsolete' } });
  assert.equal(session('a', store).currentModelId, undefined);
  assert.equal(session('a', store).loaded, false);
});

test('role identity invalidation fences stale saved/applied roles and tracks explicit reload', async t => {
  const store = createCockpitStore();
  const h = setup(t, store);
  h.source.open();
  const roles = [{ moduleId: 'fixture', roleId: 'reviewer', moduleName: 'Fixture', name: 'Reviewer' }];
  h.snapshot(['a'], { sessions: [{ ...meta('a'), roles: [], appliedRoles: [], rolesNeedReload: false }] });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['identity', 'model'] });
  await setImmediate();
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['identity'] });
  await h.reply(0, { meta: { sessionId: 'a', loaded: true, roles, appliedRoles: roles,
    rolesNeedReload: true, currentModelId: 'fresh' } });
  assert.deepEqual(session('a', store).roles, []);
  assert.deepEqual(session('a', store).appliedRoles, []);
  assert.equal(session('a', store).rolesNeedReload, false);
  assert.equal(session('a', store).currentModelId, 'fresh');
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['identity'] });
  await h.reply(1, { meta: { sessionId: 'a', loaded: true, roles, appliedRoles: [], rolesNeedReload: true } });
  assert.deepEqual(session('a', store).roles, roles);
  assert.deepEqual(session('a', store).appliedRoles, []);
  assert.equal(session('a', store).rolesNeedReload, true);
  h.source.emit({ type: 'session/invalidated', sessionId: 'a', resources: ['identity'] });
  await setImmediate();
  await h.reply(2, { meta: { sessionId: 'a', loaded: true, roles, appliedRoles: roles, rolesNeedReload: false } });
  assert.deepEqual(session('a', store).appliedRoles, roles);
  assert.equal(session('a', store).rolesNeedReload, false);
  assert.equal(h.requests.length, 3, 'only identity reads, never reload or role polling');
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
  h.assertPost(0, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model'] });
  h.source.emit({ type: 'session/invalidated', sessionId: 'a' });
  await h.reply(0, { meta: { ...meta('a'), currentModelId: 'obsolete' } });
  assert.notEqual(session('a', store).currentModelId, 'obsolete');
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model'] });
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
  h.assertPost(0, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model'] });
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
  h.assertPost(1, 'session/resources', { sessionId: 'a', resources: ['identity', 'control', 'model'] });
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
    send: () => useCockpit.getState().sendDraft({ intent: 'prompt', body: { sessionId: 'a', text: 'keep this draft' } }),
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
  const pending = useCockpit.getState().sendDraft({ intent: 'prompt', body: { sessionId: 'a', text: 'keep caption' } });
  useCockpit.getState().setActiveId('b');
  useCockpit.getState().setActiveId('a');
  await h.reply(1, { ok: false });
  assert.equal(await pending, false);
  const diagnostic = session().error;
  assert.match(diagnostic ?? '', /草稿已保留/);
  await h.history(2, { sessionId: 'b', messages: [message('obsolete')], hasMore: false });
  assert.equal(session().error, diagnostic);
  assert.deepEqual(session().messages, [{ ...message('old'), origin: { sessionId: 'a', messageId: 'old' } }]);
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
}

const mcpSuccess: IntentResult<'mcp/session-toggle'> = {
  ok: true, applied: true, sessionId: 'a', name: 'fixture-mcp', enabled: true, status: 'connected',
  operation: { id: 'operation', desiredEnabled: true, state: 'succeeded', startedAt: 1, status: 'connected' },
};

const mutations: MutationCase[] = [
  { name: 'cancel', body: { sessionId: 'a' }, send: (s) => s.cancel('a'), success: { ok: true }, sessionId: 'a' },
  { name: 'session/delete', body: { sessionId: 'a' }, send: (s) => s.deleteSession('a'), success: { ok: true }, sessionId: 'a' },
  {
    name: 'session/load', body: { sessionId: 'a' }, send: (s) => s.loadSession('a'),
    success: { ok: true, sessionId: 'a' }, sessionId: 'a',
  },
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

for (const result of [
  { status: 'applied', modelId: 'model', modelState: { modelId: 'model', reasoningEffort: 'high', contextTier: 'long_context' } },
  { status: 'queued', deferred: true },
  { status: 'rejected', message: 'Native refusal' },
  { status: 'confirmation_required', confirmation: { targetModelDisplayName: 'Model', currentTokens: 100, targetLimit: 80 } },
  { status: 'applied', persistenceError: 'Native save failed', warning: 'Current process only', deprecationWarnings: ['Deprecated'] },
  {},
] satisfies IntentResult<'setModel'>['result'][]) {
  test(`setModel preserves the complete native ${result.status ?? 'unknown'} result without optimistic state`, async t => {
    const h = setup(t);
    h.source.open();
    h.snapshot(['a', 'b']);
    const beforeA = session('a'), beforeB = session('b');
    const sent = useCockpit.getState().setModel('a', 'model', { reasoningEffort: 'high', contextTier: 'long_context' });
    h.assertPost(0, 'setModel', { sessionId: 'a', modelId: 'model', reasoningEffort: 'high', contextTier: 'long_context' });
    useCockpit.setState({ activeId: 'b' });
    await h.reply(0, { ok: true, result });
    assert.deepEqual(await sent, { ok: true, result });
    assert.strictEqual(session('a'), beforeA);
    assert.strictEqual(session('b'), beforeB);
    assert.equal(h.requests.length, 1, 'neither deferred nor confirmation results cause another command');
  });
}

test('a model-only selection omits options instead of backfilling current snapshot values', async t => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a'], { sessions: [{ ...meta('a'), currentModelId: 'old', currentReasoningEffort: 'max', currentContextTier: 'long_context' }] });
  const sent = useCockpit.getState().setModel('a', 'new');
  h.assertPost(0, 'setModel', { sessionId: 'a', modelId: 'new' });
  await h.reply(0, { ok: true, result: { status: 'queued' } });
  await sent;
  assert.equal(session('a').currentModelId, 'old');
  assert.equal(session('a').currentReasoningEffort, 'max');
});

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

const projection: IntentResult<'session/resources'>['meta'] = {
  sessionId: 'a', loaded: true, currentModelId: 'fixture-model', currentReasoningEffort: 'high',
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
const roleAddition: IntentResult<'roles/add'> = {
  sessionId: 'a', status: 'uncertain', roles: [], appliedRoles: [], loaded: false, rolesNeedReload: false,
  error: 'Synthetic partial outcome', recovery: 'Inspect before retry',
};
const roleReadiness: IntentResult<'roles/readiness'> = {
  sessionId: 'a', roles: [], appliedRoles: [], loaded: false, ready: false, reasons: ['Unloaded'],
};
const resources: ResourceCase[] = [
  { label: 'listRoles', name: 'roles/list', body: {}, read: s => s.listRoles(), response: { roles: [] }, expected: [] },
  { label: 'addRoles', name: 'roles/add', body: { sessionId: 'a', roles: [{ moduleId: 'fixture', roleId: 'reviewer' }] },
    read: s => s.addRoles('a', [{ moduleId: 'fixture', roleId: 'reviewer' }]), response: roleAddition, expected: roleAddition },
  { label: 'roleReadiness', name: 'roles/readiness', body: { sessionId: 'a' },
    read: s => s.roleReadiness('a'), response: roleReadiness, expected: roleReadiness },
  {
    label: 'getResources', name: 'session/resources', body: { sessionId: 'a', resources: ['model'] },
    read: (s) => s.getResources('a', ['model'], new AbortController().signal),
    response: { meta: projection }, expected: projection,
  },
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
  ['session/resources', 'mcp/session', 'skills/session'].includes(r.name));
const unloadedMessage = 'Native session data is unavailable while unloaded; explicitly resume the session first.';
const unloadedResponse = () => Response.json({
  code: 'SESSION_UNLOADED', message: unloadedMessage,
}, { status: 409 });

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
    expectRejection(useCockpit.getState().mcpSession('a'), /Native session data/),
    expectRejection(useCockpit.getState().mcpSession('b'), /Native session data/),
    expectRejection(useCockpit.getState().skillsSession('a'), /Native session data/),
    expectRejection(useCockpit.getState().skillsSession('b'), /Native session data/),
  ];
  h.assertPost(0, 'mcp/session', { sessionId: 'a' }).resolve(unloadedResponse());
  await reads[0];
  h.assertPost(4, 'session/refresh', {});
  h.assertPost(1, 'mcp/session', { sessionId: 'b' }).resolve(unloadedResponse());
  await reads[1];
  assert.equal(h.requests.length, 5);
  const duringRefresh = expectRejection(useCockpit.getState().mcpSession('b'), /Native session data/);
  await h.reply(4, { ok: true });
  h.assertPost(2, 'skills/session', { sessionId: 'a' }).resolve(unloadedResponse());
  h.assertPost(3, 'skills/session', { sessionId: 'b' }).resolve(unloadedResponse());
  h.assertPost(5, 'mcp/session', { sessionId: 'b' }).resolve(unloadedResponse());
  await Promise.all([...reads, duringRefresh]);
  assert.equal(h.requests.length, 6, 'late failures from overlapping reads must not refresh again');
  assert.strictEqual(useCockpit.getState().sessions, before);

  const later = expectRejection(useCockpit.getState().mcpSession('a'), /Native session data/);
  h.assertPost(6, 'mcp/session', { sessionId: 'a' }).resolve(unloadedResponse());
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
    const checked = expectRejection(useCockpit.getState().mcpSession('a'), /Native session data/);
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
    h.assertPost(0, 'mcp/session', { sessionId: 'a' }).resolve(unloadedResponse());
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
  const checked = expectRejection(useCockpit.getState().skillsSession('a'), /Native session data/);
  h.assertPost(0, 'skills/session', { sessionId: 'a' }).resolve(unloadedResponse());
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
    const checked = expectRejection(useCockpit.getState().mcpSession('a'), /Native session data/);
    h.assertPost(0, 'mcp/session', { sessionId: 'a' }).resolve(Response.json({
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
  assert.deepEqual(session().messages, [{ ...message('a-history'), origin: { sessionId: 'a', messageId: 'a-history' } }]);
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

test('explicit load sends only session/load while unloaded and only metadata enables retained native detail reads', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot([], { sessions: [{ ...meta('a'), loaded: false }] });
  const loading = useCockpit.getState().loadSession('a');
  h.assertPost(0, 'session/load', { sessionId: 'a' }).resolve(Response.json({ ok: true, sessionId: 'a' }));
  await loading;
  assert.equal(session().loaded, false);
  for (const resource of nativeResources) {
    await assert.rejects(resource.read(useCockpit.getState()), SessionUnloadedError);
  }
  assert.equal(h.requests.length, 1);
  h.source.emit({ type: 'session/patch', sessionId: 'a', loaded: true });
  for (const [i, resource] of nativeResources.entries()) {
    const detail = resource.read(useCockpit.getState());
    h.assertPost(i + 1, resource.name, resource.body).resolve(Response.json(resource.response));
    assert.deepEqual(await detail, resource.expected);
  }
  assert.equal(h.requests.length, 1 + nativeResources.length);
  assert.equal(h.requests.filter(request => request.url === intentUrl('session/load')).length, 1);
  assert.equal(h.requests.some(request => request.url === intentUrl('session/reload')), false);
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
      assert.strictEqual(session(), before);
      assert.equal(h.requests.length, 1);
    });
  }
}

test('attached prompt failures keep the original false acknowledgement and local diagnostic contract', async (t) => {
  const h = setup(t);
  h.source.open();
  h.snapshot(['a', 'b']);
  const attachments: NativeAttachment[] = [{ type: 'file', path: '/native/fixture.txt' }];
  const before = session();
  const other = session('b');
  const pending = useCockpit.getState().sendDraft({ intent: 'prompt', body: { sessionId: 'a', text: 'keep draft', attachments } });
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

test('newSession rejects original failures and disconnected attempts without changing the selected session or double reporting', async (t) => {
  const h = setup(t);
  h.snapshot();
  useCockpit.getState().setActiveId('a');
  await expectOffline(h, () => useCockpit.getState().newSession('.'));
  assert.equal(h.requests.length, 0);
  h.source.open();
  h.assertPost(0, 'session/chat', { sessionId: 'a', source: 'live', direction: 'backward',
    max: 200, waitMs: 0, bootstrap: true, agentScope: 'all' });
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
