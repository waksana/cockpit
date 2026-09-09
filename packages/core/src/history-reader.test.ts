import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deserialize as deserializeV8 } from 'node:v8';
import { inflateSync } from 'node:zlib';
import type { CopilotClient, SessionEvent } from '@github/copilot-sdk';
import { summarizeMessage } from '@cockpit/protocol';
import { foldEvent, newFoldState } from './fold.ts';
import {
  DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, SessionHistoryReader, pageHistory, type HistoryReaderOptions,
} from './history-reader.ts';
import { normalizeEvent } from './sdk-types.ts';
import { readToolImage } from './tool-image.ts';

type Read = CopilotClient['rpc']['sessions']['readPersistedEvents'];
type Params = Parameters<Read>[0];
type Result = Awaited<ReturnType<Read>>;
type Page = Awaited<ReturnType<SessionHistoryReader['read']>>;
const timestamp = '2026-09-07T14:20:00.919Z';
const deserialize = (data: Buffer) => deserializeV8(inflateSync(data));

function event(type: SessionEvent['type'], id: string, data: Record<string, unknown> = {}, agentId?: string): SessionEvent {
  return { type, id, data, timestamp, parentId: null, ...(agentId ? { agentId } : {}) } as SessionEvent;
}

function turns(count: number, prefix = ''): SessionEvent[] {
  return Array.from({ length: count }, (_, i) => [
    event('user.message', `${prefix}u${i}`, { content: `Question ${i}`, messageId: `${prefix}accepted${i}` }),
    event('assistant.reasoning', `${prefix}r${i}`, { reasoningId: `${prefix}reason${i}`, content: `Thought ${i}` }),
    event('assistant.message', `${prefix}e${i}`, { messageId: `${prefix}a${i}`, content: `Answer ${i}`, reasoningText: `Thought ${i}` }),
  ]).flat();
}

function replay(events: SessionEvent[]) {
  const state = newFoldState();
  for (const event of events) foldEvent(state, normalizeEvent(event));
  return state.messages;
}

function ids(page: Page): string[] { return page.messages.map((message) => message.id); }

test('native root user task bookkeeping neither hides history nor forces an unbounded ownership search', async () => {
  const events = turns(150).map(value => value.type === 'user.message'
    ? { ...value, data: { ...value.data, parentAgentTaskId: `native-task-${value.id}` } } : value);
  const { reader, calls } = fixture(events, { batchSize: 8, maxEvents: 40 });
  const page = await reader.read('root', undefined, 4);
  assert.deepEqual(page.messages, replay(events).slice(-4));
  assert.ok(page.messages.some(message => message.role === 'user'));
  assert.ok(calls.length < 6);
});

/** An in-memory public RPC fixture: opaque, exclusive backward cursors. */
function fixture(initial: SessionEvent[], options: Omit<HistoryReaderOptions, 'readPersistedEvents'> = {}) {
  let events = initial;
  let generation = 0;
  let sequence = 0;
  const cursors = new Map<string, { id?: string; generation: number; direction: Params['direction'] }>();
  const calls: Params[] = [];
  const readPersistedEvents: Read = async (params) => {
    calls.push({ ...params });
    assert.ok(Object.keys(params).every((key) => ['sessionId', 'cursor', 'max', 'direction'].includes(key)));
    assert.ok(params.max! >= 1 && params.max! <= 1000);
    const previous = params.cursor ? cursors.get(params.cursor) : undefined;
    if (previous) assert.equal(params.direction, previous.direction, 'native cursors must not cross directions');
    let boundary = previous?.id ? events.findIndex((event) => event.id === previous.id) : -1;
    const expired = !!params.cursor && (!previous || previous.generation !== generation || (previous.id && boundary < 0));
    let batch: SessionEvent[];
    let hasMore: boolean;
    if (params.direction === 'backward') {
      if (!params.cursor || expired) boundary = events.length;
      if (boundary < 0) boundary = 0;
      const start = Math.max(0, boundary - params.max!);
      batch = events.slice(start, boundary);
      hasMore = start > 0;
    } else {
      boundary = params.cursor && !expired ? boundary + 1 : 0;
      batch = events.slice(boundary, boundary + params.max!);
      hasMore = boundary + batch.length < events.length;
    }
    const cursor = `opaque/${++sequence}/not-a-message-id`;
    cursors.set(cursor, {
      id: params.direction === 'backward' ? batch[0]?.id : batch.at(-1)?.id,
      generation, direction: params.direction,
    });
    return structuredClone({ events: batch, cursor, hasMore, cursorStatus: expired ? 'expired' : 'ok' }) as Result;
  };
  return {
    reader: new SessionHistoryReader({ readPersistedEvents, ...options }),
    readPersistedEvents, calls,
    replace(next: SessionEvent[], invalidate = true) { events = next; if (invalidate) generation++; },
    append(next: SessionEvent[]) { events = [...events, ...next]; },
  };
}

function cacheOf(reader: SessionHistoryReader) {
  return reader as unknown as {
    cache: Map<string, { data: Buffer; messages: number }>;
    cachedBytes: number; cachedMessages: number;
  };
}

function resumeToken(page: Page): string {
  assert.ok(page.resume && page.resume.status !== 'unavailable' && page.resume.token);
  return page.resume.token;
}

test('root and on-demand child tool images survive history projection without storing binary data', async () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=';
  const image = { binaryResultsForLlm: [{ type: 'image', mimeType: 'image/png', data }] };
  const events = [
    event('user.message', 'user', { content: 'Synthetic images' }),
    event('assistant.message', 'root-event', { messageId: 'root', content: '', toolRequests: [
      { toolCallId: 'view', name: 'view', arguments: {} },
      { toolCallId: 'child', name: 'task', arguments: { prompt: 'Synthetic child', description: 'Child' } },
    ] }),
    event('tool.execution_complete', 'root-image', { toolCallId: 'view', success: true, result: image }),
    event('subagent.started', 'child-start', { toolCallId: 'child', agentName: 'explore' }, 'child-agent'),
    event('assistant.message', 'child-event', { messageId: 'child-message', content: '', toolRequests: [
      { toolCallId: 'child-view', name: 'view', arguments: {} },
    ] }, 'child-agent'),
    event('tool.execution_complete', 'child-image', { toolCallId: 'child-view', success: true, result: image }, 'child-agent'),
    event('subagent.completed', 'child-done', { toolCallId: 'child' }, 'child-agent'),
    event('assistant.message', 'last', { messageId: 'last', content: 'Done' }),
  ];
  const source = fixture(events, { batchSize: 3 });
  const root = await source.reader.read('fixture', undefined, 30, undefined, 'summary');
  const rootRef = root.messages.find(message => message.id === 'root')?.toolCalls?.[0]?.images?.[0];
  assert.ok(rootRef);
  assert.equal(rootRef.eventId, 'root-image');
  assert.doesNotMatch(JSON.stringify(root), /iVBOR|child-image/);
  const child = await source.reader.readSubagent('fixture', 'child');
  const childRef = child.messages.find(message => message.id === 'child-message')?.toolCalls?.[0]?.images?.[0];
  assert.ok(childRef);
  assert.equal(childRef.eventId, 'child-image');
  assert.doesNotMatch(JSON.stringify(child), /iVBOR/);
  for (const ref of [rootRef, childRef]) {
    const { eventId, toolCallId, part, cursor, count } = ref;
    const result = await readToolImage(source.readPersistedEvents, {
      sessionId: 'fixture', image: { eventId, toolCallId, part, cursor, count },
    });
    assert.equal(result.data, data);
  }
  for (const cache of cacheOf(source.reader).cache.values()) {
    assert.doesNotMatch(JSON.stringify(deserialize(cache.data)), /iVBOR/);
  }
  const replayed = replay(events);
  assert.equal(replayed.find(message => message.id === 'root')?.toolCalls?.[0]?.images?.[0]?.eventId, rootRef.eventId);
  assert.doesNotMatch(JSON.stringify(replayed), /iVBOR/);
  source.replace(events.filter(event => event.id !== 'root-image'));
  const { eventId, toolCallId, part, cursor, count } = rootRef;
  await assert.rejects(readToolImage(source.readPersistedEvents, {
    sessionId: 'fixture', image: { eventId, toolCallId, part, cursor, count },
  }), /失效|已删除/);
});

test('bootstrap accepts the first explicit refresh after unchanged native cursors expire', async () => {
  const events = Array.from({ length: 245 }, (_, i) => event('user.message', `u${i}`, { content: `${i}` }));
  const source = fixture(events, { batchSize: 20 });
  const base = await source.reader.readResume('root', {}, 30, 'summary');
  source.replace(events);
  const expired = await source.reader.readResume('root', { token: resumeToken(base) }, 30, 'summary');
  assert.deepEqual(expired.resume, { status: 'unavailable', reason: 'expired' });
  const start = source.calls.length;
  const fresh = await source.reader.readResume('root', {}, 30, 'summary');
  assert.equal(fresh.resume?.status, 'ready');
  assert.deepEqual(fresh.messages, base.messages);
  assert.equal(source.calls.length - start, 7, 'one loader recovery, no second bootstrap traversal');
  assert.equal(source.calls.slice(start).reduce((n, call) => n + call.max!, 0), 45);
  const resumed = await source.reader.readResume('root', { token: resumeToken(fresh) }, 30, 'summary');
  assert.equal(resumed.resume?.status, 'ready');
  assert.deepEqual(resumed.messages, fresh.messages);
  const older = await source.reader.read('root', 'u215', 30, undefined, 'summary');
  assert.deepEqual(ids(older), Array.from({ length: 30 }, (_, i) => `u${i + 185}`));
  const old = await source.reader.readResume('root', { token: resumeToken(base) }, 30, 'summary');
  assert.deepEqual(old.resume, { status: 'unavailable', reason: 'changed' });
  assert.deepEqual(old.messages, []);
});

for (const phase of ['old-validation', 'fresh-page', 'fresh-native-rewind', 'final-fence'] as const) {
  test(`bootstrap rejects external reset around its own expired-cache recovery: ${phase}`, async () => {
    const source = fixture(turns(100));
    let armed = false;
    let reset = false;
    const reader = new SessionHistoryReader({ batchSize: 20, readPersistedEvents: async params => {
      const result = await source.readPersistedEvents(params);
      const target = phase === 'old-validation' ? result.cursorStatus === 'expired'
        : phase === 'fresh-page' || phase === 'fresh-native-rewind' ? params.max === 20
          : params.max === 1 && !!params.cursor && result.cursorStatus === 'ok';
      if (armed && !reset && target) {
        reset = true;
        if (phase !== 'fresh-native-rewind') reader.clear('root');
        if (phase !== 'final-fence') source.replace(turns(2, 'rewound-'));
      }
      return result;
    } });
    await reader.readResume('root', {});
    source.replace(turns(100));
    armed = true;
    const start = source.calls.length;
    const result = await reader.readResume('root', {});
    assert.ok(reset);
    assert.equal(result.resume?.status, 'unavailable');
    assert.deepEqual(result.messages, []);
    assert.ok(source.calls.length - start <= 8, 'no retry may adopt an externally advanced epoch');
    armed = false;
    const next = await reader.readResume('root', {});
    assert.equal(next.resume?.status, 'ready', 'a later deliberate request may observe the new generation');
  });
}

test('bootstrap late old read cannot invalidate the first fresh checkpoint', async () => {
  const events = turns(100);
  const source = fixture(events);
  let hold = false;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reader = new SessionHistoryReader({ batchSize: 20, readPersistedEvents: async params => {
    const result = await source.readPersistedEvents(params);
    if (hold) { hold = false; entered(); await gate; }
    return result;
  } });
  await reader.readResume('root', {});
  hold = true;
  const old = reader.readResume('root', {});
  await waiting;
  source.replace(events);
  const fresh = await reader.readResume('root', {});
  assert.equal(fresh.resume?.status, 'ready');
  release();
  const obsolete = await old;
  assert.equal(obsolete.resume?.status, 'unavailable');
  assert.deepEqual(obsolete.messages, []);
  const resumed = await reader.readResume('root', { token: resumeToken(fresh) });
  assert.equal(resumed.resume?.status, 'ready', 'the late old reader must not clear the newly accepted generation');
});

test('same-scope concurrent passive reads do not invalidate an unchanged resume snapshot', async () => {
  const source = fixture(turns(30));
  let hold = false;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reader = new SessionHistoryReader({ readPersistedEvents: async params => {
    const result = await source.readPersistedEvents(params);
    if (hold) { hold = false; entered(); await gate; }
    return result;
  } });
  const base = await reader.readResume('root', {}, 30, 'summary');
  hold = true;
  const resume = reader.readResume('root', { token: resumeToken(base) }, 30, 'summary');
  await waiting;
  const concurrent = await reader.read('root', undefined, 30, undefined, 'summary');
  release();
  const result = await resume;
  assert.equal(result.resume?.status, 'ready');
  assert.deepEqual(result.messages, concurrent.messages);
  reader.clear('root');
  const changed = await reader.readResume('root', { token: resumeToken(result) }, 30, 'summary');
  assert.deepEqual(changed.resume, { status: 'unavailable', reason: 'changed' });
});

test('bootstrap repeated native expiration stops at the existing bounded loader recovery', async () => {
  const events = turns(100);
  const source = fixture(events);
  let expire = false;
  const reader = new SessionHistoryReader({ batchSize: 20, readPersistedEvents: async params => {
    if (expire && params.cursor && params.max! > 1) source.replace(events);
    return source.readPersistedEvents(params);
  } });
  await reader.readResume('root', {});
  source.replace(events);
  expire = true;
  const start = source.calls.length;
  await assert.rejects(reader.readResume('root', {}), /History changed repeatedly during pagination/);
  assert.equal(source.calls.length - start, 6, 'terminal failure, not an unlimited outer epoch retry');
  expire = false;
  const next = await reader.readResume('root', {});
  assert.equal(next.resume?.status, 'ready');
});

test('explicit resume stages a bounded fixed-tail gap rather than ambiguous after/latest replacement', async () => {
  const initial = Array.from({ length: 901 }, (_, i) => event('user.message', `u${i}`, { content: `${i}` }));
  const source = fixture(initial, { batchSize: 20 });
  const base = await source.reader.readResume('root', {});
  assert.deepEqual(ids(base), initial.slice(-30).map(value => value.id));
  source.append(Array.from({ length: 99 }, (_, i) => event('user.message', `u${i + 901}`, { content: `${i + 901}` })));
  let token = resumeToken(base);
  const accepted: string[] = [];
  let requests = 0;
  while (true) {
    const start = source.calls.length;
    const part = await source.reader.readResume('root', { token });
    requests++;
    assert.ok(source.calls.length - start <= 10, 'four scan batches plus fixed one-event fence reads');
    assert.ok(source.calls.slice(start).reduce((n, call) => n + call.max!, 0) <= 86);
    assert.ok(part.messages.length <= 30, 'response message count is not the native read budget');
    assert.notEqual(part.resume?.status, 'unavailable');
    accepted.push(...ids(part));
    if (requests === 1) source.append([event('user.message', 'later', { content: 'after captured tail' })]);
    token = resumeToken(part);
    if (part.resume?.status === 'ready') break;
    assert.ok(requests < 10);
  }
  assert.deepEqual(accepted, Array.from({ length: 129 }, (_, i) => `u${i + 871}`));
  assert.ok(!accepted.includes('later'));
  const next = await source.reader.readResume('root', { token });
  assert.notEqual(next.resume?.status, 'unavailable');
});

test('checkpoint survives older cache replacement and other root cache eviction without whole-log probing', async () => {
  const source = fixture(turns(1000), { batchSize: 200, maxEntries: 1 });
  const base = await source.reader.readResume('root', {}, 30, 'summary');
  await source.reader.read('root', base.messages[0].id, 30, undefined, 'summary');
  await source.reader.read('other');
  const start = source.calls.length;
  const resumed = await source.reader.readResume('root', { token: resumeToken(base) }, 30, 'summary');
  assert.equal(resumed.resume?.status, 'ready');
  assert.deepEqual(resumed.messages, base.messages);
  assert.ok(source.calls.length - start <= 7);
});

test('completed resume keeps the full native batch boundary for the next ordinary older page', async () => {
  const events = Array.from({ length: 150 }, (_, i) => event('user.message', `u${i}`, { content: `${i}` }));
  const source = fixture(events, { batchSize: 20 });
  const base = await source.reader.readResume('root', {});
  const resumed = await source.reader.readResume('root', { token: resumeToken(base) });
  assert.equal(resumed.resume?.status, 'ready');
  assert.deepEqual(ids(resumed), Array.from({ length: 30 }, (_, i) => `u${i + 120}`));
  const older = await source.reader.read('root', 'u120');
  assert.deepEqual(ids(older), Array.from({ length: 30 }, (_, i) => `u${i + 90}`));
});

test('a missing resume root stops at its known lower event instead of searching the whole journal', async () => {
  const events = Array.from({ length: 1000 }, (_, i) => event('user.message', `u${i}`, { content: `${i}` }));
  const source = fixture(events, { batchSize: 20 });
  const base = await source.reader.readResume('root', {});
  source.replace(events.filter(event => event.id !== 'u970'), false);
  const start = source.calls.length;
  const page = await source.reader.readResume('root', { token: resumeToken(base) }, 1);
  assert.deepEqual(page.resume, { status: 'unavailable', reason: 'boundary' });
  assert.deepEqual(page.messages, []);
  assert.ok(source.calls.length - start <= 7);
});

for (const batchSize of [20, 200]) {
  test(`resume rejects a late retained-prefix task update whether its owner was scanned or omitted (${batchSize})`, async () => {
    const initial = [
      event('user.message', 'task-question', { content: 'Start background work' }),
      event('assistant.message', 'task-request', { messageId: 'task-answer', content: '', toolRequests: [
        { toolCallId: 'old-task', name: 'task', arguments: { prompt: 'Background work' } },
      ] }),
      event('subagent.started', 'task-start', { toolCallId: 'old-task', agentName: 'explore' }, 'old-agent'),
      ...turns(60),
    ];
    const source = fixture(initial, { batchSize });
    const base = await source.reader.readResume('root', {}, 30, 'summary');
    const older = await source.reader.read('root', base.messages[0].id, 200, undefined, 'summary');
    assert.equal(older.messages.find(message => message.id === 'subagent-old-task')?.subagent?.status, 'running');
    const completion = event('subagent.completed', 'task-complete', { toolCallId: 'old-task' }, 'old-agent');
    source.append([completion]);
    const resumed = await source.reader.readResume('root', { token: resumeToken(base) }, 30, 'summary');
    assert.deepEqual(resumed.resume, { status: 'unavailable', reason: 'boundary' });
    assert.deepEqual(resumed.messages, []);
    assert.equal(replay([...initial, completion]).find(message => message.id === 'subagent-old-task')?.subagent?.status, 'completed');
  });
}

test('resume still accepts a task whose complete ownership and updates are within the new suffix', async () => {
  const source = fixture(turns(20), { batchSize: 200 });
  const base = await source.reader.readResume('root', {}, 30, 'summary');
  source.append([
    event('user.message', 'new-task-question', { content: 'New work' }),
    event('assistant.message', 'new-task-request', { messageId: 'new-task-answer', content: '', toolRequests: [
      { toolCallId: 'new-task', name: 'task', arguments: { prompt: 'New background work' } },
    ] }),
    event('subagent.started', 'new-task-start', { toolCallId: 'new-task' }, 'new-agent'),
    event('assistant.message', 'new-child-answer', { messageId: 'child-answer', content: 'Done' }, 'new-agent'),
    event('subagent.completed', 'new-task-done', { toolCallId: 'new-task' }, 'new-agent'),
  ]);
  const messages = [];
  let token = resumeToken(base);
  for (let i = 0; i < 3; i++) {
    const page = await source.reader.readResume('root', { token }, 30, 'summary');
    assert.notEqual(page.resume?.status, 'unavailable');
    messages.push(...page.messages);
    if (page.resume?.status === 'ready') break;
    token = resumeToken(page);
  }
  assert.equal(messages.find(message => message.id === 'subagent-new-task')?.subagent?.status, 'completed');
});

test('explicit resume does not confuse expired or missing native boundaries with deleted UI anchors', async () => {
  for (const mutation of ['cursor-generation', 'rewind', 'host-clear'] as const) {
    const source = fixture(turns(1000), { batchSize: 20 });
    const base = await source.reader.readResume('root', {});
    if (mutation === 'cursor-generation') source.replace(turns(1000));
    if (mutation === 'rewind') source.replace(turns(900), false);
    if (mutation === 'host-clear') source.reader.clear('root');
    const start = source.calls.length;
    const result = await source.reader.readResume('root', { token: resumeToken(base) }, 1);
    assert.equal(result.resume?.status, 'unavailable');
    assert.deepEqual(result.messages, []);
    assert.equal(result.latest, undefined);
    assert.ok(source.calls.length - start <= 2, 'no missing-anchor journal scan, even at limit one');
  }
});

test('rewind between continuation parts invalidates the entire staged range', async () => {
  const source = fixture(turns(30), { batchSize: 20 });
  const base = await source.reader.readResume('root', {});
  source.append(turns(100, 'new-'));
  const pending = await source.reader.readResume('root', { token: resumeToken(base) });
  assert.equal(pending.resume?.status, 'pending');
  source.replace(turns(30), false);
  const rejected = await source.reader.readResume('root', { token: resumeToken(pending) });
  assert.equal(rejected.resume?.status, 'unavailable');
  assert.deepEqual(rejected.messages, []);
});

test('forged, cross-session and cross-detail locators never issue native reads', async () => {
  const source = fixture(turns(20));
  const base = await source.reader.readResume('root', {}, 30, 'summary');
  const token = resumeToken(base);
  const start = source.calls.length;
  assert.equal((await source.reader.readResume('root', { token: `${token}x` }, 30, 'summary')).resume?.status, 'unavailable');
  await assert.rejects(source.reader.readResume('other', { token }, 30, 'summary'), /different session/);
  await assert.rejects(source.reader.readResume('root', { token }, 30, 'full'), /detail scope/);
  assert.equal(source.calls.length, start);
});

function checkCache(reader: SessionHistoryReader, entries = 3, bytes = 8 * 1024 * 1024, messages = 10_000) {
  const state = cacheOf(reader);
  assert.ok(state.cache.size <= entries);
  assert.ok(state.cachedBytes <= bytes);
  assert.ok(state.cachedMessages <= messages);
  assert.equal(state.cachedBytes, [...state.cache.values()].reduce((n, entry) => n + entry.data.byteLength, 0));
  assert.equal(state.cachedMessages, [...state.cache.values()].reduce((n, entry) => n + entry.messages, 0));
  return state;
}

test('only the injected passive RPC is needed: no native session hydration or filesystem', async () => {
  const source = fixture(turns(3));
  let hydration = 0;
  const runtime = {
    rpc: { sessions: { readPersistedEvents: source.readPersistedEvents } },
    resumeSession() { hydration++; throw new Error('forbidden'); },
    createSession() { hydration++; throw new Error('forbidden'); },
    getSession() { hydration++; throw new Error('forbidden'); },
  };
  const reader = new SessionHistoryReader({
    readPersistedEvents: params => runtime.rpc.sessions.readPersistedEvents(params), batchSize: 2,
  });
  assert.deepEqual((await reader.read('s')).messages, replay(turns(3)));
  assert.equal(hydration, 0);
  assert.ok(source.calls.every((call) => call.direction === 'backward' && call.sessionId === 's'));
});

test('latest windows are bounded and warm opens validate cursors without rereading the full log', async () => {
  const { reader, calls } = fixture(turns(20_000), { batchSize: 40, maxEvents: 200 });
  const first = await reader.read('s');
  assert.equal(first.messages.length, DEFAULT_HISTORY_LIMIT);
  assert.equal(first.latest, true);
  assert.equal(first.hasMore, true);
  assert.ok(calls.length <= 4);
  assert.ok(calls.every((call) => call.direction === 'backward'));
  calls.length = 0;
  assert.deepEqual(await reader.read('s'), first);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.max === 1));
  assert.ok(calls[1]?.cursor);
});

for (const batchSize of [1, 2, 4, 7]) {
  test(`before pages match canonical IDs across partial user/reasoning turns (batch ${batchSize})`, async () => {
    const events = turns(23);
    const { reader } = fixture(events, { batchSize, maxEvents: 100 });
    let page = await reader.read('s', undefined, 3);
    let collected = page.messages;
    while (page.hasMore) {
      page = await reader.read('s', page.messages[0]!.id, 3);
      assert.equal(page.latest, undefined);
      assert.equal(page.append, undefined);
      assert.ok(page.messages.length);
      collected = [...page.messages, ...collected];
    }
    assert.deepEqual(collected, replay(events));
    assert.equal(new Set(collected.map((message) => message.id)).size, collected.length);
  });
}

test('rolling windows page arbitrarily far without accumulating a full-session fold', async () => {
  const events = turns(1200);
  const { reader, calls } = fixture(events, { batchSize: 12, maxEvents: 80 });
  let page = await reader.read('s', undefined, 5);
  let count = page.messages.length;
  while (page.hasMore) {
    calls.length = 0;
    page = await reader.read('s', page.messages[0]!.id, 5);
    assert.equal(page.latest, undefined);
    count += page.messages.length;
    assert.ok(calls.length < 8);
    const entry = checkCache(reader).cache.get('s')!;
    const cached = deserialize(entry.data) as { events: SessionEvent[]; projection?: unknown };
    assert.ok(cached.events.length < 50);
    assert.equal(cached.projection, undefined);
    assert.ok(entry.messages < 30);
  }
  assert.equal(count, 2400);
});

test('long autonomous work pages at native assistant turns without rereading its initial user prompt', async () => {
  const events = [
    event('user.message', 'initial-user', { content: 'Keep working' }),
    ...Array.from({ length: 500 }, (_, i) => [
      event('assistant.turn_start', `turn-${i}`, { turnId: `native-turn-${i}` }),
      event('assistant.reasoning', `reason-${i}`, { reasoningId: `r-${i}`, content: `Thought ${i}` }),
      event('assistant.message', `event-${i}`, { messageId: `answer-${i}`, content: `Progress ${i}` }),
      event('assistant.turn_end', `end-${i}`, { turnId: `native-turn-${i}` }),
    ]).flat(),
  ];
  const { reader, calls } = fixture(events, { batchSize: 12, maxEvents: 60 });
  let page = await reader.read('s', undefined, 5);
  let collected = page.messages;
  while (page.hasMore) {
    calls.length = 0;
    page = await reader.read('s', page.messages[0]!.id, 5);
    assert.ok(page.messages.length);
    assert.equal(page.latest, undefined);
    collected = [...page.messages, ...collected];
    assert.ok(calls.reduce((n, call) => n + call.max!, 0) <= 60);
  }
  assert.deepEqual(collected, replay(events));
});

test('invisible native payloads do not consume the display window or require unrelated agent owners', async () => {
  const events = [
    event('user.message', 'u', { content: 'Question' }),
    event('hook.start', 'hook', { input: 'invisible'.repeat(100_000) }, 'unrelated-old-agent'),
    event('assistant.message', 'answer', {
      messageId: 'a', content: 'Visible reply', reasoningText: 'Visible reasoning',
      encryptedContent: 'opaque'.repeat(100_000),
      reasoningOpaque: 'opaque'.repeat(100_000), reasoningBlocks: { private: 'x'.repeat(100_000) },
    }),
    event('permission.completed', 'permission', { permissionRequest: 'x'.repeat(100_000) }),
  ];
  const source = fixture(events, { maxReadBytes: 1500, batchSize: 2 });
  assert.deepEqual((await source.reader.read('s')).messages, replay(events));
  const cached = deserialize(checkCache(source.reader).cache.get('s')!.data) as { events: SessionEvent[] };
  assert.ok(JSON.stringify(cached.events).length < 1500);
  assert.equal((events[2]!.data as Record<string, unknown>).encryptedContent, 'opaque'.repeat(100_000));
});

test('retained tool projections exactly preserve canonical details and unbounded ask answers', async () => {
  const large = 'detail '.repeat(20_000);
  const answer = 'Answer '.repeat(2000);
  const events = [
    event('user.message', 'u', { content: 'Work' }),
    event('assistant.message', 'request-event', {
      messageId: 'request', content: '', toolRequests: [
        { toolCallId: 'read', name: 'bash', arguments: { command: large } },
        { toolCallId: 'fail', name: 'edit', arguments: { path: 'file', old_str: large, new_str: large } },
        { toolCallId: 'ask', name: 'ask_user', arguments: { question: 'Choose' } },
      ],
    }),
    event('tool.execution_start', 'read-start', { toolCallId: 'read', arguments: { command: large } }),
    event('tool.execution_complete', 'read-end', { toolCallId: 'read', result: { content: large, detailedContent: large } }),
    event('tool.execution_complete', 'fail-end', { toolCallId: 'fail', error: { message: large } }),
    event('tool.execution_complete', 'ask-end', { toolCallId: 'ask', result: { content: `User responded: ${answer}` } }),
  ];
  const original = structuredClone(events);
  const { reader } = fixture(events, { maxReadBytes: 1000, batchSize: 2 });
  const expected = replay(events);
  assert.deepEqual((await reader.read('s')).messages, expected);
  assert.deepEqual((await reader.read('s')).messages, expected);
  assert.deepEqual(events, original);
  const cached = deserialize(checkCache(reader).cache.get('s')!.data) as { events: SessionEvent[] };
  assert.ok(JSON.stringify(cached.events).length < 40_000);
  assert.equal(expected.at(-1)?.content, answer.trim());
  assert.match(expected[1]!.toolCalls![0]!.output!, /140000/);
});

test('off-page agent work does not force latest pages back to an old spawner', async () => {
  const events = [
    event('user.message', 'initial', { content: 'Start background work' }),
    event('assistant.message', 'spawn', {
      messageId: 'spawn-message', content: '',
      toolRequests: [{ toolCallId: 'outer', name: 'task', arguments: { prompt: 'Keep working' } }],
    }),
    event('subagent.started', 'started', { toolCallId: 'outer' }, 'outer-agent'),
    ...Array.from({ length: 150 }, (_, i) => [
      event('assistant.turn_start', `turn-${i}`),
      event('assistant.message', `child-${i}`, { messageId: `child-message-${i}`, content: 'Background progress' }, 'outer-agent'),
      event('assistant.message', `root-${i}`, { messageId: `root-message-${i}`, content: 'Root progress' }),
    ]).flat(),
    event('subagent.completed', 'completed', { toolCallId: 'outer' }, 'outer-agent'),
  ];
  const { reader, calls } = fixture(events, { batchSize: 12, maxEvents: 30 });
  let page = await reader.read('s', undefined, 5);
  assert.ok(calls.length <= 3);
  let collected = page.messages;
  while (page.hasMore) {
    page = await reader.read('s', page.messages[0]!.id, 5);
    assert.equal(page.latest, undefined);
    assert.ok(page.messages.length);
    collected = [...page.messages, ...collected];
    checkCache(reader);
  }
  assert.deepEqual(collected, replay(events));
});

test('cache eviction cannot turn a valid older anchor into a latest reset', async () => {
  const events = [...background(), ...turns(30, 'later-')];
  const { reader } = fixture(events, { maxBytes: 1, maxEvents: 8, batchSize: 4 });
  let page = await reader.read('s', undefined, 4);
  let collected = page.messages;
  while (page.hasMore) {
    page = await reader.read('s', page.messages[0]!.id, 4);
    assert.equal(page.latest, undefined);
    assert.ok(page.messages.length);
    collected = [...page.messages, ...collected];
    assert.equal(checkCache(reader).cachedBytes, 0);
  }
  assert.deepEqual(collected, replay(events));
});

test('after is inclusive, uses durable user IDs and canonical assistant IDs, and resets on gaps', async () => {
  const { reader } = fixture(turns(9), { batchSize: 4 });
  const latest = await reader.read('s', undefined, 3);
  assert.deepEqual(ids(latest), ['a7', 'u8', 'a8']);
  assert.deepEqual(ids(await reader.read('s', undefined, 3, 'u7')), ['u7', 'a7', 'u8', 'a8']);
  assert.equal((await reader.read('s', undefined, 3, 'u7')).append, true);
  assert.equal((await reader.read('s', undefined, 3, 'u6')).latest, true);
  for (const missing of ['missing', 'accepted8', 'e8', 'opaque/1/not-a-message-id']) {
    assert.deepEqual(await reader.read('s', undefined, 3, missing), latest);
  }
});

test('cold before anchors are found beyond work targets; only missing anchors reset to the real tail', async () => {
  const { reader } = fixture(turns(15), { batchSize: 4 });
  const older = await reader.read('s', 'u4', 3);
  assert.deepEqual(ids(older), ['a2', 'u3', 'a3']);
  assert.equal(older.latest, undefined);
  const missing = await reader.read('s', 'missing', 3);
  assert.deepEqual(ids(missing), ['a13', 'u14', 'a14']);
  assert.equal(missing.latest, true);
  const bounded = fixture(turns(1000), { batchSize: 8, maxEvents: 40 });
  const first = await bounded.reader.read('s', 'u0', 3);
  assert.equal(first.latest, undefined);
  assert.deepEqual(first.messages, []);
  assert.equal(first.hasMore, false);
  assert.ok(bounded.calls.every(call => call.max! <= 8));
});

function background(): SessionEvent[] {
  return [
    event('user.message', 'u0', { content: 'First' }),
    event('assistant.message', 'spawn-event', {
      messageId: 'spawn', content: '', toolRequests: [{ toolCallId: 'outer', name: 'task', arguments: { prompt: 'Inspect' } }],
    }),
    event('subagent.started', 'outer-start', { toolCallId: 'outer', agentName: 'explore', agentDisplayName: 'Outer', agentDescription: 'Outer task' }, 'outer-agent'),
    event('assistant.message', 'first-event', { messageId: 'first-answer', content: 'Started' }),
    event('user.message', 'u1', { content: 'Second' }),
    event('user.message', 'child-user', { content: 'Child prompt', parentAgentTaskId: 'outer' }, 'outer-agent'),
    event('assistant.message', 'child-spawn', {
      messageId: 'child-spawn-message', content: '', toolRequests: [{ toolCallId: 'inner', name: 'task', arguments: { prompt: 'Nested' } }],
    }, 'outer-agent'),
    event('subagent.started', 'inner-start', {
      toolCallId: 'inner', agentName: 'task', agentDisplayName: 'Inner', agentDescription: 'Inner task',
    }, 'inner-agent'),
    event('assistant.message', 'inner-answer-event', { messageId: 'inner-answer', content: 'Nested answer', reasoningText: 'Reason' }, 'inner-agent'),
    event('subagent.completed', 'inner-end', { toolCallId: 'inner' }, 'inner-agent'),
    event('assistant.message', 'child-answer-event', { messageId: 'child-answer', content: 'Outer answer' }, 'outer-agent'),
    event('subagent.completed', 'outer-end', { toolCallId: 'outer' }, 'outer-agent'),
    event('assistant.message', 'second-event', { messageId: 'second-answer', content: 'Done' }),
  ];
}

test('nested background agents crossing root turns and native chunk boundaries match the shared fold', async () => {
  const events = background();
  const { reader } = fixture(events, { batchSize: 2 });
  const expected = replay(events);
  const latest = await reader.read('s', undefined, 2);
  assert.deepEqual(latest.messages, expected.slice(-2));
  const before = await reader.read('s', 'first-answer', 2);
  assert.deepEqual(before.messages, expected.slice(0, 2));
  const card = before.messages[1]!;
  assert.equal(card.subagent?.status, 'completed');
  assert.equal(card.subMessages?.[0]?.content, 'Child prompt');
  assert.equal(card.subMessages?.[1]?.subMessages?.[0]?.id, 'inner-answer');
  assert.equal(card.subMessages?.[1]?.subagent?.status, 'completed');
  assert.equal(card.subagent?.prompt, 'Inspect');
});

for (const batchSize of [1, 2, 7, 1000]) {
  test(`summary pages preserve canonical cards without child transcripts (batch ${batchSize})`, async () => {
    const events = [...background(), ...turns(12, 'later-')];
    const { reader } = fixture(events, { batchSize });
    let page = await reader.read('s', undefined, 2, undefined, 'summary');
    let collected = page.messages;
    while (page.hasMore) {
      page = await reader.read('s', page.messages[0]!.id, 2, undefined, 'summary');
      assert.notEqual(page.latest, true);
      assert.ok(page.messages.length);
      collected = [...page.messages, ...collected];
    }
    assert.deepEqual(collected, replay(events).map(summarizeMessage));
    const card = collected.find(message => message.subagent)!;
    assert.equal(card.subagent?.toolCallId, 'outer');
    assert.equal(card.subagent?.status, 'completed');
    assert.equal(card.subagent?.toolCount, undefined);
    assert.equal(card.subagent?.prompt, undefined);
    assert.equal(card.subMessages, undefined);
    assert.deepEqual((await reader.read('s', undefined, 200)).messages, replay(events));
    assert.deepEqual((await reader.read('s', undefined, 200, undefined, 'summary')).messages,
      replay(events).map(summarizeMessage));
  });
}

test('summary snapshots discard child text, reasoning, tool details and all spawn prompts before caching', async () => {
  const secret = 'private-child-detail-'.repeat(3000);
  const events = background().map(value => {
    if (value.type === 'assistant.message') return event(value.type, value.id, {
      ...value.data,
      ...(value.agentId ? { content: secret, reasoningText: secret } : {}),
      ...('toolRequests' in value.data ? {
        toolRequests: value.data.toolRequests?.map(request => ({ ...request, arguments: { prompt: secret } })),
      } : {}),
    }, value.agentId);
    return value;
  });
  const { reader } = fixture(events);
  const full = await reader.read('s');
  const summary = await reader.readWithMetadata('s', undefined, 30, undefined, 'summary');
  assert.deepEqual(summary.messages, full.messages.map(summarizeMessage));
  const entry = checkCache(reader).cache.get(JSON.stringify(['s', 'summary']))!;
  const snapshot = deserialize(entry.data);
  assert.ok(!JSON.stringify(snapshot).includes('private-child-detail-'));
  assert.ok(JSON.stringify(summary.messages).length < JSON.stringify(full.messages).length / 20);
  assert.equal(entry.messages, full.messages.length);
  reader.clear('s');
  assert.equal(checkCache(reader).cache.size, 0);
});

async function allChildren(reader: SessionHistoryReader, toolCallId: string, details: 'full' | 'summary') {
  let page = await reader.readSubagent('s', toolCallId, undefined, 1, undefined, details);
  let messages = page.messages;
  while (page.hasMore) {
    page = await reader.readSubagent('s', toolCallId, page.messages[0]!.id, 1, undefined, details);
    assert.notEqual(page.latest, true);
    assert.ok(page.messages.length);
    messages = [...page.messages, ...messages];
  }
  return messages;
}

for (const batchSize of [1, 3, 1000]) {
  test(`subagent pages use canonical direct children and isolated target scopes (batch ${batchSize})`, async () => {
    const events = background();
    const { reader } = fixture(events, { batchSize });
    const canonical = replay(events);
    const outer = canonical.find(message => message.id === 'subagent-outer')!;
    const inner = outer.subMessages!.find(message => message.id === 'subagent-inner')!;
    assert.deepEqual(await allChildren(reader, 'outer', 'summary'), outer.subMessages!.map(summarizeMessage));
    assert.deepEqual(await allChildren(reader, 'outer', 'full'), outer.subMessages);
    assert.deepEqual(await allChildren(reader, 'inner', 'summary'), inner.subMessages);
    assert.deepEqual((await reader.read('s')).messages, canonical);
    const page = await reader.readSubagent('s', 'outer');
    assert.equal(page.subagent.prompt, 'Inspect');
    assert.equal(page.subagent.toolCallId, 'outer');
    assert.equal(page.messages[1]?.subagent?.prompt, undefined);
    assert.equal(page.messages[1]?.subMessages, undefined);
    assert.equal(page.messages[1]?.subagent?.toolCallId, 'inner');
    assert.deepEqual((await reader.readSubagent('s', 'inner')).subagent, { ...inner.subagent, toolCallId: 'inner' });
  });
}

test('subagent before/after paging, cache validation, cloning, rewind and missing targets are explicit', async () => {
  const { reader, calls, replace, append } = fixture(background(), { batchSize: 2 });
  const latest = await reader.readSubagent('s', 'outer', undefined, 1);
  calls.length = 0;
  assert.deepEqual(await reader.readSubagent('s', 'outer', undefined, 1), latest);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.max, 1);
  assert.ok(calls.every(call => call.cursor && call.direction === 'forward'));
  const appended = await reader.readSubagent('s', 'outer', undefined, 1, 'subagent-inner');
  assert.equal(appended.append, true);
  assert.deepEqual(ids(appended), ['subagent-inner', 'child-answer']);
  assert.equal((await reader.readSubagent('s', 'outer', undefined, 1, 'child-user')).latest, true);
  assert.deepEqual(await reader.readSubagent('s', 'outer', 'missing', 1), latest);
  latest.subagent.prompt = 'poison';
  latest.messages[0]!.content = 'poison';
  assert.equal((await reader.readSubagent('s', 'outer')).subagent.prompt, 'Inspect');
  append([event('assistant.message', 'new-child', { messageId: 'new-child-answer', content: 'New' }, 'outer-agent')]);
  assert.equal((await reader.readSubagent('s', 'outer', undefined, 1, 'child-answer')).append, true);
  const empty = background().slice(0, 3);
  replace(empty);
  const reset = await reader.readSubagent('s', 'outer', 'child-answer', 1);
  assert.equal(reset.latest, true);
  assert.deepEqual(reset.messages, []);
  assert.equal(reset.hasMore, false);
  replace([]);
  await assert.rejects(reader.readSubagent('s', 'outer'), { code: 'SUBAGENT_NOT_FOUND', status: 404 });
  await assert.rejects(reader.readSubagent('s', 'missing'), { code: 'SUBAGENT_NOT_FOUND', status: 404 });
});

test('native data.agentId, nested parentId and legacy ownership route the same child transcript', async () => {
  const events = [
    event('user.message', 'u', { content: 'Root' }),
    event('assistant.message', 'spawn', { messageId: 'spawn', content: '', toolRequests: [
      { toolCallId: 'outer', name: 'task', arguments: { prompt: 'Outer prompt' } },
    ] }),
    event('subagent.started', 'started', { toolCallId: 'outer', agentId: 'native-outer' }),
    event('assistant.message', 'legacy', { messageId: 'legacy', content: 'Legacy', parentToolCallId: 'outer' }, 'registry-alias'),
    event('assistant.message', 'native', { messageId: 'native', content: 'Native' }, 'native-outer'),
    event('subagent.started', 'inner-start', { toolCallId: 'inner', parentId: 'registry-alias' }, 'native-inner'),
    event('assistant.message', 'nested-answer', { messageId: 'nested-answer', content: 'Nested' }, 'native-inner'),
    event('subagent.completed', 'outer-end', { toolCallId: 'outer', totalToolCalls: 7, model: 'native-model' }),
  ];
  const { reader } = fixture(events, { batchSize: 1 });
  const outer = replay(events).find(message => message.id === 'subagent-outer')!;
  assert.deepEqual((await reader.readSubagent('s', 'outer')).messages, outer.subMessages!.map(summarizeMessage));
  assert.equal((await reader.readSubagent('s', 'outer')).subagent.toolCount, 7);
  assert.deepEqual((await reader.readSubagent('s', 'inner')).messages,
    outer.subMessages!.find(message => message.id === 'subagent-inner')!.subMessages);
  assert.deepEqual((await reader.read('s', undefined, 30, undefined, 'summary')).messages,
    replay(events).map(summarizeMessage));
});

test('subagent snapshots retain only requested content, with nested prompts available solely in full mode', async () => {
  const { reader } = fixture([
    event('user.message', 'private-root', { content: 'unrelated-root-secret' }),
    ...background(),
  ]);
  await reader.readSubagent('s', 'inner');
  const snapshot = deserialize(checkCache(reader).cache.get(JSON.stringify(['s', 'summary', 'inner']))!.data);
  const serialized = JSON.stringify(snapshot);
  assert.ok(serialized.includes('Nested answer'));
  assert.ok(serialized.includes('Nested'));
  for (const hidden of ['unrelated-root-secret', 'Child prompt', 'Outer answer', 'Inspect']) {
    assert.ok(!serialized.includes(hidden), hidden);
  }
  reader.clear('s');
  assert.equal(checkCache(reader).cache.size, 0);
});

test('subagent scopes retain canonical tools, reasoning and ask replies without other branches', async () => {
  const events = [
    ...background().slice(0, 3),
    event('assistant.reasoning', 'child-reasoning', { reasoningId: 'reason', content: 'Child reasoning' }, 'outer-agent'),
    event('assistant.message', 'child-tools', {
      messageId: 'child-tools', content: 'Working', toolRequests: [
        { toolCallId: 'view', name: 'view', arguments: { path: 'child-file' } },
        { toolCallId: 'ask', name: 'ask_user', arguments: { question: 'Child question?' } },
      ],
    }, 'outer-agent'),
    event('tool.execution_complete', 'view-complete', { toolCallId: 'view', result: { content: 'Output '.repeat(3000) } }),
    event('tool.execution_complete', 'ask-complete', { toolCallId: 'ask', result: { content: 'User selected: Child answer' } }),
    ...turns(1200, 'unrelated-'),
    event('assistant.message', 'root-final', { messageId: 'root-final', content: 'End' }),
  ];
  const { reader } = fixture(events, { batchSize: 8, maxEvents: 10 });
  const canonical = replay(events);
  const children = canonical.find(message => message.id === 'subagent-outer')!.subMessages!;
  const detail = await reader.readSubagent('s', 'outer');
  assert.deepEqual(detail.messages, children);
  assert.equal(detail.messages[0]?.thought, 'Child reasoning');
  assert.equal(detail.messages[0]?.toolCalls?.[0]?.status, 'completed');
  assert.ok(detail.messages[0]?.toolCalls?.[0]?.output?.includes('已截断'));
  assert.equal(detail.messages[1]?.content, 'Child answer');
  const snapshot = deserialize(checkCache(reader).cache.get(JSON.stringify(['s', 'summary', 'outer']))!.data);
  assert.ok(snapshot.events.length < 10, 'unrelated native batches leave no transcript shells');
  await assert.rejects(reader.readSubagent('s', 'absent'), { code: 'SUBAGENT_NOT_FOUND' });
  assert.deepEqual((await reader.read('s', undefined, 30, undefined, 'summary')).messages,
    canonical.slice(-30).map(summarizeMessage));
});

test('older child pages keep their validated snapshot when unrelated native events append', async () => {
  const { reader, append, calls } = fixture(background(), { batchSize: 2 });
  await reader.readSubagent('s', 'outer', undefined, 1);
  append(turns(100, 'new-root-'));
  calls.length = 0;
  const older = await reader.readSubagent('s', 'outer', 'child-answer', 1);
  assert.deepEqual(ids(older), ['subagent-inner']);
  assert.equal(older.latest, undefined);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.max === 1));
});

test('expired child scans discard old folds and clear prevents concurrent cache retention', async () => {
  const source = fixture(background(), { batchSize: 2 });
  let changed = false;
  const reader = new SessionHistoryReader({
    batchSize: 2,
    readPersistedEvents: async params => {
      if (!changed && params.cursor && params.direction === 'forward') {
        changed = true;
        source.replace(background().slice(0, 3));
      }
      return source.readPersistedEvents(params);
    },
  });
  const reset = await reader.readSubagent('s', 'outer', 'child-answer');
  assert.deepEqual(reset.messages, []);
  assert.equal(reset.hasMore, false);
  assert.equal(reset.latest, true);
  assert.equal(checkCache(reader).cache.size, 0);
  const pending = reader.readSubagent('s', 'outer');
  reader.clear('s');
  await pending;
  assert.equal(checkCache(reader).cache.size, 0);
  await reader.readSubagent('s', 'outer');
  assert.equal(checkCache(reader).cache.size, 1);
});

for (const batchSize of [1, 7, 32]) {
  test(`visible parent checkpoints skip unrelated history before and after a child (batch ${batchSize})`, async () => {
    const events = [...turns(200, 'old-'), ...background(), ...turns(200, 'later-')];
    const { reader, calls, append } = fixture(events, { batchSize });
    const parent = await reader.read('s', 'first-answer', 2, undefined, 'summary');
    assert.equal(parent.messages.at(-1)?.subagent?.toolCallId, 'outer');
    const expected = replay(events).find(message => message.id === 'subagent-outer')!;
    calls.length = 0;
    const detail = await reader.readSubagent('s', 'outer');
    assert.deepEqual(detail.messages, expected.subMessages!.map(summarizeMessage));
    assert.equal(detail.subagent.prompt, 'Inspect');
    assert.ok(calls.every(call => call.direction === 'backward'), 'never restart at the journal head');
    assert.ok(calls.reduce((count, call) => count + call.max!, 0) < 120, 'skip old prefix and known unrelated suffix');
    append([event('assistant.message', 'late-child', { messageId: 'late-child', content: 'After completion' }, 'outer-agent')]);
    calls.length = 0;
    const refresh = await reader.readSubagent('s', 'outer', undefined, 30, 'child-answer');
    assert.equal(refresh.append, true);
    assert.deepEqual(ids(refresh), ['child-answer', 'late-child']);
    assert.ok(calls.length <= 3);
    assert.ok(calls.every(call => call.direction === 'backward'));
  });
}

test('a seeded child includes late orphan carry and appends since its parent snapshot', async () => {
  const initial = [...turns(100, 'old-'), ...background(), ...turns(100, 'later-'),
    event('assistant.message', 'late-before-open', { messageId: 'late-before-open', content: 'Late native child' }, 'outer-agent')];
  const { reader, append, calls } = fixture(initial, { batchSize: 8 });
  await reader.read('s', 'first-answer', 2, undefined, 'summary');
  const extra = [
    event('assistant.message', 'new-nested-task', { messageId: 'new-task', content: '', toolRequests: [
      { toolCallId: 'new-nested', name: 'task', arguments: { prompt: 'New nested prompt' } },
    ] }, 'outer-agent'),
    event('subagent.started', 'new-nested-start', { toolCallId: 'new-nested' }, 'new-native-agent'),
    event('assistant.message', 'new-nested-answer', { messageId: 'new-nested-answer', content: 'New answer' }, 'new-native-agent'),
    event('subagent.completed', 'new-nested-end', { toolCallId: 'new-nested', totalToolCalls: 4 }, 'new-native-agent'),
  ];
  append(extra);
  calls.length = 0;
  const page = await reader.readSubagent('s', 'outer');
  const expected = replay([...initial, ...extra]).find(message => message.id === 'subagent-outer')!;
  assert.deepEqual(page.messages, expected.subMessages!.map(summarizeMessage));
  assert.ok(calls.every(call => call.direction === 'backward'), 'orphan updates do not require the old session prefix');
  const nested = await reader.readSubagent('s', 'new-nested');
  assert.equal(nested.subagent.prompt, 'New nested prompt');
  assert.deepEqual(ids(nested), ['new-nested-answer']);
});

test('refresh ingests only new native batches and retains the cursor across empty reads', async () => {
  const initial = [...turns(1000, 'old-'), ...background()];
  const { reader, append, calls } = fixture(initial, { batchSize: 8 });
  await reader.readSubagent('s', 'outer');
  for (let i = 0; i < 2; i++) {
    calls.length = 0;
    const unchanged = await reader.readSubagent('s', 'outer', undefined, 30, 'child-answer');
    assert.equal(unchanged.append, true);
    assert.deepEqual(ids(unchanged), ['child-answer']);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.cursor));
  }
  const extra = [
    ...turns(20, 'new-root-'),
    ...Array.from({ length: 45 }, (_, i) => event('assistant.message', `new-${i}`, {
      messageId: `new-${i}`, content: `Child ${i}`,
    }, 'outer-agent')),
  ];
  append(extra);
  calls.length = 0;
  const refreshed = await reader.readSubagent('s', 'outer', undefined, 30, 'child-answer');
  assert.equal(refreshed.latest, true);
  assert.equal(refreshed.append, undefined);
  assert.equal(refreshed.hasMore, true);
  const expected = replay([...initial, ...extra]).find(message => message.id === 'subagent-outer')!.subMessages!;
  assert.deepEqual(refreshed.messages, expected.slice(-30).map(summarizeMessage));
  assert.ok(calls.every(call => call.cursor && call.direction === 'forward'));
  assert.equal(calls.length, 1 + Math.ceil(extra.length / 8));
  const before = await reader.readSubagent('s', 'outer', refreshed.messages[0]!.id);
  assert.deepEqual([...before.messages, ...refreshed.messages], expected.map(summarizeMessage));
});

test('a cached parent summary does not hide descendant messages written after completion', async () => {
  const events = [...turns(100, 'old-'), ...background(),
    event('assistant.message', 'post-completion', { messageId: 'post-completion', content: 'Still readable' }, 'inner-agent')];
  const { reader } = fixture(events, { batchSize: 8, maxEntries: 1 });
  await reader.read('s', 'first-answer', 2, undefined, 'summary');
  await reader.readSubagent('s', 'outer');
  const inner = await reader.readSubagent('s', 'inner');
  const expected = replay(events).find(message => message.id === 'subagent-outer')!
    .subMessages!.find(message => message.id === 'subagent-inner')!;
  assert.deepEqual(inner.messages, expected.subMessages);
  assert.deepEqual(ids(inner), ['inner-answer', 'post-completion']);
});

test('expired checkpoint and incremental tail cursors invalidate the whole scoped snapshot', async () => {
  const source = fixture(background(), { batchSize: 2 });
  let expireCursor: string | undefined;
  const reader = new SessionHistoryReader({
    batchSize: 2,
    readPersistedEvents: async params => {
      const result = await source.readPersistedEvents(params);
      if (expireCursor && params.cursor === expireCursor) {
        expireCursor = undefined;
        return { ...result, cursorStatus: 'expired' };
      }
      return result;
    },
  });
  await reader.read('s', undefined, 30, undefined, 'summary');
  expireCursor = deserialize(checkCache(reader).cache.get(JSON.stringify(['s', 'summary']))!.data).tailCursor;
  const child = await reader.readSubagent('s', 'outer', 'child-answer');
  assert.equal(child.latest, true);
  assert.equal(child.messages.at(-1)?.id, 'child-answer');
  await reader.readSubagent('s', 'outer');
  expireCursor = deserialize(checkCache(reader).cache.get(JSON.stringify(['s', 'summary', 'outer']))!.data).tailCursor;
  const modified = background().map(value => value.id === 'child-answer-event'
    ? event('assistant.message', value.id, { messageId: 'child-answer', content: 'Rewritten' }, 'outer-agent') : value);
  source.replace(modified, false);
  const reset = await reader.readSubagent('s', 'outer', undefined, 30, 'child-answer');
  assert.equal(reset.latest, true);
  assert.equal(reset.messages.at(-1)?.content, 'Rewritten');
});

test('a delayed native start seeds at its original task request, not its later root turn', async () => {
  const events = [
    ...turns(100, 'old-'), ...background().slice(0, 2), ...turns(100, 'interleaved-'),
    ...background().slice(2),
  ];
  const { reader, calls } = fixture(events, { batchSize: 8 });
  await reader.read('s', undefined, 4, undefined, 'summary');
  calls.length = 0;
  const child = await reader.readSubagent('s', 'outer');
  assert.equal(child.subagent.prompt, 'Inspect');
  assert.deepEqual(child.messages, replay(events).find(message => message.id === 'subagent-outer')!
    .subMessages!.map(summarizeMessage));
  assert.ok(calls.every(call => call.direction === 'backward'));
  assert.ok(calls.reduce((sum, call) => sum + call.max!, 0) < 340);
});

test('backward-seeded refresh folds only new suffixes with canonical reasoning, tools and nested aliases', async () => {
  const initial = [...turns(500, 'old-'), ...background()];
  const { reader, append, calls, replace } = fixture(initial, { batchSize: 8 });
  await reader.read('s', undefined, 30, undefined, 'summary');
  await reader.readSubagent('s', 'outer');
  const extra = [
    ...turns(2, 'unrelated-'),
    event('assistant.reasoning', 'late-reason', { reasoningId: 'late-reason', content: 'Late thought' }, 'outer-agent'),
    event('assistant.message', 'late-tool', { messageId: 'late-tool', content: '', toolRequests: [
      { toolCallId: 'late-edit', name: 'edit', arguments: { path: 'file', old_str: 'a', new_str: 'b'.repeat(5000) } },
      { toolCallId: 'late-task', name: 'task', arguments: { prompt: 'Nested prompt' } },
    ] }, 'outer-agent'),
    event('tool.execution_complete', 'late-output', { toolCallId: 'late-edit', result: { content: 'output'.repeat(1000) } }),
    event('subagent.started', 'late-start', { toolCallId: 'late-task', parentId: 'outer-agent' }, 'late-native'),
    event('assistant.message', 'late-answer', { messageId: 'late-answer', content: 'Nested answer' }, 'late-native'),
    event('subagent.completed', 'late-complete', { toolCallId: 'late-task', totalToolCalls: 2 }, 'late-native'),
  ];
  append(extra);
  calls.length = 0;
  const refresh = await reader.readSubagent('s', 'outer', undefined, 30, 'child-answer');
  const expected = replay([...initial, ...extra]).find(message => message.id === 'subagent-outer')!.subMessages!;
  const anchor = expected.findIndex(message => message.id === 'child-answer');
  assert.equal(refresh.append, true);
  assert.deepEqual(refresh.messages, expected.slice(anchor).map(summarizeMessage));
  assert.ok(calls.every(call => call.direction === 'backward'));
  assert.ok(calls.length <= 4);
  // The last native event disappears while older native checkpoints survive.
  replace([...initial, ...extra.slice(0, -1)], false);
  const reset = await reader.readSubagent('s', 'outer', undefined, 30, 'child-answer');
  assert.equal(reset.latest, true);
  assert.equal(reset.messages.at(-1)?.subagent?.status, 'running');
});

test('tool outputs, real ask replies and marker attachments survive page boundaries and cloning', async () => {
  const events = [
    event('user.message', 'upload', { content: '<cockpit-attachment kind="image" name="a%20b.png" url="/uploads/test.png"/>\nhidden guidance' }),
    event('assistant.message', 'ask-event', {
      messageId: 'ask', content: 'Question', toolRequests: [{ toolCallId: 'ask-tool', name: 'ask_user', arguments: { question: 'Pick?' } }],
    }),
    event('tool.execution_complete', 'reply-event', { toolCallId: 'ask-tool', success: true, result: { content: 'User selected: Yes' } }),
    event('assistant.message', 'attachment-event', {
      messageId: 'attachment', content: 'Result <cockpit-attachment kind="file" name="x.txt" url="/uploads/x.txt"/>',
    }),
    ...turns(3, 'later-'),
  ];
  const { reader } = fixture(events, { batchSize: 1 });
  const page = await reader.read('s', 'later-u0', 4);
  assert.deepEqual(page.messages, replay(events).slice(0, 4));
  assert.equal(page.messages[0]?.attachment?.name, 'a b.png');
  assert.equal(page.messages[2]?.id, 'reply-ask-tool');
  assert.equal(page.messages[2]?.content, 'Yes');
  page.messages[0]!.attachment!.name = 'poison';
  assert.equal((await reader.read('s', 'later-u0', 4)).messages[0]?.attachment?.name, 'a b.png');
});

test('late carried ask replies are not cursors into a window with intervening root turns removed', async () => {
  const events = [
    event('user.message', 'first', { content: 'First' }),
    event('assistant.message', 'request-event', {
      messageId: 'request', content: 'Pick', toolRequests: [{ toolCallId: 'ask', name: 'ask_user', arguments: {} }],
    }),
    ...turns(3),
    event('tool.execution_complete', 'reply', { toolCallId: 'ask', success: true, result: { content: 'User responded: yes' } }),
    event('assistant.message', 'end', { messageId: 'end-answer', content: 'Done' }),
  ];
  const { reader } = fixture(events, { batchSize: 2 });
  await reader.read('s');
  await reader.read('s', 'request', 1);
  const page = await reader.read('s', 'reply-ask', 3);
  const expected = replay(events);
  assert.deepEqual(page.messages, expected.slice(expected.findIndex(m => m.id === 'reply-ask') - 3, -2));
});

test('standalone native ask start/completion needs only its own bounded turn', async () => {
  const events = [
    ...turns(500),
    event('user.message', 'last-user', { content: 'Question' }),
    event('tool.execution_start', 'ask-start', { toolCallId: 'ask', toolName: 'ask_user', arguments: {} }),
    event('tool.execution_complete', 'ask-end', { toolCallId: 'ask', success: true, result: { content: 'User selected: yes' } }),
  ];
  const { reader, calls } = fixture(events, { batchSize: 3, maxEvents: 20 });
  const page = await reader.read('s', undefined, 1);
  assert.deepEqual(ids(page), ['reply-ask']);
  assert.ok(calls.length <= 3);
});

function standaloneTools(count: number, turnMetadata?: 'start' | 'complete'): SessionEvent[] {
  return Array.from({ length: count }, (_, i) => [
    event('user.message', `u${i}`, { content: `Question ${i}` }),
    ...(turnMetadata ? [event('assistant.turn_start', `turn${i}`, { turnId: `loop${i}` })] : []),
    event('tool.execution_start', `start${i}`, {
      toolCallId: `tool${i}`, toolName: 'ask_user', arguments: {},
      ...(turnMetadata === 'start' ? { turnId: `loop${i}` } : {}),
    }),
    event('tool.execution_complete', `end${i}`, {
      toolCallId: `tool${i}`, success: true, result: { content: 'User selected: Yes' },
      ...(turnMetadata === 'complete' ? { turnId: `loop${i}` } : {}),
    }),
    event('assistant.message', `event${i}`, { messageId: `a${i}`, content: 'Done' }),
  ]).flat();
}

for (const turnMetadata of ['start', 'complete'] as const) {
  test(`standalone tools roll out using native ${turnMetadata} turn ownership without requests`, async () => {
    const events = standaloneTools(80, turnMetadata);
    const { reader } = fixture(events, { batchSize: 8, maxEvents: 40 });
    let page = await reader.read('s', undefined, 3);
    let collected = page.messages;
    while (page.hasMore) {
      page = await reader.read('s', page.messages[0]!.id, 3);
      assert.equal(page.latest, undefined);
      assert.ok(page.messages.length);
      collected = [...page.messages, ...collected];
      const cached = deserialize(checkCache(reader).cache.get('s')!.data) as { events: SessionEvent[] };
      assert.ok(cached.events.length < 25);
    }
    assert.deepEqual(collected, replay(events));
  });
}

test('tools without ownership metadata remain readable beyond work targets without silently evicting updates', async () => {
  const events = standaloneTools(80);
  for (const options of [{ maxEvents: 40 }, { maxEvents: 200, maxReadBytes: 8000 }]) {
    const { reader } = fixture(events, { batchSize: 8, ...options });
    let page = await reader.read('s', undefined, 3);
    let collected = page.messages;
    while (page.hasMore) {
      page = await reader.read('s', page.messages[0]!.id, 3);
      assert.equal(page.latest, undefined);
      assert.ok(page.messages.length);
      collected = [...page.messages, ...collected];
      checkCache(reader);
    }
    assert.deepEqual(collected, replay(events));
  }
});

test('a tool requested in a retained turn keeps its later start and completion', async () => {
  const events = [
    event('user.message', 'u0', { content: 'First' }),
    event('assistant.message', 'request-event', {
      messageId: 'request', content: 'Reading', toolRequests: [{ toolCallId: 'read', name: 'view', arguments: { path: 'synthetic' } }],
    }),
    event('assistant.message', 'first-event', { messageId: 'first-answer', content: 'First answer' }),
    event('user.message', 'u1', { content: 'Second' }),
    event('tool.execution_start', 'start', { toolCallId: 'read', toolName: 'view', arguments: { path: 'synthetic' } }),
    event('tool.execution_complete', 'end', { toolCallId: 'read', success: true, result: { content: 'Read output' } }),
    event('assistant.message', 'second-event', { messageId: 'second-answer', content: 'Second answer' }),
  ];
  const { reader } = fixture(events, { batchSize: 2 });
  await reader.read('s');
  const page = await reader.read('s', 'first-answer', 2);
  assert.deepEqual(page.messages, replay(events).slice(0, 2));
  assert.equal(page.messages[1]?.toolCalls?.[0]?.output, 'Read output');
});

for (const turnMetadata of [false, true]) {
  test(`delayed tools keep unfetched request owners across default-batch paging (turn metadata ${turnMetadata})`, async () => {
    const events = [
      event('user.message', 'first-user', { content: 'Read a file' }),
      event('assistant.turn_start', 'first-turn', { turnId: 'first-loop' }),
      event('assistant.message', 'request-event', {
        messageId: 'request', content: 'Reading',
        toolRequests: [{ toolCallId: 'read', name: 'view', arguments: { path: 'synthetic' } }],
      }),
      ...turns(240, 'middle-'),
      event('user.message', 'late-user', { content: 'Another question' }),
      event('assistant.turn_start', 'late-turn', { turnId: 'late-loop' }),
      event('assistant.message', 'late-task-request', {
        messageId: 'late-task', content: '',
        toolRequests: [{ toolCallId: 'late-tool', name: 'task', arguments: {} }],
      }),
      event('subagent.started', 'late-agent-start', { toolCallId: 'late-tool' }, 'late-agent'),
      // Agent loop IDs can collide with a still-unfetched root turn.
      event('assistant.turn_start', 'late-agent-turn', { turnId: 'first-loop' }, 'late-agent'),
      event('subagent.completed', 'late-agent-end', { toolCallId: 'late-tool' }, 'late-agent'),
      {
        ...event('tool.execution_start', 'delayed-start', {
          toolCallId: 'read', toolName: 'view', arguments: { path: 'synthetic' },
          ...(turnMetadata ? { turnId: 'first-loop' } : {}),
        }),
        parentId: 'late-turn',
      },
      event('tool.execution_complete', 'delayed-end', {
        toolCallId: 'read', success: true, result: { content: 'Delayed read output' },
        ...(turnMetadata ? { turnId: 'first-loop' } : {}),
      }),
      event('assistant.message', 'late-answer-event', { messageId: 'late-answer', content: 'Done' }),
      ...turns(80, 'tail-'),
    ];
    const { reader, calls } = fixture(events, { batchSize: 200 });
    let page = await reader.read('s');
    let collected = page.messages;
    let checkedUnfetchedOwner = false;
    while (page.hasMore) {
      page = await reader.read('s', page.messages[0]!.id);
      assert.equal(page.latest, undefined);
      assert.ok(page.messages.length);
      collected = [...page.messages, ...collected];
      const cached = deserialize(checkCache(reader).cache.get('s')!.data) as {
        events: SessionEvent[]; prefixLength: number;
      };
      if (!cached.events.some(e => e.id === 'request-event')
        && cached.events.slice(cached.prefixLength).some(e => e.id === 'delayed-start')) {
        assert.ok(cached.events.slice(cached.prefixLength).some(e => e.id === 'delayed-end'));
        checkedUnfetchedOwner = true;
      }
      assert.ok(cached.events.length < 300);
    }
    assert.equal(checkedUnfetchedOwner, true);
    assert.ok(calls.some(call => call.max === 200));
    assert.equal(collected.find(message => message.id === 'request')?.toolCalls?.[0]?.status, 'completed');
    assert.equal(collected.find(message => message.id === 'request')?.toolCalls?.[0]?.output, 'Delayed read output');
    assert.deepEqual(collected, replay(events));
  });
}

test('metadata uses a bounded passive head batch and native workingDirectory, never a full start scan', async () => {
  const events = [
    event('session.start', 'start', { context: { workingDirectory: '/synthetic/work' } }),
    event('user.message', 'skill', { source: 'skill-testing', content: 'Hidden context' }),
    ...turns(500),
  ];
  const { reader, calls } = fixture(events, { batchSize: 8 });
  const page = await reader.readWithMetadata('session-id', undefined, 3);
  assert.equal(page.cwd, '/synthetic/work');
  assert.equal(page.title, 'Question 0');
  assert.equal(calls.filter((call) => call.direction === 'forward').length, 1);
  assert.ok(calls.length < 6);
  calls.length = 0;
  assert.deepEqual(await reader.readWithMetadata('session-id', undefined, 3), page);
  assert.ok(calls.every((call) => call.direction === 'backward'));
});

test('metadata title changes and attachment labels fold without scanning for unseen historical titles', async () => {
  const { reader } = fixture([
    event('session.start', 'start', { context: { cwd: '/synthetic/old' } }),
    event('user.message', 'upload', { content: '<cockpit-attachment name="report.pdf" kind="file" url="/uploads/report.pdf"/>' }),
    event('session.title_changed', 'title', { title: 'Named session\nignored' }),
  ]);
  const page = await reader.readWithMetadata('s');
  assert.equal(page.cwd, '/synthetic/old');
  assert.equal(page.title, 'Named session');
  const upload = fixture([event('user.message', 'upload', { content: '<cockpit-attachment name="report.pdf" kind="file" url="/uploads/report.pdf"/>' })]);
  assert.equal((await upload.reader.readWithMetadata('s')).title, 'report.pdf');
});

test('empty persisted sessions return an empty latest page; native not-found is not masked or resumed', async () => {
  assert.deepEqual(await fixture([]).reader.read('fresh'), { sessionId: 'fresh', messages: [], hasMore: false, latest: true });
  const missing = new Error('not_found');
  const reader = new SessionHistoryReader({ readPersistedEvents: async () => { throw missing; } });
  await assert.rejects(reader.readWithMetadata('fresh'), error => error === missing);
});

test('append refreshes the latest window and includes an updated reconnect anchor', async () => {
  const source = fixture(turns(3), { batchSize: 2 });
  await source.reader.read('s');
  source.append(turns(1, 'new-'));
  const after = await source.reader.read('s', undefined, 3, 'a2');
  assert.deepEqual(ids(after), ['a2', 'new-u0', 'new-a0']);
  assert.equal(after.append, true);
});

test('expired cached cursors reset before and after pages, including identical final event envelopes', async () => {
  for (const mode of ['before', 'after', 'latest']) {
    const idle = event('session.idle', 'unchanged-idle');
    const source = fixture([...turns(7), idle], { batchSize: 3 });
    await source.reader.read('s', undefined, 4);
    source.replace([...turns(2, 'replacement-'), idle]);
    const page = await source.reader.read('s', mode === 'before' ? 'u6' : undefined, 4, mode === 'after' ? 'u6' : undefined);
    assert.equal(page.latest, true);
    assert.equal(page.append, undefined);
    assert.deepEqual(page.messages, replay(turns(2, 'replacement-')));
  }
});

test('expiration during pagination discards accumulated folds instead of overlapping replacement history', async () => {
  const source = fixture(turns(20), { batchSize: 2 });
  let calls = 0;
  const reader = new SessionHistoryReader({
    batchSize: 2,
    readPersistedEvents: async params => {
      if (++calls === 3) source.replace(turns(3, 'new-'));
      return source.readPersistedEvents(params);
    },
  });
  const page = await reader.read('s', 'u0', 3);
  assert.equal(page.latest, true);
  assert.deepEqual(page.messages, replay(turns(3, 'new-')).slice(-3));
});

test('expiration beyond a work target can never return or retain a deleted fallback', async () => {
  const source = fixture(turns(20), { batchSize: 2 });
  let calls = 0;
  const reader = new SessionHistoryReader({
    batchSize: 2, maxEvents: 5,
    readPersistedEvents: async params => {
      if (++calls === 3) source.replace(turns(2, 'new-'));
      return source.readPersistedEvents(params);
    },
  });
  assert.deepEqual((await reader.read('s', 'missing', 1)).messages, replay(turns(2, 'new-')).slice(-1));
});

test('oversized expired responses invalidate fallback without rejecting valid messages', async () => {
  const source = fixture(turns(20), { batchSize: 2 });
  let calls = 0;
  const reader = new SessionHistoryReader({
    batchSize: 2, maxReadBytes: 2000,
    readPersistedEvents: async params => {
      if (++calls === 3) source.replace([
        event('user.message', 'new-user', { content: 'x'.repeat(3000) }),
        event('assistant.message', 'new-event', { messageId: 'new-answer', content: 'y'.repeat(3000) }),
      ]);
      return source.readPersistedEvents(params);
    },
  });
  const page = await reader.read('s', 'missing', 1);
  assert.equal(page.messages[0]?.id, 'new-answer');
  assert.equal(page.messages[0]?.content.length, 3000);
});

test('clear is authoritative for rewrites that preserve native cursor identities', async () => {
  const source = fixture(turns(3));
  await source.reader.read('s');
  const rewritten = turns(3);
  rewritten[0] = event('user.message', 'u0', { content: 'Rewritten' });
  source.replace(rewritten, false);
  source.reader.clear('s');
  assert.equal((await source.reader.read('s')).messages[0]?.content, 'Rewritten');
});

test('long turns and individually large messages remain readable across bounded native batches', async () => {
  const source = fixture([
    event('user.message', 'u', { content: 'one turn' }),
    ...Array.from({ length: 50 }, (_, i) => event('session.info', `info${i}`, { message: 'non-chat' })),
    event('assistant.message', 'answer', { messageId: 'a', content: 'Answer' }),
  ], { batchSize: 4, maxEvents: 12 });
  assert.deepEqual(ids(await source.reader.read('s', undefined, 1)), ['a']);
  assert.ok(source.calls.every(call => call.max! <= 4));
  const huge = fixture([event('user.message', 'u', { content: 'x'.repeat(5000) })], { maxReadBytes: 1000 });
  assert.equal((await huge.reader.read('s')).messages[0]?.content.length, 5000);
  checkCache(huge.reader);
});

test('a nonadvancing native cursor fails instead of looping', async () => {
  const reader = new SessionHistoryReader({
    readPersistedEvents: async () => ({ events: [], cursor: 'stuck', hasMore: true, cursorStatus: 'ok' }),
  });
  await assert.rejects(reader.read('s'), /did not advance/);
});

test('cache LRU entries, exact serialized bytes and recursive messages stay bounded', async () => {
  const { reader } = fixture(background(), { maxEntries: 2, maxMessages: 30 });
  await reader.read('one');
  await reader.read('two');
  await reader.read('one');
  await reader.read('three');
  const state = checkCache(reader, 2, undefined, 30);
  assert.deepEqual([...state.cache.keys()], ['one', 'three']);
  assert.ok([...state.cache.values()].every((entry) => entry.messages > 5));
  reader.clear('one');
  checkCache(reader, 1);
  reader.clear('one');
  reader.clear('three');
  assert.equal(checkCache(reader, 0).cachedBytes, 0);
  for (const options of [{ maxBytes: 1 }, { maxMessages: 2 }, { maxEntries: 0 }, { maxMessages: 0 }, { maxBytes: 0 }]) {
    const source = fixture(background(), options);
    assert.deepEqual((await source.reader.read('s')).messages, replay(background()));
    assert.equal(checkCache(source.reader).cache.size, 0);
  }
});

test('clear invalidates concurrent reads without unbounded tombstones or shared mutable pages', async () => {
  const source = fixture(turns(3));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let pause = true;
  const reader = new SessionHistoryReader({
    readPersistedEvents: async params => {
      const result = await source.readPersistedEvents(params);
      if (pause) { pause = false; entered(); await blocked; }
      return result;
    },
  });
  const read = reader.read('s');
  await ready;
  reader.clear('s');
  release();
  await read;
  assert.equal(checkCache(reader).cache.size, 0);
  const pages = await Promise.all([reader.read('s'), reader.read('s')]);
  pages[0]!.messages[0]!.content = 'changed';
  assert.equal(pages[1]!.messages[0]!.content, 'Question 0');
  assert.equal(checkCache(reader).cache.size, 1);
});

test('page validation rejects invalid limits and anchors before invoking the RPC', async () => {
  const { reader, calls } = fixture([]);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 201]) await assert.rejects(reader.read('s', undefined, limit), /limit/);
  for (const anchor of ['', null, 42] as string[]) {
    await assert.rejects(reader.read('s', anchor), /anchor/);
    await assert.rejects(reader.read('s', undefined, 1, anchor), /anchor/);
  }
  await assert.rejects(reader.read('s', 'before', 1, 'after'), /mutually exclusive/);
  await assert.rejects(reader.read(''), /session ID/);
  assert.equal(calls.length, 0);
  assert.equal((await reader.read('s', undefined, MAX_HISTORY_LIMIT)).messages.length, 0);
  for (const key of ['maxEntries', 'maxBytes', 'maxMessages', 'maxEvents', 'maxReadBytes', 'batchSize']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new SessionHistoryReader({ readPersistedEvents: async () => { throw new Error(); }, [key]: value }), /budget/i);
    }
  }
  assert.throws(() => fixture([], { batchSize: 1001 }), /1000/);
  assert.throws(() => new SessionHistoryReader({} as HistoryReaderOptions), /passive/);
});

test('pageHistory retains synthetic active-fold paging compatibility', () => {
  const messages = replay(turns(2));
  assert.deepEqual(ids(pageHistory('s', messages, 'u1', 1)), ['a0']);
  assert.deepEqual(ids(pageHistory('s', messages, undefined, 2, 'a0')), ['a0', 'u1', 'a1']);
  assert.equal(pageHistory('s', messages, undefined, 1, 'a0').latest, true);
});
