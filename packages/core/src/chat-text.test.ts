import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ChatTextRead, type NativeChatEvent, type NativeChatRead, type NativeChatPage } from '@cockpit/protocol';
import { readChatText } from './chat-text.ts';
import { harness, assistant, user } from '../test-support/engine-harness.ts';

const q = (extra: Record<string, unknown> = {}) => ChatTextRead.parse({ sessionId: 'fixture', ...extra });
const event = (id: string, content = id): NativeChatEvent => ({
  id, type: 'assistant.message', timestamp: '2026-10-02T00:00:00Z', data: { messageId: `msg-${id}`, content },
});

function fixture(events: NativeChatEvent[]) {
  const calls: NativeChatRead[] = [];
  const read = async (query: NativeChatRead): Promise<NativeChatPage> => {
    calls.push(query);
    const boundary = query.cursor ? Number(query.cursor) : query.direction === 'backward' ? events.length : 0;
    const start = query.direction === 'backward' ? Math.max(0, boundary - query.max) : boundary;
    const end = query.direction === 'backward' ? boundary : Math.min(events.length, start + query.max);
    return {
      sessionId: query.sessionId, source: query.source, direction: query.direction,
      events: events.slice(start, end), cursor: String(query.direction === 'backward' ? start : end),
      hasMore: query.direction === 'backward' ? start > 0 : end < events.length, cursorStatus: 'ok',
      ...(query.bootstrap ? { liveCursor: String(events.length) } : {}),
      read: { rpc: query.bootstrap ? 2 : 1, events: end - start },
    };
  };
  return { calls, read };
}

test('text projection excludes noise, children, reasoning and payloads but retains body beside tools', async () => {
  const { read } = fixture([
    { ...event('user'), type: 'user.message' },
    { ...event('noise'), type: 'tool.execution_complete' },
    { ...event('child'), agentId: 'child' },
    { ...event('parent-tool'), parentToolCallId: 'child' },
    { ...event('legacy'), data: { content: 'private', agentId: 'legacy-agent' } },
    { ...event('legacy-tool'), data: { content: 'private', parentToolCallId: 'legacy-tool' } },
    { ...event('ephemeral'), ephemeral: true },
    event('empty', ' \n'), event('tools-only', ''),
    { ...event('body'), data: { content: 'body', reasoningText: 'secret', encryptedContent: 'secret',
      toolRequests: [{ arguments: 'secret' }], attachments: [
        { type: 'file', path: '/synthetic/file', displayName: 'label', data: 'secret' },
        { type: 'blob', data: 'secret', mimeType: 'image/png', displayName: 'x'.repeat(100_000) },
        {}, {}, {}, {},
      ] } },
  ]);
  const page = await readChatText(q(), read);
  assert.deepEqual(page.messages.map(item => item.eventId), ['body', 'user']);
  assert.equal(page.messages[1]!.role, 'user');
  assert.equal(page.messages[0]!.attachments[0]!.path, '/synthetic/file');
  assert.equal(page.messages[0]!.attachments[1]!.omittedFields, true);
  assert.equal(page.messages[0]!.omittedAttachments, 2);
  assert.doesNotMatch(JSON.stringify(page), /secret|encryptedContent|toolRequests|reasoningText/);
});

test('checkpoint incremental range preserves multi-page fragments, filtered empty pages and concurrent append', async () => {
  const events = [event('old')];
  const { read } = fixture(events);
  const first = await readChatText(q(), read);
  assert.ok(first.checkpoint);
  const since = first.checkpoint;
  const additions = Array.from({ length: 35 }, (_, i) => event(`new-${i}`, i === 0 ? '中文😀'.repeat(9000) : `new-${i}`));
  events.push(...additions, ...Array.from({ length: 20 }, (_, i) => ({
    ...event(`noise-${i}`), type: 'tool.execution_complete',
  })));
  let cursor: string | undefined;
  let checkpoint: string | undefined;
  const bodies = new Map<string, string>();
  let emptyLimited = false;
  for (let i = 0; i < 100; i++) {
    const page = await readChatText(q({ since, cursor, max: 2, scanPages: 1, maxBytes: 8192 }), read);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    if (!page.messages.length && page.scanLimited) emptyLimited = true;
    for (const item of page.messages) {
      const previous = bodies.get(item.eventId) ?? '';
      assert.equal(previous.length, item.offset);
      bodies.set(item.eventId, previous + item.content);
    }
    if (i === 0) events.push(event('concurrent'));
    if (page.checkpoint) {
      assert.equal(page.hasMore, false);
      checkpoint = page.checkpoint;
      break;
    }
    assert.equal(page.hasMore, true);
    cursor = page.cursor;
  }
  assert.ok(checkpoint);
  assert.equal(emptyLimited, true);
  assert.equal(bodies.size, additions.length);
  for (const item of additions) assert.equal(bodies.get(item.id), item.data.content);
  const next = await readChatText(q({ since: checkpoint }), read);
  assert.deepEqual(next.messages.map(item => item.eventId), ['concurrent']);
  assert.ok(next.checkpoint);
  assert.equal((await readChatText(q({ since: next.checkpoint }), read)).messages.length, 0);
});

test('missing/modified checkpoints and wrong token kinds reject without pretending an empty increment', async () => {
  const events = [event('old')];
  const { read } = fixture(events);
  const first = await readChatText(q(), read);
  const since = first.checkpoint;
  assert.ok(since);
  await assert.rejects(readChatText(q({ cursor: since }), read), /checkpoint as since/);
  await assert.rejects(readChatText(q({ since: first.cursor }), read), /checkpoint as since/);
  events[0]!.data.content = 'modified';
  await assert.rejects(readChatText(q({ since }), read), /CHECKPOINT_CHANGED/);
  events.length = 0;
  await assert.rejects(readChatText(q({ since }), read), /CHECKPOINT_MISSING/);
});

test('empty-session checkpoints read subsequent events and never interpret IDs as native cursors', async () => {
  const events: NativeChatEvent[] = [];
  const { read } = fixture(events);
  const first = await readChatText(q(), read);
  assert.ok(first.checkpoint);
  events.push(event('first'));
  const next = await readChatText(q({ since: first.checkpoint }), read);
  assert.deepEqual(next.messages.map(item => item.eventId), ['first']);
  assert.ok(next.checkpoint);
  await assert.rejects(readChatText(q({ since: 'first' }), read), /POSITION_FORMAT/);
});

const unpack = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.slice(4), 'base64url').toString());
const pack = (position: Record<string, unknown>) => `ct2.${Buffer.from(JSON.stringify(position)).toString('base64url')}`;
function legacyToken(token: string, since?: string): string {
  const { format: _format, ...old } = unpack(token);
  old.query = createHash('sha256').update(JSON.stringify(['text-v1-primary', 'fixture', 'persisted', 'backward', since])).digest('hex');
  return `${Buffer.from(JSON.stringify(old)).toString('base64url')}.${'x'.repeat(43)}`;
}

test('portable caller positions reject malformed shapes before reads and invalid native offsets after one bounded read', async () => {
  const { read, calls } = fixture([event('unicode', '😀'.repeat(10_000))]);
  const first = await readChatText(q({ maxBytes: 8192 }), read);
  const position = unpack(first.cursor);
  for (const cursor of ['ct2.@@', 'ct3.abc', 'ct2.e30', 'ct2.ew']) {
    await assert.rejects(readChatText(q({ cursor }), read), /CURSOR_INVALID|POSITION_FORMAT/);
  }
  for (const changed of [
    { format: 3 }, { index: -1 }, { index: 17 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { native: 'x'.repeat(16385) }, { arbitraryPath: '/etc/passwd' }, { version: undefined },
    { until: null }, { head: { id: 'x', version: 'not-a-digest' } },
  ]) {
    await assert.rejects(readChatText(q({ cursor: pack({ ...position, ...changed }) }), read), /CURSOR_INVALID/);
  }
  assert.equal(calls.length, 1);
  for (const changed of [{ offset: 1 }, { offset: 20000 }, { index: 2, offset: 0 }]) {
    await assert.rejects(readChatText(q({ cursor: pack({ ...position, ...changed }) }), read), /CURSOR_INVALID/);
  }
  assert.equal(calls.length, 4);
});

test('legacy v1 checkpoint imports only caller-owned coordinates and upgrades after native validation', async () => {
  const events = [event('old')];
  const { read } = fixture(events);
  const first = await readChatText(q(), read);
  assert.ok(first.checkpoint);
  const legacy = legacyToken(first.checkpoint);
  events.push(event('new'));
  const page = await readChatText(q({ since: legacy }), read);
  assert.deepEqual(page.messages.map(item => item.eventId), ['new']);
  assert.ok(page.checkpoint?.startsWith('ct2.'));
  events[0]!.data.content = 'changed';
  await assert.rejects(readChatText(q({ since: legacy }), read), /CHECKPOINT_CHANGED/);
});

test('legacy partial cursor resumes its original legacy since range and emits portable continuation', async () => {
  const events = [event('old')];
  const { read } = fixture(events);
  const baseline = await readChatText(q(), read);
  assert.ok(baseline.checkpoint);
  const since = legacyToken(baseline.checkpoint);
  const content = '中文😀'.repeat(5000);
  events.push(event('new', content));
  const first = await readChatText(q({ since, maxBytes: 8192 }), read);
  let cursor = legacyToken(first.cursor, since);
  let body = first.messages[0]!.content;
  for (let i = 0; i < 30; i++) {
    const page = await readChatText(q({ since, cursor, maxBytes: 8192 }), read);
    assert.ok(page.cursor.startsWith('ct2.'));
    for (const item of page.messages) {
      assert.equal(item.offset, body.length);
      body += item.content;
    }
    if (page.checkpoint) {
      assert.ok(page.checkpoint.startsWith('ct2.'));
      break;
    }
    cursor = page.cursor;
  }
  assert.equal(body, content);
});

test('expired native partial continuation explicitly recovers the original since range within budgets', async () => {
  const events = [event('old')];
  const { read } = fixture(events);
  const baseline = await readChatText(q(), read);
  events.push(...Array.from({ length: 35 }, (_, i) => event(`new-${i}`)));
  const first = await readChatText(q({ since: baseline.checkpoint, scanPages: 1 }), read);
  await assert.rejects(readChatText(q({ since: baseline.checkpoint, cursor: first.cursor }),
    async query => ({ ...await read(query), cursorStatus: 'expired' })), /original since without cursor/);
  let cursor: string | undefined;
  const delivered = new Set(first.messages.map(item => item.eventId));
  for (let i = 0; i < 10; i++) {
    const page = await readChatText(q({ since: baseline.checkpoint, cursor, scanPages: 1 }), read);
    assert.ok(page.read.pages <= 1);
    page.messages.forEach(item => delivered.add(item.eventId));
    if (page.checkpoint) break;
    cursor = page.cursor;
  }
  assert.equal(delivered.size, 35);
});

for (const direction of ['forward', 'backward'] as const) {
  test(`${direction}: UTF-8 byte cuts preserve every message and surrogate pair with stable offsets`, async () => {
    const events = Array.from({ length: 35 }, (_, index) => event(String(index), index % 3
      ? `text ${index}` : `${index}:` + '中文😀"\\\n'.repeat(4000)));
    const { read, calls } = fixture(events);
    const texts = new Map<string, string>();
    const order: string[] = [];
    let cursor: string | undefined;
    for (let count = 0; count < 300; count++) {
      const page = await readChatText(q({ direction, cursor, maxBytes: 8192, max: 3, scanPages: 2 }), read);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
      assert.ok(page.read.pages <= 2);
      assert.ok(page.read.events <= 32);
      assert.ok(page.messages.length <= 3);
      for (const item of page.messages) {
        if (!texts.has(item.eventId)) order.push(item.eventId);
        const previous = texts.get(item.eventId) ?? '';
        assert.equal(item.offset, previous.length);
        assert.equal(item.content.isWellFormed(), true);
        texts.set(item.eventId, previous + item.content);
        if (item.nextOffset === null) assert.equal(texts.get(item.eventId)!.length, item.totalCharacters);
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
      assert.ok(count < 299, 'continuation must terminate');
    }
    assert.deepEqual(order, (direction === 'forward' ? events : [...events].reverse()).map(item => item.id));
    for (const item of events) assert.equal(texts.get(item.id), item.data.content);
    assert.ok(calls.every(call => call.max === 16));
  });
}

test('million-event noise is generated lazily and stops at the exact native scan budget', async () => {
  let calls = 0;
  const read = async (query: NativeChatRead): Promise<NativeChatPage> => {
    calls++;
    const end = query.cursor ? Number(query.cursor) : 1_000_000;
    return {
      sessionId: query.sessionId, source: query.source, direction: query.direction,
      events: Array.from({ length: 16 }, (_, i) => ({ ...event(String(end - i)), type: 'tool.execution_complete' })),
      cursor: String(end - 16), cursorStatus: 'ok', hasMore: true, read: { rpc: 1, events: 16 },
    };
  };
  const first = await readChatText(q({ scanPages: 3 }), read);
  assert.deepEqual(first.read, { rpc: 3, pages: 3, events: 48 });
  assert.equal(calls, 3);
  assert.equal(first.scanLimited, true);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.messages, []);
  const second = await readChatText(q({ cursor: first.cursor, scanPages: 1 }), read);
  assert.equal(calls, 4);
  assert.notEqual(second.cursor, first.cursor);
});

test('page-completion cursor growth participates in fragment sizing at the fixed byte budget', async () => {
  const content = 'x'.repeat(6600);
  const read = async (query: NativeChatRead): Promise<NativeChatPage> => ({
    sessionId: query.sessionId, source: query.source, direction: query.direction,
    events: [event('long', content)], cursor: 'n'.repeat(500),
    cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: 1 },
  });
  let cursor: string | undefined;
  let complete = '';
  for (let count = 0; count < 10; count++) {
    const page = await readChatText(q({ maxBytes: 8192, cursor }), read);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    for (const item of page.messages) {
      assert.equal(item.offset, complete.length);
      complete += item.content;
    }
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  assert.equal(complete, content);
});

test('partial-page tokens bind query, reject changes/tampering/expiry and never restart implicitly', async () => {
  const events = [event('a'), event('b'), event('c')];
  const { read, calls } = fixture(events);
  const first = await readChatText(q({ max: 1 }), read);
  for (const extra of [{ sessionId: 'other' }, { source: 'live' }, { direction: 'forward' }]) {
    await assert.rejects(readChatText(q({ ...extra, cursor: first.cursor }), read), /another/);
  }
  await assert.rejects(readChatText(q({ cursor: `${first.cursor}x` }), read), /CURSOR_INVALID/);
  assert.equal(calls.length, 1);
  events[1]!.data.content = 'changed';
  await assert.rejects(readChatText(q({ cursor: first.cursor }), read), /PAGE_CHANGED/);
  await assert.rejects(readChatText(q({ cursor: first.cursor }), async query =>
    ({ ...await read(query), cursorStatus: 'expired' })), /CURSOR_EXPIRED/);
  assert.equal(calls.length, 3);
});

test('live bootstrap uses primary body filters and an independently bound forward cursor', async () => {
  const events = [event('a')];
  const { read, calls } = fixture(events);
  const first = await readChatText(q({ source: 'live', bootstrap: true }), read);
  assert.ok(first.liveCursor);
  assert.deepEqual(first.read, { rpc: 2, pages: 1, events: 1 });
  assert.deepEqual(calls[0]!.types, ['user.message', 'assistant.message']);
  assert.equal(calls[0]!.agentScope, 'primary');
  assert.equal(calls[0]!.includeEphemeral, false);
  events.push(event('b'));
  const next = await readChatText(q({ source: 'live', direction: 'forward', cursor: first.liveCursor }), read);
  assert.deepEqual(next.messages.map(item => item.eventId), ['b']);
  events.push(event('c'));
  assert.deepEqual((await readChatText(q({ source: 'live', direction: 'forward', cursor: next.cursor }), read))
    .messages.map(item => item.eventId), ['c']);
});

for (const loaded of [false, true]) {
  test(`Engine text read is passive when loaded=${loaded}`, async t => {
    const h = harness(t);
    const s = await h.seed();
    if (loaded) await h.engine.reload(s.id);
    h.journals.set(s.id, [user('u', 'question'), assistant('a', 'm', 'answer')]);
    const resumes = h.runtime.resumeSession.mock.callCount();
    const page = await h.engine.chatText(q({ sessionId: s.id }));
    assert.deepEqual(page.messages.map(item => item.content), ['answer', 'question']);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  });
}
