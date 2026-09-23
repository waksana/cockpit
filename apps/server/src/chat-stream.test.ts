import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { NativeChatRead, type NativeChatPage, type NativeChatStreamEvent } from '@cockpit/protocol';
import { registerChatStream, writeChatStreamFrame } from './chat-stream.ts';

function page(cursor: string, extra: Partial<NativeChatPage> = {}): NativeChatPage {
  return {
    sessionId: 's', source: 'live', direction: 'forward', events: [],
    cursor, cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: 0 }, ...extra,
  };
}

function frames(text: string): NativeChatStreamEvent[] {
  return text.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
}

async function server(
  read: (query: NativeChatRead, signal?: AbortSignal) => Promise<NativeChatPage>,
  options: { maxStreams?: number; drainTimeoutMs?: number } = {},
) {
  const app = Fastify();
  registerChatStream(app, () => read, options);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = (body: unknown, signal = AbortSignal.timeout(5000)) => fetch(`${address}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  return { app, post };
}

test('HTTP stream preserves native pages, cursor filters, catchup/live phases and suppresses idle frames', async t => {
  const event = { id: 'event', type: 'assistant.message', data: { content: 'unchanged native payload' } };
  const pages = [
    page('c1', { hasMore: true, events: [event], read: { rpc: 1, events: 1 } }),
    page('c2'),
    page('c2'),
    page('c3', { hasMore: true }),
    page('c3', { events: [event], read: { rpc: 1, events: 1 } }),
    page('c3', { cursorStatus: 'expired' }),
  ];
  const calls: NativeChatRead[] = [];
  const { app, post } = await server(async (query, signal) => {
    assert.ok(signal instanceof AbortSignal);
    calls.push(query);
    assert.ok(calls.length <= pages.length, 'must stop after expired page');
    return pages[calls.length - 1]!;
  });
  t.after(() => app.close());
  const request = { sessionId: 's', cursor: 'initial', max: 2, agentScope: 'primary', agentIds: ['child'], types: ['assistant.message'] };
  const response = await post(request);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const text = await response.text();
  assert.deepEqual(frames(text), [pages[0], pages[1], pages[3], pages[4], pages[5]].map(page => ({ type: 'page', page })));
  assert.ok(text.includes(': keepalive\n\n'));
  assert.deepEqual(calls.map(query => query.cursor), ['initial', 'c1', 'c2', 'c2', 'c3', 'c3']);
  calls.forEach((query, index) => assert.deepEqual(query, {
    ...request, cursor: ['initial', 'c1', 'c2', 'c2', 'c3', 'c3'][index],
    source: 'live', direction: 'forward', bootstrap: false,
    waitMs: index < 2 ? 0 : 30_000, includeEphemeral: index >= 2,
  }));
});

test('HTTP stream emits the first empty page and maps only the initial explicit tail sentinel', async t => {
  const calls: NativeChatRead[] = [];
  const { app, post } = await server(async query => {
    calls.push(query);
    return page('tail', calls.length === 1 ? {} : { cursorStatus: 'expired' });
  });
  t.after(() => app.close());
  const text = await (await post({ sessionId: 's', cursor: '' })).text();
  assert.deepEqual(frames(text), [
    { type: 'page', page: page('tail') },
    { type: 'page', page: page('tail', { cursorStatus: 'expired' }) },
  ]);
  assert.equal(calls[0]!.cursor, undefined);
  assert.equal(calls[0]!.max, 64);
  assert.equal(calls[1]!.cursor, 'tail');
  assert.equal(calls[1]!.waitMs, 30_000);
});

test('HTTP stream sends structured native errors, with no retries or implicit rebasing', async t => {
  for (const thrown of [Object.assign(new Error('Session is unloaded'), { code: 'SESSION_UNLOADED' }), new Error('native failed')]) {
    let calls = 0;
    const { app, post } = await server(async () => { calls++; throw thrown; });
    t.after(() => app.close());
    const response = await post({ sessionId: 's', cursor: 'known' });
    const expected = {
      type: 'error', error: thrown.message,
      ...('code' in thrown ? { code: thrown.code } : {}),
    };
    assert.deepEqual(frames(await response.text()), [expected]);
    assert.equal(calls, 1);
  }
});

test('an empty native log may retain its explicit empty sentinel until the first event', async t => {
  let calls = 0;
  const { app, post } = await server(async query => {
    assert.equal(NativeChatRead.parse(query).cursor, undefined);
    calls++;
    return page('', calls === 3 ? { cursorStatus: 'expired' } : {});
  });
  t.after(() => app.close());
  const text = await (await post({ sessionId: 's', cursor: '' })).text();
  assert.equal(calls, 3);
  assert.deepEqual(frames(text).map(frame => frame.type === 'page' && frame.page.cursorStatus), ['ok', 'expired']);
});

test('HTTP stream delivers a single native message larger than the control SSE frame ceiling', async t => {
  const content = '🧪'.repeat(2_200_000);
  const large = page('large', {
    events: [{ id: 'large', type: 'assistant.message', data: { content } }],
    read: { rpc: 1, events: 1 },
  });
  let calls = 0;
  const { app, post } = await server(async () => {
    calls++;
    return calls === 1 ? large : page('large', { cursorStatus: 'expired' });
  });
  t.after(() => app.close());
  const response = await post({ sessionId: 's', cursor: 'before-large', max: 1 });
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) > 8 * 1024 * 1024);
  assert.deepEqual(frames(text), [
    { type: 'page', page: large },
    { type: 'page', page: page('large', { cursorStatus: 'expired' }) },
  ]);
  assert.equal(calls, 2);
});

test('invalid initial requests are rejected before any native read', async t => {
  let reads = 0;
  const { app } = await server(async () => { reads++; return page('unexpected'); });
  t.after(() => app.close());
  for (const body of [
    {}, { sessionId: 's' }, { sessionId: 's', cursor: null },
    { sessionId: 's', cursor: 'c', max: 65 }, { sessionId: 's', cursor: 'c', max: 0 },
    { sessionId: '../s', cursor: 'c' }, { sessionId: 's', cursor: 'c', source: 'persisted' },
    { sessionId: 's', cursor: 'c', direction: 'backward' }, { sessionId: 's', cursor: 'c', waitMs: 100 },
    { sessionId: 's', cursor: 'c', agentIds: [] },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/chat/stream', payload: body });
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(reads, 0);
});

test('disconnect aborts only its read, reserves its pending slot, and never continues after completion', async t => {
  let calls = 0;
  const started = Promise.withResolvers<AbortSignal>();
  const pending = Promise.withResolvers<NativeChatPage>();
  const { app, post } = await server(async (_query, signal) => {
    calls++;
    started.resolve(signal!);
    return pending.promise;
  }, { maxStreams: 1 });
  t.after(() => app.close());
  const client = new AbortController();
  const response = await post({ sessionId: 's', cursor: 'c' }, client.signal);
  const signal = await started.promise;
  const limited = await post({ sessionId: 's', cursor: 'c' });
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get('retry-after'), '5');
  await limited.text();
  const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  client.abort();
  await assert.rejects(response.text());
  await aborted;
  assert.equal(signal.aborted, true);
  const stillLimited = await post({ sessionId: 's', cursor: 'c' });
  assert.equal(stillLimited.status, 503, 'pending native reads remain counted after disconnect');
  await stillLimited.text();
  pending.resolve(page('next', { hasMore: true }));
  await nextTurn();
  assert.equal(calls, 1, 'no native read after disconnected pending RPC finishes');
});

test('app shutdown aborts streams without waiting for a non-cancellable native read', async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const pending = Promise.withResolvers<NativeChatPage>();
  let calls = 0;
  const { app, post } = await server(async (_query, signal) => {
    calls++;
    started.resolve(signal!);
    return pending.promise;
  });
  const response = await post({ sessionId: 's', cursor: 'c' });
  const body = response.text();
  const rejected = assert.rejects(body);
  const signal = await started.promise;
  try {
    await app.close();
    assert.equal(signal.aborted, true);
    await rejected;
  } finally {
    pending.resolve(page('next', { hasMore: true }));
    await nextTurn();
    await app.close();
  }
  assert.equal(calls, 1);
});

type TestStreamRaw = Parameters<typeof writeChatStreamFrame>[0];
type TestStreamReturn = ReturnType<TestStreamRaw['off']>;

class FakeRaw {
  private readonly events = new EventEmitter();
  destroyed = false;
  writableEnded = false;
  chunks: Buffer[] = [];
  writable = false;
  once(eventName: string | symbol, listener: (...args: unknown[]) => void): TestStreamReturn {
    this.events.once(eventName, listener);
    return this as unknown as TestStreamReturn;
  }
  off(eventName: string | symbol, listener: (...args: unknown[]) => void): TestStreamReturn {
    this.events.off(eventName, listener);
    return this as unknown as TestStreamReturn;
  }
  emit(eventName: string | symbol, ...args: unknown[]) {
    return this.events.emit(eventName, ...args);
  }
  listenerCount(eventName: string | symbol) {
    return this.events.listenerCount(eventName);
  }
  write(chunk: string): boolean {
    this.chunks.push(Buffer.from(chunk));
    return this.writable;
  }
  destroy(): TestStreamReturn {
    this.destroyed = true;
    this.emit('close');
    return this as unknown as TestStreamReturn;
  }
}

test('large frames use bounded chunks, preserve Unicode, and wait for drain before writing again', async () => {
  const raw = new FakeRaw();
  const frame = 'x'.repeat(16 * 1024 - 1) + '😀'.repeat(100_000);
  const writing = writeChatStreamFrame(raw, frame, new AbortController().signal);
  assert.equal(raw.chunks.length, 1);
  await nextTurn();
  assert.equal(raw.chunks.length, 1, 'no queued second chunk before drain');
  raw.writable = true;
  raw.emit('drain');
  await writing;
  assert.equal(Buffer.concat(raw.chunks).toString(), frame);
  assert.ok(raw.chunks.every(chunk => chunk.length <= 64 * 1024));
  assert.equal(raw.listenerCount('drain'), 0);
  assert.equal(raw.listenerCount('close'), 0);
  assert.equal(raw.listenerCount('error'), 0);
});

test('stalled and cancelled writes destroy transport and release drain listeners', async () => {
  const raw = new FakeRaw();
  const keepProcessAlive = delay(30);
  await assert.rejects(writeChatStreamFrame(raw, 'data: stalled\n\n', new AbortController().signal, 5), /stalled/);
  await keepProcessAlive;
  assert.equal(raw.destroyed, true);
  assert.equal(raw.chunks.length, 1);
  assert.equal(raw.listenerCount('drain'), 0);
  assert.equal(raw.listenerCount('close'), 0);
  assert.equal(raw.listenerCount('error'), 0);

  const cancelled = new FakeRaw();
  const controller = new AbortController();
  const writing = writeChatStreamFrame(cancelled, 'data: cancel\n\n', controller.signal);
  controller.abort();
  await assert.rejects(writing);
  assert.equal(cancelled.destroyed, true);
  assert.equal(cancelled.listenerCount('drain'), 0);
  assert.equal(cancelled.listenerCount('close'), 0);
  assert.equal(cancelled.listenerCount('error'), 0);
});

test('index registration uses lazy test engine and existing CSRF gate without snapshots or metadata reads', async () => {
  process.env.COCKPIT_NO_BOOT = '1';
  process.env.COCKPIT_SERVE_WEB = '0';
  process.env.LOG_LEVEL = 'silent';
  const { app, setTestDependencies } = await import('./index.ts');
  const reads: NativeChatRead[] = [];
  const engine = new Proxy({}, {
    get(_target, name) {
      if (name === 'chat') return async (query: NativeChatRead) => {
        reads.push(query);
        return page('end', { cursorStatus: 'expired' });
      };
      throw new Error(`stream must not access engine.${String(name)}`);
    },
  }) as Parameters<typeof setTestDependencies>[0]['engine'];
  setTestDependencies({ engine });
  try {
    const rejected = await app.inject({
      method: 'POST', url: '/chat/stream',
      headers: { origin: 'https://evil.example', host: 'cockpit.rbym47.com' },
      payload: { sessionId: 's', cursor: 'c' },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(reads.length, 0);
    const accepted = await app.inject({
      method: 'POST', url: '/chat/stream',
      payload: { sessionId: 's', cursor: 'c' },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(frames(accepted.body), [{ type: 'page', page: page('end', { cursorStatus: 'expired' }) }]);
    assert.equal(reads.length, 1);
  } finally { await app.close(); }
});
