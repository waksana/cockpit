import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { NativeChatPage, NativeChatStreamEvent } from '@cockpit/protocol';
import { CHAT_STREAM_URL } from '../lib/config';
import { consumeChatStream } from './chatStream';
import { IntentHttpError, isSessionUnloadedError, NetClient } from './client';

const page: NativeChatPage = {
  sessionId: 'session', source: 'live', direction: 'forward', events: [],
  cursor: 'advanced', cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: 0 },
};
const request = { sessionId: 'session', cursor: 'original', max: 2, agentScope: 'all' as const };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function response(text: string, splitBytes = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function client(t: TestContext) {
  const client = new NetClient({ onEvent() {}, onStateChange() {} });
  t.after(() => client.disconnect());
  return client;
}

test('chat SSE parses split UTF-8, CRLF, comments and multiple frames on one connection', async () => {
  const value: NativeChatStreamEvent = { type: 'page', page: {
    ...page, events: [{ id: 'message', type: 'assistant.message', data: { content: '实时消息' } }],
    read: { rpc: 1, events: 1 },
  } };
  const input = response(`: heartbeat\r\n\r\ndata: {"type":"page",\r\ndata: "page":${JSON.stringify(page)}}\r\n\r\n${frame(value)}`, true);
  const received: NativeChatStreamEvent[] = [];
  await assert.rejects(consumeChatStream(input, value => received.push(value)), TypeError);
  assert.deepEqual(received, [{ type: 'page', page }, value]);
  assert.equal(input.body?.locked, false);
});

test('a truncated frame cannot advance the applied cursor and clean EOF requests incremental reconnect', async () => {
  const received: NativeChatStreamEvent[] = [];
  await assert.rejects(consumeChatStream(response(
    frame({ type: 'page', page }) + `data: ${JSON.stringify({ type: 'page', page: { ...page, cursor: 'not-delivered' } })}`,
  ), value => received.push(value)), TypeError);
  assert.deepEqual(received, [{ type: 'page', page }]);
});

test('malformed SSE data and non-SSE responses fail explicitly instead of reconnecting as transport loss', async () => {
  for (const input of [
    Response.json({ page }),
    response('data: not-json\n\n'),
    response(frame({ type: 'page', page: { ...page, cursorStatus: 'guessed' } })),
  ]) {
    await assert.rejects(consumeChatStream(input, () => assert.fail('invalid page delivered')),
      error => error instanceof Error && !(error instanceof TypeError));
  }
});

test('chat stream transports its original all-agent cursor once and applies multiple pages without HTTP rereads', async t => {
  let streamSignal: AbortSignal | null | undefined;
  const fetch = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, CHAT_STREAM_URL);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'include');
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    streamSignal = init?.signal;
    return response(frame({ type: 'page', page }) + frame({ type: 'page', page: { ...page, cursor: 'second' } }));
  });
  const received: NativeChatPage[] = [];
  await assert.rejects(client(t).chatStream(request, value => received.push(value), new AbortController().signal), TypeError);
  assert.deepEqual(received.map(value => value.cursor), ['advanced', 'second']);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(streamSignal?.aborted, true);
});

test('view cancellation closes only its HTTP stream without a native cancel or follow-up request', async t => {
  let streamSignal: AbortSignal | null | undefined;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    streamSignal = init?.signal;
    return new Response(new ReadableStream({
      start(controller) {
        streamSignal?.addEventListener('abort', () => controller.error(new DOMException('Closed view', 'AbortError')), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const controller = new AbortController();
  const pending = client(t).chatStream(request, () => assert.fail('cancelled stream delivered content'), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(streamSignal?.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
});

for (const invalid of [
  { ...page, sessionId: 'other' },
  { ...page, source: 'persisted' },
  { ...page, direction: 'backward' },
  { ...page, events: Array.from({ length: 3 }, (_, index) => ({ id: String(index), type: 'user.message', data: {} })) },
]) {
  test(`chat stream rejects an out-of-scope page: ${JSON.stringify(invalid)}`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response(frame({ type: 'page', page: invalid })));
    await assert.rejects(client(t).chatStream(request, () => assert.fail('wrong page delivered'), new AbortController().signal),
      error => error instanceof Error && !(error instanceof TypeError));
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('SSE unload and HTTP failures remain explicit; only gateway unavailability is a reconnectable transport failure', async t => {
  const replies = [
    response(frame({ type: 'error', error: 'Unloaded', code: 'SESSION_UNLOADED' })),
    response(frame({ type: 'error', error: 'Gone', code: 'SESSION_NOT_FOUND' })),
    response(frame({ type: 'error', error: 'Native failure' })),
    Response.json({ error: 'Unauthorized' }, { status: 401 }),
    new Response('Unavailable', { status: 503 }),
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async () => replies.shift()!);
  const net = client(t);
  const read = () => net.chatStream(request, () => assert.fail('error delivered as content'), new AbortController().signal);
  await assert.rejects(read(), isSessionUnloadedError);
  await assert.rejects(read(), error => error instanceof IntentHttpError && error.status === 404 && error.code === 'SESSION_NOT_FOUND');
  await assert.rejects(read(), error => error instanceof IntentHttpError && error.status === 500 && error.code === undefined);
  await assert.rejects(read(), error => error instanceof IntentHttpError && error.status === 401);
  await assert.rejects(read(), TypeError);
  assert.equal(fetch.mock.callCount(), 5);
});
